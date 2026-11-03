-- Payment layer database support. All functions are service_role only.
-- Ledger rows are written ONLY here, from verified Stripe webhook events (the server
-- verifies the signature before calling) or owner actions. Each webhook handler runs in one
-- transaction with the processed_events insert, so a replayed event changes nothing and a
-- failed handler leaves the event unprocessed so Stripe retries it.

-- ------------------------------------------------------------------- columns
alter table public.businesses add column stripe_onboarded_at timestamptz;

-- A business takes pledges only after Stripe says card payments are active.
create or replace view public.public_businesses as
  select id, slug, name, legal_name, owner_display, owner_line, owner_photo_url, tagline,
         story, neighborhood, city, status_line, contact_email, logo_url, cover_url,
         accent_color, (stripe_onboarded_at is not null) as accepting_pledges
  from public.businesses;

-- ------------------------------------------------------------- rate limiting
-- Fixed-window counters. Keys are hashed by the server (never raw IPs or emails).
create table public.rate_limits (
  key          text primary key,
  window_start timestamptz not null,
  count        integer not null
);
alter table public.rate_limits enable row level security;

-- Returns true if this hit is allowed.
create function public.hit_rate_limit(p_key text, p_max integer, p_window interval) returns boolean
language plpgsql as $$
declare c integer;
begin
  insert into public.rate_limits as r (key, window_start, count)
  values (p_key, now(), 1)
  on conflict (key) do update set
    count = case when r.window_start <= now() - p_window then 1 else r.count + 1 end,
    window_start = case when r.window_start <= now() - p_window then now() else r.window_start end
  returning r.count into c;
  return c <= p_max;
end;
$$;

-- Housekeeping for the scheduled job.
create function public.purge_rate_limits(p_older_than interval default interval '2 days') returns integer
language plpgsql as $$
declare n integer;
begin
  delete from public.rate_limits where window_start < now() - p_older_than;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------- lookups for the server
-- The Stripe connected-account id always comes from here, never from a request.
create function public.payment_context(p_business_id uuid, p_item_id uuid) returns jsonb
language plpgsql stable as $$
declare
  b public.businesses;
  it public.items;
  item_json jsonb := null;
begin
  select * into b from public.businesses where id = p_business_id;
  if not found then raise exception 'business not found' using errcode = 'no_data_found'; end if;

  if p_item_id is not null then
    select * into it from public.items where id = p_item_id;
    if not found or it.business_id <> p_business_id then
      raise exception 'item does not belong to this business' using errcode = 'foreign_key_violation';
    end if;
    item_json := jsonb_build_object(
      'id', it.id, 'name', it.name, 'status', it.status, 'deadline', it.deadline,
      'goal_cents', it.goal_cents,
      'remaining_cents', greatest(it.goal_cents - private.item_covered_cents(it.id), 0));
  end if;

  return jsonb_build_object(
    'business', jsonb_build_object(
      'id', b.id, 'name', b.name, 'legal_name', b.legal_name, 'slug', b.slug,
      'contact_email', b.contact_email,
      'stripe_account_id', b.stripe_account_id,
      'ready', b.stripe_account_id is not null and b.stripe_onboarded_at is not null),
    'item', item_json);
end;
$$;

create function public.charge_context(p_pledge_id uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'pledge_id', p.id, 'business_id', p.business_id, 'item_id', p.item_id,
    'status', p.status, 'charge_cents', p.charge_cents, 'amount_cents', p.amount_cents,
    'attempt', p.charge_attempts + 1,
    'stripe_customer_id', p.stripe_customer_id,
    'stripe_payment_method_id', p.stripe_payment_method_id,
    'payment_intent_id', p.payment_intent_id,
    'contributor_name', p.contributor_name, 'contributor_email', p.contributor_email,
    'stripe_account_id', b.stripe_account_id, 'business_name', b.name,
    'business_legal_name', b.legal_name, 'item_name', i.name)
  from public.pledges p
  join public.businesses b on b.id = p.business_id
  left join public.items i on i.id = p.item_id
  where p.id = p_pledge_id;
$$;

create function public.set_stripe_account(p_business_id uuid, p_account_id text) returns void
language plpgsql as $$
declare cur text;
begin
  select stripe_account_id into cur from public.businesses where id = p_business_id for no key update;
  if not found then raise exception 'business not found' using errcode = 'no_data_found'; end if;
  if cur is not null and cur <> p_account_id then
    raise exception 'business already has a different Stripe account' using errcode = 'check_violation';
  end if;
  update public.businesses set stripe_account_id = p_account_id where id = p_business_id;
end;
$$;

-- Returns the business id, or null if no business has this account.
create function public.set_onboarding_status(p_account_id text, p_ready boolean) returns uuid
language plpgsql as $$
declare bid uuid;
begin
  update public.businesses
  set stripe_onboarded_at = case when p_ready then coalesce(stripe_onboarded_at, now()) else null end
  where stripe_account_id = p_account_id
  returning id into bid;
  return bid;
end;
$$;

-- ------------------------------------------------------------ webhook handlers
create function private.tax_year(p_at timestamptz) returns smallint
language sql immutable as $$
  select extract(year from p_at at time zone 'America/Chicago')::smallint;
$$;

-- Marks a pledge's event as processed. Returns false if it was already processed.
create function private.claim_event(p_event_id text, p_type text) returns boolean
language plpgsql as $$
begin
  insert into public.processed_events (event_id, event_type) values (p_event_id, p_type)
  on conflict (event_id) do nothing;
  return found;
end;
$$;

-- payment_intent.succeeded for a direct charge on a connected account.
create function public.record_charge_succeeded(
  p_event_id text, p_account_id text, p_pledge_id uuid, p_payment_intent_id text,
  p_amount_cents integer, p_application_fee_cents integer, p_processor_fee_cents integer,
  p_occurred_at timestamptz
) returns jsonb
language plpgsql as $$
declare
  p public.pledges;
  acct text;
begin
  select * into p from public.pledges where id = p_pledge_id for update;
  if not found then raise exception 'pledge not found' using errcode = 'no_data_found'; end if;
  select stripe_account_id into acct from public.businesses where id = p.business_id;
  if acct is distinct from p_account_id then
    raise exception 'event account does not match the pledge''s business' using errcode = 'check_violation';
  end if;
  if p.charge_cents is distinct from p_amount_cents then
    raise exception 'amount received (%) does not match the planned charge (%)', p_amount_cents, p.charge_cents
      using errcode = 'check_violation';
  end if;
  if p.status not in ('charging', 'requires_action', 'failed', 'charged') then
    raise exception 'pledge is % and cannot be charged', p.status using errcode = 'check_violation';
  end if;

  if not private.claim_event(p_event_id, 'payment_intent.succeeded') then
    return jsonb_build_object('outcome', 'duplicate');
  end if;
  if p.status = 'charged' then
    return jsonb_build_object('outcome', 'already_charged');
  end if;

  update public.pledges
  set status = 'charged', charged_at = p_occurred_at, payment_intent_id = p_payment_intent_id,
      next_attempt_at = null, action_token_hash = null
  where id = p.id;

  insert into public.ledger_entries
    (business_id, item_id, pledge_id, kind, amount_cents, tax_year, occurred_at, memo, source_event_id)
  values (p.business_id, p.item_id, p.id, 'contribution_income', p_amount_cents,
          private.tax_year(p_occurred_at), p_occurred_at, 'Pledge charged', p_event_id || ':income');
  if p_application_fee_cents > 0 then
    insert into public.ledger_entries
      (business_id, item_id, pledge_id, kind, amount_cents, tax_year, occurred_at, memo, source_event_id)
    values (p.business_id, p.item_id, p.id, 'platform_fee', -p_application_fee_cents,
            private.tax_year(p_occurred_at), p_occurred_at, 'Platform fee', p_event_id || ':platform_fee');
  end if;
  if p_processor_fee_cents > 0 then
    insert into public.ledger_entries
      (business_id, item_id, pledge_id, kind, amount_cents, tax_year, occurred_at, memo, source_event_id)
    values (p.business_id, p.item_id, p.id, 'processor_fee', -p_processor_fee_cents,
            private.tax_year(p_occurred_at), p_occurred_at, 'Card processing fee', p_event_id || ':processor_fee');
  end if;

  return jsonb_build_object(
    'outcome', 'recorded', 'pledge_id', p.id, 'item_id', p.item_id,
    'stripe_payment_method_id', p.stripe_payment_method_id,
    'stripe_customer_id', p.stripe_customer_id,
    'can_detach', not private.pm_in_use(p.stripe_payment_method_id));
end;
$$;

-- A charge attempt failed. Retries after 1 day, then 3 days after the second failure, then
-- the pledge is marked failed. A payment needing customer authentication is parked as
-- requires_action with an emailed link instead. p_event_id may be a synthetic id
-- ('charge_attempt:<pledge>:<n>') when the failure was seen in the API response.
create function public.record_charge_failed(
  p_event_id text, p_account_id text, p_pledge_id uuid, p_error_code text,
  p_requires_action boolean, p_payment_intent_id text default null,
  p_action_token_hash bytea default null, p_now timestamptz default now()
) returns jsonb
language plpgsql as $$
declare
  p public.pledges;
  acct text;
  attempts smallint;
  next_at timestamptz;
  new_status public.pledge_status;
  it public.items;
  shortfall integer := null;
begin
  select * into p from public.pledges where id = p_pledge_id for update;
  if not found then raise exception 'pledge not found' using errcode = 'no_data_found'; end if;
  select stripe_account_id into acct from public.businesses where id = p.business_id;
  if acct is distinct from p_account_id then
    raise exception 'event account does not match the pledge''s business' using errcode = 'check_violation';
  end if;

  if not private.claim_event(p_event_id, 'charge_failed') then
    return jsonb_build_object('outcome', 'duplicate');
  end if;
  if p.status not in ('charging', 'requires_action') then
    return jsonb_build_object('outcome', 'ignored', 'status', p.status);
  end if;

  if p_requires_action then
    update public.pledges
    set status = 'requires_action', last_error_code = p_error_code,
        payment_intent_id = coalesce(p_payment_intent_id, payment_intent_id),
        action_token_hash = p_action_token_hash, next_attempt_at = null
    where id = p.id;
    return jsonb_build_object('outcome', 'requires_action', 'pledge_id', p.id);
  end if;

  attempts := p.charge_attempts + 1;
  if attempts = 1 then
    next_at := p_now + interval '1 day'; new_status := 'charging';
  elsif attempts = 2 then
    next_at := p_now + interval '3 days'; new_status := 'charging';
  else
    next_at := null; new_status := 'failed';
  end if;

  update public.pledges
  set charge_attempts = attempts, next_attempt_at = next_at, status = new_status,
      last_error_code = p_error_code
  where id = p.id;

  if new_status = 'failed' and p.item_id is not null then
    select * into it from public.items where id = p.item_id;
    shortfall := greatest(it.goal_cents - private.item_covered_cents(it.id), 0);
  end if;

  return jsonb_build_object(
    'outcome', case when new_status = 'failed' then 'failed' else 'retry_scheduled' end,
    'pledge_id', p.id, 'item_id', p.item_id, 'next_attempt_at', next_at,
    'item_shortfall_cents', shortfall,
    'stripe_payment_method_id', p.stripe_payment_method_id,
    'can_detach', not private.pm_in_use(p.stripe_payment_method_id));
end;
$$;

-- Pledges whose retry is due. Leases each for an hour so a crash between claim and charge
-- is retried rather than lost, and two workers never take the same pledge.
create function public.claim_due_retries(p_now timestamptz default now(), p_limit integer default 50) returns jsonb
language plpgsql as $$
declare
  out jsonb := '[]'::jsonb;
  r public.pledges;
begin
  for r in
    select * from public.pledges
    where status = 'charging' and next_attempt_at is not null and next_attempt_at <= p_now
    order by next_attempt_at limit p_limit for update skip locked
  loop
    update public.pledges set next_attempt_at = p_now + interval '1 hour' where id = r.id returning * into r;
    out := out || private.charge_json(r);
  end loop;
  return out;
end;
$$;

-- charge.refunded. Stripe reports the running total refunded, so the ledger gets the difference
-- from what is already recorded. A full refund that also refunds the platform fee reverses the fee entry.
create function public.record_refund(
  p_event_id text, p_account_id text, p_pledge_id uuid, p_total_refunded_cents integer,
  p_fee_refunded boolean, p_occurred_at timestamptz
) returns jsonb
language plpgsql as $$
declare
  p public.pledges;
  acct text;
  fee_entry public.ledger_entries;
  is_full boolean;
  already integer;
  delta integer;
begin
  select * into p from public.pledges where id = p_pledge_id for update;
  if not found then raise exception 'pledge not found' using errcode = 'no_data_found'; end if;
  select stripe_account_id into acct from public.businesses where id = p.business_id;
  if acct is distinct from p_account_id then
    raise exception 'event account does not match the pledge''s business' using errcode = 'check_violation';
  end if;
  if p.status <> 'charged' then
    raise exception 'pledge is % and has nothing to refund', p.status using errcode = 'check_violation';
  end if;

  if not private.claim_event(p_event_id, 'charge.refunded') then
    return jsonb_build_object('outcome', 'duplicate');
  end if;

  select coalesce(-sum(amount_cents), 0) into already
  from public.ledger_entries where pledge_id = p.id and kind = 'refund';
  delta := p_total_refunded_cents - already;
  if delta <= 0 then
    return jsonb_build_object('outcome', 'no_change');
  end if;

  insert into public.ledger_entries
    (business_id, item_id, pledge_id, kind, amount_cents, tax_year, occurred_at, memo, source_event_id)
  values (p.business_id, p.item_id, p.id, 'refund', -delta,
          private.tax_year(p_occurred_at), p_occurred_at, 'Refund issued by the business', p_event_id || ':refund');

  is_full := p_total_refunded_cents >= p.charge_cents;
  if is_full and p_fee_refunded then
    select * into fee_entry from public.ledger_entries
    where pledge_id = p.id and kind = 'platform_fee'
      and not exists (select 1 from public.ledger_entries r where r.reverses_entry_id = ledger_entries.id)
    order by created_at limit 1;
    if found then
      insert into public.ledger_entries
        (business_id, item_id, pledge_id, kind, amount_cents, tax_year, occurred_at, memo,
         source_event_id, reverses_entry_id)
      values (p.business_id, p.item_id, p.id, 'reversal', -fee_entry.amount_cents,
              private.tax_year(p_occurred_at), p_occurred_at, 'Platform fee refunded',
              p_event_id || ':fee_reversal', fee_entry.id);
    end if;
  end if;

  return jsonb_build_object('outcome', 'recorded', 'full_refund', is_full);
end;
$$;

-- Context for the "finish your payment" page: who, how much, which PaymentIntent.
create function public.action_context(p_action_token_hash bytea) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'pledge_id', p.id, 'charge_cents', p.charge_cents, 'payment_intent_id', p.payment_intent_id,
    'stripe_account_id', b.stripe_account_id, 'business_name', b.name, 'item_name', i.name)
  from public.pledges p
  join public.businesses b on b.id = p.business_id
  left join public.items i on i.id = p.item_id
  where p.action_token_hash = p_action_token_hash and p.status = 'requires_action';
$$;

-- -------------------------------------------------------------- permissions
do $$
declare f text;
begin
  for f in select unnest(array[
    'hit_rate_limit(text,integer,interval)', 'purge_rate_limits(interval)',
    'payment_context(uuid,uuid)', 'charge_context(uuid)', 'set_stripe_account(uuid,text)',
    'set_onboarding_status(text,boolean)',
    'record_charge_succeeded(text,text,uuid,text,integer,integer,integer,timestamptz)',
    'record_charge_failed(text,text,uuid,text,boolean,text,bytea,timestamptz)',
    'claim_due_retries(timestamptz,integer)',
    'record_refund(text,text,uuid,integer,boolean,timestamptz)',
    'action_context(bytea)'
  ]) loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on all functions in schema private to service_role;
grant execute on function private.owns_business(uuid) to authenticated;
