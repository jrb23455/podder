-- Launch promo: the first 10 accounts get 1000 credits instead of the usual 25.
--
-- The cap is what makes this affordable — 10 × 1000 fast renders is roughly $140 of
-- Replicate spend, and it cannot grow past that no matter how much traffic arrives.
--
-- Slots are claimed by a single guarded UPDATE rather than by counting rows. Counting
-- would let two concurrent signups both see "9 used" and both grant, handing out an
-- 11th. `where remaining > 0 returning` takes a row lock, so the 11th signup gets
-- nothing to claim and quietly falls back to the standard bonus.

create table if not exists public.promos (
  name      text primary key,
  credits   integer not null check (credits > 0),
  remaining integer not null check (remaining >= 0)
);

insert into public.promos (name, credits, remaining)
values ('launch', 1000, 10)
on conflict (name) do nothing;

-- Service-role only. /api/config reads it with the service key to show the counter;
-- no client ever touches this table directly.
alter table public.promos enable row level security;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
declare bonus int; bonus_reason text;
begin
  -- Try to claim a launch slot. Atomic: the row lock serializes concurrent signups.
  update public.promos
     set remaining = remaining - 1
   where name = 'launch' and remaining > 0
  returning credits into bonus;

  if bonus is null then
    bonus := 25;                      -- keep in step with SIGNUP_BONUS in api/_lib/config.js
    bonus_reason := 'signup_bonus';
  else
    bonus_reason := 'launch_bonus';
  end if;

  insert into public.profiles (id, email, credits) values (new.id, new.email, bonus)
  on conflict (id) do nothing;

  insert into public.credit_ledger(user_id, delta, reason, ref)
  values (new.id, bonus, bonus_reason, 'signup:' || new.id)
  on conflict (ref) where ref is not null do nothing;

  return new;
end $$;
