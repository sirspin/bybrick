-- Access control: deny by default.
-- Browser-facing roles (anon, authenticated) get nothing unless granted below.
-- Server code uses service_role (bypasses RLS) and never runs in the browser.

-- Future tables start closed too.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

-- RLS on every table.
alter table public.businesses       enable row level security;
alter table public.items            enable row level security;
alter table public.pledges          enable row level security;
alter table public.ledger_entries   enable row level security;
alter table public.assets           enable row level security;
alter table public.owner_actions    enable row level security;
alter table public.processed_events enable row level security;  -- no policies: server only

-- Defense in depth: even service_role cannot update/delete/truncate append-only tables.
revoke update, delete, truncate on public.ledger_entries from service_role;
revoke update, delete, truncate on public.owner_actions  from service_role;

-- Helper: does the signed-in user own this business?
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create function private.owns_business(b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.businesses
    where id = b and owner_user_id = (select auth.uid())
  );
$$;
revoke execute on function private.owns_business(uuid) from public, anon;
grant execute on function private.owns_business(uuid) to authenticated;

-- ---------------------------------------------------------------- businesses
-- Owners read their own row and edit display fields only. They cannot touch
-- stripe_account_id, owner_user_id or slug, and cannot create or delete businesses.
grant select on public.businesses to authenticated;
grant update (name, legal_name, owner_display, owner_line, owner_photo_url, tagline, story,
              neighborhood, city, status_line, contact_email, logo_url, cover_url, accent_color)
  on public.businesses to authenticated;

create policy businesses_owner_select on public.businesses
  for select to authenticated using (owner_user_id = (select auth.uid()));
create policy businesses_owner_update on public.businesses
  for update to authenticated
  using (owner_user_id = (select auth.uid()))
  with check (owner_user_id = (select auth.uid()));

-- --------------------------------------------------------------------- items
-- Owners manage their own items' descriptive and price fields. Status, goal_cents
-- and goal_locked_at are server-controlled. Only drafts can be deleted.
grant select on public.items to authenticated;
grant insert (business_id, name, short_name, note, photo_url, source_url, source_domain,
              price_cents, shipping_cents, tax_cents, install_cents, deadline, position)
  on public.items to authenticated;
grant update (name, short_name, note, photo_url, source_url, source_domain,
              price_cents, shipping_cents, tax_cents, install_cents, deadline, position)
  on public.items to authenticated;
grant delete on public.items to authenticated;

create policy items_owner_select on public.items
  for select to authenticated using (private.owns_business(business_id));
create policy items_owner_insert on public.items
  for insert to authenticated with check (private.owns_business(business_id));
create policy items_owner_update on public.items
  for update to authenticated
  using (private.owns_business(business_id))
  with check (private.owns_business(business_id));
create policy items_owner_delete on public.items
  for delete to authenticated
  using (private.owns_business(business_id) and status = 'draft');

-- ------------------------------------------- read-only for owners (server writes)
grant select on public.pledges, public.ledger_entries, public.assets, public.owner_actions
  to authenticated;

create policy pledges_owner_select on public.pledges
  for select to authenticated using (private.owns_business(business_id));
create policy ledger_owner_select on public.ledger_entries
  for select to authenticated using (private.owns_business(business_id));
create policy assets_owner_select on public.assets
  for select to authenticated using (private.owns_business(business_id));
create policy owner_actions_owner_select on public.owner_actions
  for select to authenticated using (private.owns_business(business_id));

-- ------------------------------------------------------------- public views
-- The public page reads these views, never the base tables. They expose only
-- fields meant to be public: no stripe_account_id, no owner_user_id, no contributor
-- names or emails. Views run with the owner's rights on purpose (that is how they
-- skip RLS), so every column listed here is a deliberate disclosure.
create view public.public_businesses as
  select id, slug, name, legal_name, owner_display, owner_line, owner_photo_url, tagline,
         story, neighborhood, city, status_line, contact_email, logo_url, cover_url,
         accent_color, (stripe_account_id is not null) as accepting_pledges
  from public.businesses;

create view public.public_items as
  select i.id, i.business_id, i.name, i.short_name, i.note, i.photo_url, i.source_url,
         i.source_domain, i.goal_cents, i.deadline, i.status, i.position,
         least(i.goal_cents, coalesce((
           select sum(case when p.status = 'charged' then p.charge_cents else p.amount_cents end)
           from public.pledges p
           where p.item_id = i.id
             and p.status in ('pending', 'charging', 'requires_action', 'charged')
         ), 0))::integer as raised_cents
  from public.items i
  where i.status not in ('draft', 'cancelled');

grant select on public.public_businesses, public.public_items
  to anon, authenticated;
