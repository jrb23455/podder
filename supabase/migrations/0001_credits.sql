-- Podder credits schema.
-- Run this once in the Supabase SQL editor (or `supabase db push`).
--
-- Design notes:
--   * Balances live in profiles.credits. Every change is mirrored into credit_ledger,
--     so the ledger is the audit trail and the balance is the fast read.
--   * Both mutating functions are SECURITY DEFINER and are the ONLY sanctioned way to
--     move credits. Clients can read their own rows but can never write them (see RLS).
--   * Idempotency is enforced by a partial unique index on credit_ledger.ref — Stripe
--     retries the same webhook event repeatedly and must not double-credit.

create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  credits    integer not null default 0 check (credits >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.credit_ledger (
  id         bigserial primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  delta      integer not null,
  reason     text not null,
  ref        text,
  created_at timestamptz not null default now()
);

create index if not exists credit_ledger_user_idx on public.credit_ledger(user_id, created_at desc);
-- Partial unique: rows without a ref (unattributed adjustments) may repeat; rows with one may not.
create unique index if not exists credit_ledger_ref_uniq on public.credit_ledger(ref) where ref is not null;

-- ---------------------------------------------------------------------------
-- Spend. Returns the new balance, or raises 'insufficient_credits'.
-- The guard lives in the UPDATE's WHERE clause, so concurrent renders from the
-- same account serialize on the row lock and can never overdraw.
-- ---------------------------------------------------------------------------
create or replace function public.debit_credits(
  p_user uuid, p_amount int, p_reason text, p_ref text default null
) returns int
language plpgsql security definer set search_path = public
as $$
declare new_balance int;
begin
  if p_amount <= 0 then raise exception 'amount_must_be_positive'; end if;

  update public.profiles
     set credits = credits - p_amount
   where id = p_user and credits >= p_amount
  returning credits into new_balance;

  if new_balance is null then
    raise exception 'insufficient_credits' using errcode = 'P0001';
  end if;

  insert into public.credit_ledger(user_id, delta, reason, ref)
  values (p_user, -p_amount, p_reason, p_ref);

  return new_balance;
end $$;

-- ---------------------------------------------------------------------------
-- Top up. Idempotent on p_ref: replaying the same Stripe event is a no-op that
-- returns the balance unchanged rather than crediting twice.
-- ---------------------------------------------------------------------------
create or replace function public.credit_credits(
  p_user uuid, p_amount int, p_reason text, p_ref text
) returns int
language plpgsql security definer set search_path = public
as $$
declare new_balance int; rows_added int;
begin
  if p_amount <= 0 then raise exception 'amount_must_be_positive'; end if;

  -- Defensive: a top-up must never land on a missing profile row. If the signup trigger
  -- did not fire (installed late, user created out of band), create the row at zero and
  -- let the credit apply on top — otherwise a paid purchase would silently vanish.
  insert into public.profiles (id, email, credits)
  select p_user, (select email from auth.users where id = p_user), 0
  on conflict (id) do nothing;

  insert into public.credit_ledger(user_id, delta, reason, ref)
  values (p_user, p_amount, p_reason, p_ref)
  on conflict (ref) where ref is not null do nothing;

  get diagnostics rows_added = row_count;
  if rows_added = 0 then
    select credits into new_balance from public.profiles where id = p_user;
    return new_balance;                       -- already fulfilled
  end if;

  update public.profiles set credits = credits + p_amount
   where id = p_user
  returning credits into new_balance;

  return new_balance;
end $$;

-- ---------------------------------------------------------------------------
-- Every new auth user gets a profile and a small free allowance so the app is
-- usable the moment they sign in.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, credits) values (new.id, new.email, 8)
  on conflict (id) do nothing;

  insert into public.credit_ledger(user_id, delta, reason, ref)
  values (new.id, 8, 'signup_bonus', 'signup:' || new.id)
  on conflict (ref) where ref is not null do nothing;

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- RLS: a signed-in user may READ their own balance and ledger, nothing more.
-- All writes go through the service-role key in the API functions, which bypasses RLS.
-- ---------------------------------------------------------------------------
alter table public.profiles      enable row level security;
alter table public.credit_ledger enable row level security;

drop policy if exists "own profile readable" on public.profiles;
create policy "own profile readable" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "own ledger readable" on public.credit_ledger;
create policy "own ledger readable" on public.credit_ledger
  for select using (auth.uid() = user_id);
