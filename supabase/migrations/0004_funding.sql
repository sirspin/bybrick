-- Funding logic. Everything that moves money-state runs inside one Postgres transaction
-- so two simultaneous pledges can never both think they finished an item.
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

-- Copy of a pledge's leftover amount, parked in the pool. Keeps the original's age so
-- oldest-first fairness holds, and shares its saved payment method.
create function private.split_to_pool(r public.pledges, p_amount integer) returns void
language sql as $$
  insert into public.pledges
    (business_id, item_id, contributor_name, contributor_email, stripe_customer_id,
     stripe_payment_method_id, amount_cents, send_extra_to_pool, split_from_pledge_id,
     consent_text_version, consented_at, created_at)
  values
    (r.business_id, null, r.contributor_name, r.contributor_email, r.stripe_customer_id,
     r.stripe_payment_method_id, p_amount, true, r.id,
     r.consent_text_version, r.consented_at, r.created_at);
$$;

-- --------------------------------------------------------------- fund_item
-- If the item's pending pledges reach its goal, mark it funded and plan the charges.
-- Oldest first. The pledge that crosses the goal is charged only what is needed.
-- Leftover from a pledge with send_extra_to_pool becomes a new pending pool pledge;
-- otherwise it is simply not charged. Caller must already hold the business lock.
create function private.fund_item(p_item uuid) returns jsonb
language plpgsql as $$
declare
  it public.items;
  pend integer;
  allocated integer := 0;
  chg integer;
  exc integer;
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
    exc := r.amount_cents - chg;
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

    if exc > 0 and r.send_extra_to_pool then
      perform private.split_to_pool(r, exc);
    end if;
  end loop;

  return out;
end;
$$;

-- ----------------------------------------------------------- allocate_pool
-- When the pool covers the remaining balance of the open item closest to its goal,
-- move pool pledges (oldest first) onto it, which triggers funding. Repeats while the
-- pool can still finish something. Caller must already hold the business lock.
create function private.allocate_pool(p_business uuid) returns jsonb
language plpgsql as $$
declare
  out jsonb := '[]'::jsonb;
  pool_total integer;
  cand_id uuid;
  cand_remaining integer;
  moved integer;
  r record;
  guard integer := 0;
begin
  loop
    guard := guard + 1;
    exit when guard > 25;

    select coalesce(sum(amount_cents), 0) into pool_total
    from public.pledges where business_id = p_business and item_id is null and status = 'pending';
    exit when pool_total = 0;

    select c.id, c.remaining into cand_id, cand_remaining
    from (
      select it.id, it.deadline, it."position",
             it.goal_cents - coalesce((
               select sum(p.amount_cents) from public.pledges p
               where p.item_id = it.id and p.status = 'pending'), 0) as remaining
      from public.items it
      where it.business_id = p_business and it.status = 'open' and it.deadline > now()
    ) c
    where c.remaining > 0
    order by c.remaining, c.deadline, c."position", c.id
    limit 1;
    exit when cand_id is null;
    exit when pool_total < cand_remaining;

    perform 1 from public.items where id = cand_id for no key update;

    moved := 0;
    for r in
      select id, amount_cents from public.pledges
      where business_id = p_business and item_id is null and status = 'pending'
      order by created_at, id
    loop
      exit when moved >= cand_remaining;
      update public.pledges set item_id = cand_id where id = r.id;
      moved := moved + r.amount_cents;
    end loop;

    update public.items set goal_locked_at = coalesce(goal_locked_at, now()) where id = cand_id;
    out := out || private.fund_item(cand_id);
    cand_id := null;
  end loop;
  return out;
end;
$$;

-- ------------------------------------------------------------ create_pledge
-- Called once the contributor's payment method is saved (SetupIntent confirmed).
-- Returns {pledge_id, outcome, charges[]}.
--   outcome: 'pending'        pledge recorded, item still open
--            'funded'         this pledge (or a pool move it triggered) finished an item
--            'moved_to_pool'  item had closed and the contributor opted to send it to the pool
--            'item_closed'    item had closed and no pledge was recorded
--            'duplicate'      this setup intent was already recorded (replay)
create function public.create_pledge(
  p_business_id uuid, p_item_id uuid, p_name text, p_email text, p_amount_cents integer,
  p_send_extra boolean, p_manage_token_hash bytea, p_consent_version text,
  p_consented_at timestamptz, p_customer_id text, p_payment_method_id text, p_setup_intent_id text
) returns jsonb
language plpgsql as $$
declare
  it public.items;
  new_id uuid;
  target uuid := p_item_id;
  outcome text := 'pending';
  charges jsonb := '[]'::jsonb;
  extra boolean := p_send_extra;
begin
  perform private.lock_business(p_business_id);

  if p_setup_intent_id is not null and exists (
    select 1 from public.pledges where setup_intent_id = p_setup_intent_id
  ) then
    return jsonb_build_object('pledge_id', null, 'outcome', 'duplicate', 'charges', charges);
  end if;

  if p_item_id is not null then
    select * into it from public.items where id = p_item_id for no key update;
    if not found or it.business_id <> p_business_id then
      raise exception 'item does not belong to this business' using errcode = 'foreign_key_violation';
    end if;
    if it.status <> 'open' or it.deadline <= now() then
      if p_send_extra then
        target := null;
        outcome := 'moved_to_pool';
      else
        return jsonb_build_object('pledge_id', null, 'outcome', 'item_closed', 'charges', charges);
      end if;
    end if;
  end if;

  -- A pool pledge's leftover always returns to the pool.
  if target is null then extra := true; end if;

  insert into public.pledges
    (business_id, item_id, contributor_name, contributor_email, stripe_customer_id,
     stripe_payment_method_id, setup_intent_id, amount_cents, send_extra_to_pool,
     manage_token_hash, consent_text_version, consented_at)
  values
    (p_business_id, target, p_name, p_email, p_customer_id, p_payment_method_id,
     p_setup_intent_id, p_amount_cents, extra, p_manage_token_hash, p_consent_version,
     p_consented_at)
  returning id into new_id;

  if target is not null then
    update public.items set goal_locked_at = coalesce(goal_locked_at, now()) where id = target;
    charges := private.fund_item(target);
  end if;
  charges := charges || private.allocate_pool(p_business_id);

  if jsonb_array_length(charges) > 0 and outcome = 'pending' then outcome := 'funded'; end if;

  return jsonb_build_object('pledge_id', new_id, 'outcome', outcome, 'charges', charges);
end;
$$;

-- ------------------------------------------------------- manage-link actions
-- The token hash identifies one contributor's pledge. These act on that pledge, or on
-- its still-pending split-off pool pledges if the pledge itself is already resolved.
-- Nothing can change once a pledge is charged, cancelled or expired.
create function private.manageable(p_hash bytea) returns table (id uuid, business_id uuid)
language sql stable as $$
  select p.id, p.business_id
  from public.pledges p
  where p.status = 'pending'
    and (p.manage_token_hash = p_hash
         or p.split_from_pledge_id in (select q.id from public.pledges q where q.manage_token_hash = p_hash));
$$;

create function public.cancel_pledge(p_manage_token_hash bytea) returns jsonb
language plpgsql as $$
declare
  biz uuid;
  out jsonb;
begin
  select m.business_id into biz from private.manageable(p_manage_token_hash) m limit 1;
  if biz is null then
    return jsonb_build_object('outcome', 'not_allowed', 'pledges', '[]'::jsonb);
  end if;
  perform private.lock_business(biz);

  with u as (
    update public.pledges set status = 'cancelled'
    where status = 'pending' and id in (select m.id from private.manageable(p_manage_token_hash) m)
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

create function public.move_pledge_to_pool(p_manage_token_hash bytea) returns jsonb
language plpgsql as $$
declare
  biz uuid;
  moved integer;
  charges jsonb;
begin
  select m.business_id into biz
  from private.manageable(p_manage_token_hash) m
  join public.pledges p on p.id = m.id
  where p.item_id is not null limit 1;
  if biz is null then
    return jsonb_build_object('outcome', 'not_allowed', 'charges', '[]'::jsonb);
  end if;
  perform private.lock_business(biz);

  update public.pledges set item_id = null, send_extra_to_pool = true
  where status = 'pending' and item_id is not null
    and id in (select m.id from private.manageable(p_manage_token_hash) m);
  get diagnostics moved = row_count;
  if moved = 0 then
    return jsonb_build_object('outcome', 'not_allowed', 'charges', '[]'::jsonb);
  end if;

  charges := private.allocate_pool(biz);
  return jsonb_build_object('outcome', 'moved_to_pool', 'charges', charges);
end;
$$;

-- ------------------------------------------------------------- allocate (RPC)
-- Call after an owner opens a new item so existing pool money can go to work.
create function public.allocate_pool(p_business_id uuid) returns jsonb
language plpgsql as $$
begin
  perform private.lock_business(p_business_id);
  return jsonb_build_object('charges', private.allocate_pool(p_business_id));
end;
$$;

-- ----------------------------------------------------------------- expire_due
-- Unfunded items past their deadline expire, along with their pledges. Pool pledges
-- older than p_pool_ttl expire too. Nobody is charged. Returns the expired pledges and
-- whether their saved payment method can now be detached.
-- p_pool_ttl is an assumption (90 days) pending a product decision.
-- p_business_id limits the sweep to one business (the scheduled job passes null).
create function public.expire_due(
  p_now timestamptz default now(), p_pool_ttl interval default interval '90 days',
  p_business_id uuid default null
) returns jsonb
language plpgsql as $$
declare
  b uuid;
  batch jsonb;
  out jsonb := '[]'::jsonb;
begin
  for b in
    select distinct s.business_id from (
      select business_id from public.items where status = 'open' and deadline <= p_now
      union
      select business_id from public.pledges
        where item_id is null and status = 'pending' and created_at <= p_now - p_pool_ttl
    ) s
    where p_business_id is null or s.business_id = p_business_id
    order by 1
  loop
    perform private.lock_business(b);

    update public.items set status = 'expired'
    where business_id = b and status = 'open' and deadline <= p_now;

    with u as (
      update public.pledges p set status = 'expired'
      where p.business_id = b and p.status = 'pending'
        and ((p.item_id is not null and exists (
                select 1 from public.items i where i.id = p.item_id and i.status = 'expired'))
             or (p.item_id is null and p.created_at <= p_now - p_pool_ttl))
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
    'create_pledge(uuid,uuid,text,text,integer,boolean,bytea,text,timestamptz,text,text,text)',
    'cancel_pledge(bytea)', 'move_pledge_to_pool(bytea)', 'allocate_pool(uuid)',
    'expire_due(timestamptz,interval,uuid)', 'close_it_out(uuid,uuid)'
  ]) loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
