-- Funding logic. Everything that moves money-state runs inside one Postgres transaction
-- so two simultaneous pledges can never both think they finished an item.
--
-- Every pledge goes to one item. There is no shared pool.
--
-- Lock order, always: business row first, then item row. Never the reverse.
-- Functions here only change database state and return what the server should charge.
-- They never talk to Stripe and never write ledger income (that comes from verified
-- webhooks). close_it_out is the one exception: it records owner_capital, an owner action.
--
-- Public functions are callable by service_role only (server code).

grant usage on schema private to service_role;

-- ------------------------------------------------------------------ helpers
create function private.lock_business(p_business uuid) returns void
language plpgsql as $$
begin
  perform 1 from public.businesses where id = p_business for no key update;
  if not found then
    raise exception 'business not found' using errcode = 'no_data_found';
  end if;
end;
$$;

-- True while any live pledge still needs this saved payment method.
create function private.pm_in_use(p_pm text) returns boolean
language sql stable as $$
  select p_pm is not null and exists (
    select 1 from public.pledges
    where stripe_payment_method_id = p_pm
      and status in ('pending', 'charging', 'requires_action')
  );
$$;

-- How much of an item's goal is already spoken for: pledges (pending at full amount, others
-- at what is being charged) plus owner capital recorded in the ledger, net of reversals.
create function private.item_covered_cents(p_item uuid) returns integer
language sql stable as $$
  select (
    coalesce((
      select sum(case when status = 'pending' then amount_cents
                      else coalesce(charge_cents, amount_cents) end)
      from public.pledges
      where item_id = p_item and status in ('pending', 'charging', 'requires_action', 'charged')), 0)
    + coalesce((
      select sum(e.amount_cents) from public.ledger_entries e
      where e.item_id = p_item
        and (e.kind = 'owner_capital'
             or (e.kind = 'reversal' and exists (
                   select 1 from public.ledger_entries o
                   where o.id = e.reverses_entry_id and o.kind = 'owner_capital')))), 0)
  )::integer;
$$;

create function private.charge_json(r public.pledges) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'pledge_id', r.id,
    'business_id', r.business_id,
    'item_id', r.item_id,
    'charge_cents', r.charge_cents,
    'stripe_customer_id', r.stripe_customer_id,
    'stripe_payment_method_id', r.stripe_payment_method_id
  );
$$;

-- --------------------------------------------------------------- fund_item
-- If the item's pending pledges reach its goal, mark it funded and plan the charges.
-- Oldest first. The pledge that crosses the goal is charged only what is needed; the rest of
-- that pledge is simply not charged. A pledge that arrives after the goal is already covered
-- is cancelled and charged nothing. Caller must already hold the business lock.
create function private.fund_item(p_item uuid) returns jsonb
language plpgsql as $$
declare
  it public.items;
  pend integer;
  allocated integer := 0;
  chg integer;
  r public.pledges;
  out jsonb := '[]'::jsonb;
begin
  select * into it from public.items where id = p_item for no key update;
  if not found or it.status <> 'open' then return out; end if;

  select coalesce(sum(amount_cents), 0) into pend
  from public.pledges where item_id = p_item and status = 'pending';
  if pend < it.goal_cents then return out; end if;

  update public.items set status = 'funded' where id = p_item;

  for r in
    select * from public.pledges
    where item_id = p_item and status = 'pending'
    order by created_at, id
  loop
    chg := least(r.amount_cents, greatest(it.goal_cents - allocated, 0));
    allocated := allocated + chg;

    if chg > 0 then
      update public.pledges
        set charge_cents = chg, status = 'charging', next_attempt_at = now() + interval '15 minutes'
        where id = r.id returning * into r;
      out := out || private.charge_json(r);
    else
      -- The item filled before this pledge counted. Nothing is charged for it.
      update public.pledges set charge_cents = 0, status = 'cancelled' where id = r.id;
    end if;
  end loop;

  return out;
end;
$$;

-- ------------------------------------------------------------ create_pledge
-- Called once the contributor's payment method is saved (SetupIntent confirmed).
-- Returns {pledge_id, outcome, charges[]}.
--   outcome: 'pending'      pledge recorded, item still open
--            'funded'       this pledge finished the item
--            'item_closed'  the item is no longer open; no pledge was recorded
--            'duplicate'    this setup intent was already recorded (replay)
create function public.create_pledge(
  p_business_id uuid, p_item_id uuid, p_name text, p_email text, p_amount_cents integer,
  p_manage_token_hash bytea, p_consent_version text, p_consented_at timestamptz,
  p_customer_id text, p_payment_method_id text, p_setup_intent_id text
) returns jsonb
language plpgsql as $$
declare
  it public.items;
  new_id uuid;
  charges jsonb := '[]'::jsonb;
begin
  perform private.lock_business(p_business_id);

  if p_setup_intent_id is not null and exists (
    select 1 from public.pledges where setup_intent_id = p_setup_intent_id
  ) then
    return jsonb_build_object('pledge_id', null, 'outcome', 'duplicate', 'charges', charges);
  end if;

  select * into it from public.items where id = p_item_id for no key update;
  if not found or it.business_id <> p_business_id then
    raise exception 'item does not belong to this business' using errcode = 'foreign_key_violation';
  end if;
  if it.status <> 'open' or it.deadline <= now() then
    return jsonb_build_object('pledge_id', null, 'outcome', 'item_closed', 'charges', charges);
  end if;

  insert into public.pledges
    (business_id, item_id, contributor_name, contributor_email, stripe_customer_id,
     stripe_payment_method_id, setup_intent_id, amount_cents,
     manage_token_hash, consent_text_version, consented_at)
  values
    (p_business_id, p_item_id, p_name, p_email, p_customer_id, p_payment_method_id,
     p_setup_intent_id, p_amount_cents, p_manage_token_hash, p_consent_version, p_consented_at)
  returning id into new_id;

  update public.items set goal_locked_at = coalesce(goal_locked_at, now()) where id = p_item_id;
  charges := private.fund_item(p_item_id);

  return jsonb_build_object(
    'pledge_id', new_id,
    'outcome', case when jsonb_array_length(charges) > 0 then 'funded' else 'pending' end,
    'charges', charges);
end;
$$;

-- ----------------------------------------------------------- cancel_pledge
-- The token hash identifies one contributor's pledge. It can be cancelled only while pending;
-- nothing can change once a pledge is charged, cancelled or expired.
create function public.cancel_pledge(p_manage_token_hash bytea) returns jsonb
language plpgsql as $$
declare
  biz uuid;
  out jsonb;
begin
  select business_id into biz from public.pledges
  where manage_token_hash = p_manage_token_hash and status = 'pending';
  if biz is null then
    return jsonb_build_object('outcome', 'not_allowed', 'pledges', '[]'::jsonb);
  end if;
  perform private.lock_business(biz);

  with u as (
    update public.pledges set status = 'cancelled'
    where manage_token_hash = p_manage_token_hash and status = 'pending'
    returning id, stripe_payment_method_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('pledge_id', id, 'stripe_payment_method_id', stripe_payment_method_id)), '[]')
  into out from u;

  if jsonb_array_length(out) = 0 then
    return jsonb_build_object('outcome', 'not_allowed', 'pledges', out);
  end if;
  select jsonb_agg(e || jsonb_build_object('can_detach', not private.pm_in_use(e ->> 'stripe_payment_method_id')))
  into out from jsonb_array_elements(out) e;
  return jsonb_build_object('outcome', 'cancelled', 'pledges', out);
end;
$$;

-- ----------------------------------------------------------------- expire_due
-- Unfunded items past their deadline expire, along with their pledges. Nobody is charged.
-- Returns the expired pledges and whether their saved payment method can now be detached.
-- p_business_id limits the sweep to one business (the scheduled job passes null).
create function public.expire_due(
  p_now timestamptz default now(), p_business_id uuid default null
) returns jsonb
language plpgsql as $$
declare
  b uuid;
  batch jsonb;
  out jsonb := '[]'::jsonb;
begin
  for b in
    select distinct business_id from public.items
    where status = 'open' and deadline <= p_now
      and (p_business_id is null or business_id = p_business_id)
    order by 1
  loop
    perform private.lock_business(b);

    update public.items set status = 'expired'
    where business_id = b and status = 'open' and deadline <= p_now;

    with u as (
      update public.pledges p set status = 'expired'
      where p.business_id = b and p.status = 'pending'
        and exists (select 1 from public.items i where i.id = p.item_id and i.status = 'expired')
      returning p.id, p.stripe_payment_method_id
    )
    select coalesce(jsonb_agg(jsonb_build_object('pledge_id', id, 'stripe_payment_method_id', stripe_payment_method_id)), '[]')
    into batch from u;

    select coalesce(jsonb_agg(e || jsonb_build_object('can_detach', not private.pm_in_use(e ->> 'stripe_payment_method_id'))), '[]')
    into batch from jsonb_array_elements(batch) e;
    out := out || batch;
  end loop;
  return out;
end;
$$;

-- --------------------------------------------------------------- close_it_out
-- The owner covers the remainder with their own money. Records an owner_capital ledger
-- entry for exactly that amount, marks the item funded, and plans full charges for the
-- pending pledges. No payment flow for the owner's part in Phase 1.
create function public.close_it_out(p_item_id uuid, p_actor_user_id uuid) returns jsonb
language plpgsql as $$
declare
  it public.items;
  biz uuid;
  covered integer;
  remainder integer;
  r public.pledges;
  charges jsonb := '[]'::jsonb;
begin
  select business_id into biz from public.items where id = p_item_id;
  if biz is null then raise exception 'item not found' using errcode = 'no_data_found'; end if;
  perform private.lock_business(biz);

  if not exists (select 1 from public.businesses where id = biz and owner_user_id = p_actor_user_id) then
    raise exception 'only the business owner can close out an item' using errcode = 'insufficient_privilege';
  end if;

  select * into it from public.items where id = p_item_id for no key update;
  if it.status not in ('open', 'funded') then
    raise exception 'item is % and cannot be closed out', it.status using errcode = 'check_violation';
  end if;

  covered := private.item_covered_cents(p_item_id);

  remainder := it.goal_cents - covered;
  if remainder <= 0 then
    raise exception 'nothing left to cover' using errcode = 'check_violation';
  end if;

  insert into public.ledger_entries
    (business_id, item_id, kind, amount_cents, tax_year, occurred_at, memo, source_event_id)
  values
    (biz, p_item_id, 'owner_capital', remainder,
     extract(year from now() at time zone 'America/Chicago')::smallint, now(),
     'Owner covered the remainder (close it out)', 'owner_action:' || gen_random_uuid()::text);

  insert into public.owner_actions (business_id, actor_user_id, action, target_type, target_id, details)
  values (biz, p_actor_user_id, 'close_it_out', 'item', p_item_id,
          jsonb_build_object('owner_capital_cents', remainder, 'covered_by_pledges_cents', covered));

  update public.items
    set status = 'funded', goal_locked_at = coalesce(goal_locked_at, now())
    where id = p_item_id;

  for r in
    select * from public.pledges where item_id = p_item_id and status = 'pending' order by created_at, id
  loop
    update public.pledges
      set charge_cents = amount_cents, status = 'charging', next_attempt_at = now() + interval '15 minutes'
      where id = r.id returning * into r;
    charges := charges || private.charge_json(r);
  end loop;

  return jsonb_build_object('owner_capital_cents', remainder, 'charges', charges);
end;
$$;

-- -------------------------------------------------------------- permissions
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on all functions in schema private to service_role;
-- RLS policies call this as the signed-in user; the blanket revoke above must not remove it.
grant execute on function private.owns_business(uuid) to authenticated;

do $$
declare f text;
begin
  for f in select unnest(array[
    'create_pledge(uuid,uuid,text,text,integer,bytea,text,timestamptz,text,text,text)',
    'cancel_pledge(bytea)', 'expire_due(timestamptz,uuid)', 'close_it_out(uuid,uuid)'
  ]) loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
