-- Anonymous trial: visitors can render 5 times before creating an account.
--
-- Two rules make this safe:
--   * Anonymous users get a small fixed allowance and must NOT consume launch promo
--     slots — otherwise the 10 slots would be eaten by drive-by traffic in minutes.
--   * Converting an anonymous account into a real one grants the proper signup bonus.
--     handle_new_user only fires on INSERT, and conversion is an UPDATE of the same row,
--     so without the second trigger below, signing up after trying would be a downgrade
--     and nobody would ever convert.

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
declare bonus int; bonus_reason text;
begin
  if new.is_anonymous then
    bonus := 5;
    bonus_reason := 'anon_trial';
  else
    -- Atomic launch-slot claim; falls back to the standard bonus when they run out.
    update public.promos
       set remaining = remaining - 1
     where name = 'launch' and remaining > 0
    returning credits into bonus;

    if bonus is null then
      bonus := 25;                  -- keep in step with SIGNUP_BONUS in api/_lib/config.js
      bonus_reason := 'signup_bonus';
    else
      bonus_reason := 'launch_bonus';
    end if;
  end if;

  insert into public.profiles (id, email, credits) values (new.id, new.email, bonus)
  on conflict (id) do nothing;

  insert into public.credit_ledger(user_id, delta, reason, ref)
  values (new.id, bonus, bonus_reason, 'signup:' || new.id)
  on conflict (ref) where ref is not null do nothing;

  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Anonymous -> permanent conversion. Grants the real signup bonus on top of
-- whatever trial credits are left, and backfills the now-known email.
-- Idempotent on 'upgrade:<id>'.
-- ---------------------------------------------------------------------------
create or replace function public.handle_user_upgrade()
returns trigger language plpgsql security definer set search_path = public
as $$
declare bonus int; bonus_reason text; already boolean;
begin
  -- Check BEFORE claiming a promo slot. Claiming first and discovering afterwards that
  -- this upgrade was already recorded would silently burn a 1000-credit slot.
  select exists(
    select 1 from public.credit_ledger where ref = 'upgrade:' || new.id
  ) into already;

  if already then
    update public.profiles set email = coalesce(new.email, email) where id = new.id;
    return new;
  end if;

  update public.promos
     set remaining = remaining - 1
   where name = 'launch' and remaining > 0
  returning credits into bonus;

  if bonus is null then
    bonus := 25;
    bonus_reason := 'signup_bonus';
  else
    bonus_reason := 'launch_bonus';
  end if;

  insert into public.credit_ledger(user_id, delta, reason, ref)
  values (new.id, bonus, bonus_reason, 'upgrade:' || new.id)
  on conflict (ref) where ref is not null do nothing;

  update public.profiles
     set credits = credits + bonus,
         email   = coalesce(new.email, email)
   where id = new.id;

  return new;
end $$;

drop trigger if exists on_auth_user_upgraded on auth.users;
create trigger on_auth_user_upgraded
  after update on auth.users
  for each row
  when (old.is_anonymous is true and new.is_anonymous is false)
  execute function public.handle_user_upgrade();
