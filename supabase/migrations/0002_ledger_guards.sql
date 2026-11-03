-- Append-only enforcement lives in the database, not just in app code.

create function public.forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% on % is not allowed: this table is append-only', tg_op, tg_table_name
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger ledger_entries_no_update_delete
  before update or delete on public.ledger_entries
  for each row execute function public.forbid_mutation();
create trigger ledger_entries_no_truncate
  before truncate on public.ledger_entries
  for each statement execute function public.forbid_mutation();

create trigger owner_actions_no_update_delete
  before update or delete on public.owner_actions
  for each row execute function public.forbid_mutation();
create trigger owner_actions_no_truncate
  before truncate on public.owner_actions
  for each statement execute function public.forbid_mutation();

-- A ledger reversal must point at an entry in the same business.
create function public.ledger_check_reversal() returns trigger
language plpgsql as $$
begin
  if new.reverses_entry_id is not null and not exists (
    select 1 from public.ledger_entries e
    where e.id = new.reverses_entry_id
      and e.business_id = new.business_id
      and e.amount_cents = -new.amount_cents
  ) then
    raise exception 'reversal must negate an entry of the same business and amount';
  end if;
  return new;
end;
$$;
create trigger ledger_entries_check_reversal
  before insert on public.ledger_entries
  for each row execute function public.ledger_check_reversal();

-- Items: goal = price + shipping + tax + install, and it cannot change once locked.
create function public.items_goal_guard() returns trigger
language plpgsql as $$
begin
  new.goal_cents := new.price_cents + new.shipping_cents + new.tax_cents + new.install_cents;
  if tg_op = 'UPDATE' and old.goal_locked_at is not null then
    if new.price_cents    is distinct from old.price_cents
    or new.shipping_cents is distinct from old.shipping_cents
    or new.tax_cents      is distinct from old.tax_cents
    or new.install_cents  is distinct from old.install_cents
    or new.goal_locked_at is distinct from old.goal_locked_at then
      raise exception 'item goal is locked; add a new item instead'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
create trigger items_goal_guard
  before insert or update on public.items
  for each row execute function public.items_goal_guard();
