-- bybrick Phase 1 schema. All money is integer cents.
-- Access control lives in 0003_access.sql; ledger guards in 0002_ledger_guards.sql.

create type public.item_status as enum
  ('draft', 'open', 'funded', 'purchased', 'in_use', 'expired', 'cancelled');

create type public.pledge_status as enum
  ('pending', 'charging', 'requires_action', 'charged', 'failed', 'cancelled', 'expired');

create type public.ledger_kind as enum
  ('contribution_income', 'owner_capital', 'platform_fee', 'processor_fee', 'refund', 'reversal');

-- ---------------------------------------------------------------- businesses
create table public.businesses (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique
                  check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 2 and 60),
  name            text not null check (length(name) between 1 and 120),
  legal_name      text not null check (length(legal_name) between 1 and 160),
  owner_display   text not null check (length(owner_display) between 1 and 120),
  owner_line      text check (length(owner_line) <= 200),
  owner_photo_url text,
  tagline         text check (length(tagline) <= 200),
  story           text check (length(story) <= 5000),
  neighborhood    text check (length(neighborhood) <= 80),
  city            text not null check (length(city) between 1 and 80),
  status_line     text check (length(status_line) <= 120),
  contact_email   text not null check (contact_email ~ '^[^@\s]+@[^@\s]+$' and length(contact_email) <= 254),
  logo_url        text,
  cover_url       text,
  accent_color    text not null default '#111111' check (accent_color ~ '^#[0-9a-fA-F]{6}$'),
  -- Set only by server code after Stripe onboarding. Owners cannot write it (see grants).
  stripe_account_id text unique check (stripe_account_id ~ '^acct_[A-Za-z0-9]+$'),
  -- Null until the owner first signs in and the server claims the business.
  owner_user_id   uuid references auth.users (id) on delete restrict,
  created_at      timestamptz not null default now()
);
create index businesses_owner_user_id_idx on public.businesses (owner_user_id);

-- --------------------------------------------------------------------- items
create table public.items (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses (id) on delete restrict,
  name            text not null check (length(name) between 1 and 120),
  short_name      text check (length(short_name) <= 40),
  note            text check (length(note) <= 1000),
  photo_url       text,
  source_url      text,
  source_domain   text,
  price_cents     integer not null check (price_cents between 1 and 100000000),
  shipping_cents  integer not null default 0 check (shipping_cents between 0 and 100000000),
  tax_cents       integer not null default 0 check (tax_cents between 0 and 100000000),
  install_cents   integer not null default 0 check (install_cents between 0 and 100000000),
  -- Always price + shipping + tax + install. Maintained by trigger; owners cannot write it.
  goal_cents      integer not null check (goal_cents > 0),
  -- Set when the first pledge arrives. After that the goal cannot change.
  goal_locked_at  timestamptz,
  deadline        timestamptz,
  status          public.item_status not null default 'draft',
  position        integer not null default 0,
  created_at      timestamptz not null default now(),
  unique (id, business_id),
  check (goal_cents = price_cents + shipping_cents + tax_cents + install_cents),
  check (status = 'draft' or deadline is not null)
);
create index items_business_id_idx on public.items (business_id, position);

-- ------------------------------------------------------------------- pledges
create table public.pledges (
  id                       uuid primary key default gen_random_uuid(),
  business_id              uuid not null references public.businesses (id) on delete restrict,
  item_id                  uuid not null,
  contributor_name         text not null check (length(contributor_name) between 1 and 120),
  contributor_email        text not null
                           check (contributor_email ~ '^[^@\s]+@[^@\s]+$' and length(contributor_email) <= 254),
  stripe_customer_id       text,
  stripe_payment_method_id text,
  setup_intent_id          text unique,
  payment_intent_id        text unique,
  amount_cents             integer not null check (amount_cents between 1 and 100000000),
  charge_cents             integer check (charge_cents >= 0 and charge_cents <= amount_cents),
  status                   public.pledge_status not null default 'pending',
  -- SHA-256 of a 32+ byte random token. The token itself is never stored.
  manage_token_hash        bytea not null unique check (length(manage_token_hash) = 32),
  -- Which consent wording the contributor agreed to, and when.
  consent_text_version     text not null,
  consented_at             timestamptz not null,
  created_at               timestamptz not null default now(),
  charged_at               timestamptz,
  -- Charging state. A charge attempt that crashes is picked up again when next_attempt_at passes.
  charge_attempts          smallint not null default 0,
  next_attempt_at          timestamptz,
  last_error_code          text,
  -- SHA-256 of the token in the "finish your payment" email (separate from the manage token).
  action_token_hash        bytea unique check (length(action_token_hash) = 32),
  foreign key (item_id, business_id) references public.items (id, business_id) on delete restrict,
  check (status <> 'charged' or (charge_cents is not null and charged_at is not null))
);
create index pledges_item_status_idx on public.pledges (item_id, status, created_at);

-- ------------------------------------------------------------ ledger_entries
-- APPEND-ONLY (trigger in 0002). Amounts are signed from the business's point of view:
-- income kinds are positive, cost kinds (fees, refunds) are negative, a reversal negates an
-- earlier entry. Corrections are new reversal entries, never edits.
create table public.ledger_entries (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses (id) on delete restrict,
  item_id           uuid,
  pledge_id         uuid references public.pledges (id) on delete restrict,
  kind              public.ledger_kind not null,
  amount_cents      integer not null,
  tax_year          smallint not null check (tax_year between 2020 and 2100),
  occurred_at       timestamptz not null,
  memo              text check (length(memo) <= 500),
  -- Stripe event id, or 'owner_action:<uuid>' for entries written by an owner action.
  source_event_id   text not null unique,
  reverses_entry_id uuid references public.ledger_entries (id) on delete restrict,
  created_at        timestamptz not null default now(),
  foreign key (item_id, business_id) references public.items (id, business_id) on delete restrict,
  check (amount_cents <> 0),
  check (kind not in ('contribution_income', 'owner_capital') or amount_cents > 0),
  check (kind not in ('platform_fee', 'processor_fee', 'refund') or amount_cents < 0),
  check ((kind = 'reversal') = (reverses_entry_id is not null))
);
create index ledger_entries_business_idx on public.ledger_entries (business_id, occurred_at);
create index ledger_entries_item_idx on public.ledger_entries (item_id);

-- -------------------------------------------------------------------- assets
create table public.assets (
  id                   uuid primary key default gen_random_uuid(),
  business_id          uuid not null references public.businesses (id) on delete restrict,
  item_id              uuid not null,
  name                 text not null check (length(name) between 1 and 120),
  cost_basis_cents     integer not null check (cost_basis_cents >= 0),
  contribution_cents   integer not null check (contribution_cents >= 0),
  owner_capital_cents  integer not null check (owner_capital_cents >= 0),
  placed_in_service_at timestamptz,
  photo_url            text,
  receipt_url          text,  -- storage path in the PRIVATE receipts bucket, not a public URL
  category_suggestion  text,
  created_at           timestamptz not null default now(),
  unique (item_id),
  foreign key (item_id, business_id) references public.items (id, business_id) on delete restrict
);

-- ------------------------------------------------------------ owner_actions
-- Audit log of owner actions: who, what, when. APPEND-ONLY (trigger in 0002).
create table public.owner_actions (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses (id) on delete restrict,
  actor_user_id uuid not null,
  action        text not null check (length(action) between 1 and 80),
  target_type   text,
  target_id     uuid,
  details       jsonb not null default '{}'::jsonb,  -- never put emails, tokens or card data here
  created_at    timestamptz not null default now()
);
create index owner_actions_business_idx on public.owner_actions (business_id, created_at);

-- --------------------------------------------------------- processed_events
-- Webhook idempotency: each Stripe event id is processed once.
create table public.processed_events (
  event_id     text primary key,
  event_type   text,
  processed_at timestamptz not null default now()
);
