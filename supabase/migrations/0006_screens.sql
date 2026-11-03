-- Functions behind the screens. All service_role only: server code calls them after it has
-- worked out who the visitor is (a verified owner session, or nobody for public pages).
-- Owner functions take the signed-in user's id and check ownership in SQL, so a mistake in the
-- web layer cannot reach another business's data. (Row-level security still protects direct
-- browser access to the tables.)

-- ----------------------------------------------------------------- sign-in
-- Only emails the platform has registered as an owner may receive a sign-in link.
create function public.owner_signin_allowed(p_email text) returns boolean
language sql stable as $$
  select exists (select 1 from public.businesses where lower(owner_email) = lower(p_email));
$$;

-- First sign-in: attach the verified user to the business registered for their email.
-- Returns the business id, or null if there is none (or it already belongs to someone else).
create function public.claim_business(p_user_id uuid, p_email text) returns uuid
language plpgsql as $$
declare bid uuid;
begin
  update public.businesses set owner_user_id = p_user_id
  where lower(owner_email) = lower(p_email)
    and (owner_user_id is null or owner_user_id = p_user_id)
  returning id into bid;
  if bid is not null then
    insert into public.owner_actions (business_id, actor_user_id, action)
    values (bid, p_user_id, 'sign_in');
  end if;
  return bid;
end;
$$;

-- ------------------------------------------------------------ owner screens
create function private.owner_business(p_user_id uuid) returns uuid
language sql stable as $$
  select id from public.businesses where owner_user_id = p_user_id order by created_at limit 1;
$$;

create function public.owner_dashboard(p_user_id uuid) returns jsonb
language plpgsql stable as $$
declare
  bid uuid := private.owner_business(p_user_id);
  b public.businesses;
begin
  if bid is null then return null; end if;
  select * into b from public.businesses where id = bid;

  return jsonb_build_object(
    'business', jsonb_build_object(
      'id', b.id, 'slug', b.slug, 'name', b.name, 'legal_name', b.legal_name,
      'owner_display', b.owner_display, 'owner_line', b.owner_line, 'tagline', b.tagline,
      'story', b.story, 'neighborhood', b.neighborhood, 'city', b.city,
      'status_line', b.status_line, 'contact_email', b.contact_email,
      'logo_url', b.logo_url, 'cover_url', b.cover_url, 'accent_color', b.accent_color,
      'stripe_connected', b.stripe_account_id is not null,
      'stripe_ready', b.stripe_onboarded_at is not null),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'name', i.name, 'short_name', i.short_name, 'note', i.note, 'status', i.status,
        'price_cents', i.price_cents, 'shipping_cents', i.shipping_cents, 'tax_cents', i.tax_cents,
        'install_cents', i.install_cents, 'goal_cents', i.goal_cents, 'deadline', i.deadline,
        'goal_locked', i.goal_locked_at is not null,
        'covered_cents', private.item_covered_cents(i.id),
        'remaining_cents', greatest(i.goal_cents - private.item_covered_cents(i.id), 0),
        'pledge_count', (select count(*) from public.pledges p
                         where p.item_id = i.id and p.status in ('pending','charging','requires_action','charged')),
        'failed_count', (select count(*) from public.pledges p where p.item_id = i.id and p.status = 'failed'),
        'pledges', coalesce((
          select jsonb_agg(jsonb_build_object(
            'name', p.contributor_name, 'amount_cents', p.amount_cents,
            'charge_cents', p.charge_cents, 'status', p.status, 'created_at', p.created_at)
            order by p.created_at)
          from public.pledges p where p.item_id = i.id), '[]'::jsonb)
      ) order by i.position, i.created_at)
      from public.items i where i.business_id = bid), '[]'::jsonb),
    'ledger', coalesce((
      select jsonb_agg(row_to_json(t) order by t.item_name) from (
        select i.id as item_id, i.name as item_name, i.status,
               coalesce(sum(e.amount_cents) filter (where e.kind = 'contribution_income'), 0) as contribution_cents,
               coalesce(sum(e.amount_cents) filter (where e.kind = 'owner_capital'), 0) as owner_capital_cents,
               coalesce(sum(e.amount_cents) filter (where e.kind in ('platform_fee','processor_fee')), 0) as fees_cents,
               coalesce(sum(e.amount_cents) filter (where e.kind in ('refund')), 0) as refunds_cents
        from public.items i
        left join public.ledger_entries e on e.item_id = i.id
        where i.business_id = bid and i.status in ('funded','purchased','in_use')
        group by i.id, i.name, i.status) t), '[]'::jsonb)
  );
end;
$$;

-- Edit the display fields on the about card. Only these keys are accepted; anything else is
-- ignored. Table constraints still validate lengths and the colour format.
create function public.owner_update_business(p_user_id uuid, p_changes jsonb) returns void
language plpgsql as $$
declare bid uuid := private.owner_business(p_user_id);
begin
  if bid is null then raise exception 'not an owner' using errcode = 'insufficient_privilege'; end if;
  update public.businesses set
    name          = case when p_changes ? 'name'          then p_changes ->> 'name'          else name end,
    legal_name    = case when p_changes ? 'legal_name'    then p_changes ->> 'legal_name'    else legal_name end,
    owner_display = case when p_changes ? 'owner_display' then p_changes ->> 'owner_display' else owner_display end,
    owner_line    = case when p_changes ? 'owner_line'    then nullif(p_changes ->> 'owner_line', '')    else owner_line end,
    tagline       = case when p_changes ? 'tagline'       then nullif(p_changes ->> 'tagline', '')       else tagline end,
    story         = case when p_changes ? 'story'         then nullif(p_changes ->> 'story', '')         else story end,
    neighborhood  = case when p_changes ? 'neighborhood'  then nullif(p_changes ->> 'neighborhood', '')  else neighborhood end,
    city          = case when p_changes ? 'city'          then p_changes ->> 'city'          else city end,
    status_line   = case when p_changes ? 'status_line'   then nullif(p_changes ->> 'status_line', '')   else status_line end,
    contact_email = case when p_changes ? 'contact_email' then p_changes ->> 'contact_email' else contact_email end,
    accent_color  = case when p_changes ? 'accent_color'  then p_changes ->> 'accent_color'  else accent_color end
  where id = bid;
  insert into public.owner_actions (business_id, actor_user_id, action, target_type, target_id, details)
  values (bid, p_user_id, 'profile_update', 'business', bid,
          jsonb_build_object('fields', (select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(p_changes) k)));
end;
$$;

-- Create (p_item_id null) or edit an item. New items start as drafts. Once the first pledge
-- arrives the goal is locked by trigger, so price edits then fail.
create function public.owner_save_item(
  p_user_id uuid, p_item_id uuid, p_name text, p_short_name text, p_note text,
  p_price_cents integer, p_shipping_cents integer, p_tax_cents integer, p_install_cents integer,
  p_deadline timestamptz, p_source_url text default null, p_source_domain text default null
) returns uuid
language plpgsql as $$
declare
  bid uuid := private.owner_business(p_user_id);
  iid uuid := p_item_id;
begin
  if bid is null then raise exception 'not an owner' using errcode = 'insufficient_privilege'; end if;
  if iid is null then
    insert into public.items (business_id, name, short_name, note, price_cents, shipping_cents,
                              tax_cents, install_cents, deadline, source_url, source_domain, position)
    values (bid, p_name, nullif(p_short_name, ''), nullif(p_note, ''), p_price_cents, p_shipping_cents,
            p_tax_cents, p_install_cents, p_deadline, nullif(p_source_url, ''), nullif(p_source_domain, ''),
            coalesce((select max(position) + 1 from public.items where business_id = bid), 0))
    returning id into iid;
  else
    update public.items set name = p_name, short_name = nullif(p_short_name, ''), note = nullif(p_note, ''),
      price_cents = p_price_cents, shipping_cents = p_shipping_cents, tax_cents = p_tax_cents,
      install_cents = p_install_cents, deadline = p_deadline,
      source_url = nullif(p_source_url, ''), source_domain = nullif(p_source_domain, '')
    where id = iid and business_id = bid;
    if not found then raise exception 'item not found' using errcode = 'no_data_found'; end if;
  end if;
  insert into public.owner_actions (business_id, actor_user_id, action, target_type, target_id)
  values (bid, p_user_id, case when p_item_id is null then 'item_create' else 'item_update' end, 'item', iid);
  return iid;
end;
$$;

-- Draft to open. Needs a finished Stripe connection and a future deadline.
create function public.owner_publish_item(p_user_id uuid, p_item_id uuid) returns void
language plpgsql as $$
declare
  bid uuid := private.owner_business(p_user_id);
  it public.items;
begin
  if bid is null then raise exception 'not an owner' using errcode = 'insufficient_privilege'; end if;
  select * into it from public.items where id = p_item_id and business_id = bid for update;
  if not found then raise exception 'item not found' using errcode = 'no_data_found'; end if;
  if it.status <> 'draft' then raise exception 'only drafts can be opened' using errcode = 'check_violation'; end if;
  if it.deadline is null or it.deadline <= now() then
    raise exception 'set a deadline in the future first' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.businesses where id = bid and stripe_onboarded_at is not null) then
    raise exception 'finish connecting Stripe before opening an item' using errcode = 'check_violation';
  end if;
  update public.items set status = 'open' where id = p_item_id;
  insert into public.owner_actions (business_id, actor_user_id, action, target_type, target_id)
  values (bid, p_user_id, 'item_open', 'item', p_item_id);
end;
$$;

-- ------------------------------------------------------------ public screens
create function public.public_business_page(p_slug text) returns jsonb
language plpgsql stable as $$
declare b public.public_businesses;
begin
  select * into b from public.public_businesses where slug = p_slug;
  if not found then return null; end if;
  return jsonb_build_object(
    'business', to_jsonb(b),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'name', i.name, 'short_name', i.short_name, 'note', i.note, 'status', i.status,
        'goal_cents', i.goal_cents, 'raised_cents', i.raised_cents, 'deadline', i.deadline,
        'source_domain', i.source_domain) order by i."position")
      from public.public_items i where i.business_id = b.id), '[]'::jsonb),
    'summary', (
      select jsonb_build_object(
        'raised_cents', coalesce(sum(i.raised_cents), 0),
        'goal_cents', coalesce(sum(i.goal_cents), 0),
        'funded_items', count(*) filter (where i.status in ('funded','purchased','in_use')),
        'total_items', count(*),
        'pledges', (select count(*) from public.pledges p
                    where p.business_id = b.id and p.status in ('pending','charging','requires_action','charged')))
      from public.public_items i where i.business_id = b.id and i.status <> 'expired')
  );
end;
$$;

create function public.public_item_page(p_slug text, p_item_id uuid) returns jsonb
language plpgsql stable as $$
declare
  b public.public_businesses;
  i public.public_items;
begin
  select * into b from public.public_businesses where slug = p_slug;
  if not found then return null; end if;
  select * into i from public.public_items where id = p_item_id and business_id = b.id;
  if not found then return null; end if;
  return jsonb_build_object(
    'business', to_jsonb(b),
    'item', to_jsonb(i) || jsonb_build_object('remaining_cents', greatest(i.goal_cents - i.raised_cents, 0)));
end;
$$;

-- What a contributor sees on their manage page. Shows only that one pledge.
create function public.manage_view(p_manage_token_hash bytea) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'status', p.status, 'amount_cents', p.amount_cents, 'charge_cents', p.charge_cents,
    'created_at', p.created_at, 'charged_at', p.charged_at,
    'item_name', i.name, 'item_status', i.status, 'deadline', i.deadline,
    'business_name', b.name, 'business_legal_name', b.legal_name,
    'business_slug', b.slug, 'contact_email', b.contact_email, 'accent_color', b.accent_color)
  from public.pledges p
  join public.items i on i.id = p.item_id
  join public.businesses b on b.id = p.business_id
  where p.manage_token_hash = p_manage_token_hash;
$$;

-- -------------------------------------------------------------- permissions
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on all functions in schema private to service_role;
grant execute on function private.owns_business(uuid) to authenticated;

do $$
declare f text;
begin
  for f in select unnest(array[
    'owner_signin_allowed(text)', 'claim_business(uuid,text)', 'owner_dashboard(uuid)',
    'owner_update_business(uuid,jsonb)',
    'owner_save_item(uuid,uuid,text,text,text,integer,integer,integer,integer,timestamptz,text,text)',
    'owner_publish_item(uuid,uuid)', 'public_business_page(text)', 'public_item_page(text,uuid)',
    'manage_view(bytea)'
  ]) loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
