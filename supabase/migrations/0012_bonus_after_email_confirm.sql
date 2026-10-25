-- Signup bonus only once the email address is confirmed (2026-10-25).
-- Before: an email signup got 50 credits the moment the row was created, confirmed or not, so
-- throwaway addresses could farm credits. Now the bonus (or the launch promo, while it lasts) is
-- granted when auth.users.email_confirmed_at is first set: by a new email signup confirming, or
-- by an anonymous trial user converting to a confirmed email. The anonymous trial itself is unchanged.
-- One bonus per user, ever: grant_signup_bonus is idempotent on the 'bonus:<id>' ledger ref and also
-- skips users who already received one under the old 'signup:' / 'upgrade:' refs.

create or replace function public.grant_signup_bonus(uid uuid, addr text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare bonus int; bonus_reason text;
begin
  if exists (select 1 from public.credit_ledger
              where ref = 'bonus:' || uid or ref = 'upgrade:' || uid
                 or (ref = 'signup:' || uid and reason = 'signup_bonus')) then
    update public.profiles set email = coalesce(addr, email) where id = uid;
    return;
  end if;

  update public.promos set remaining = remaining - 1
   where name = 'launch' and remaining > 0
  returning credits into bonus;
  if bonus is null then bonus := 50; bonus_reason := 'signup_bonus';
  else bonus_reason := 'launch_bonus'; end if;

  insert into public.profiles (id, email, credits) values (uid, addr, 0) on conflict (id) do nothing;
  insert into public.credit_ledger(user_id, delta, reason, ref)
  values (uid, bonus, bonus_reason, 'bonus:' || uid)
  on conflict (ref) where ref is not null do nothing;
  update public.profiles set credits = credits + bonus, email = coalesce(addr, email) where id = uid;
end $$;

-- New users: anonymous trial keeps its 10 credits; an email signup starts at 0 and gets the bonus
-- on confirmation (or right away if the provider already confirmed the address, e.g. OAuth).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if new.email is null then
    insert into public.profiles (id, email, credits) values (new.id, null, 10) on conflict (id) do nothing;
    insert into public.credit_ledger(user_id, delta, reason, ref)
    values (new.id, 10, 'anon_trial', 'signup:' || new.id)
    on conflict (ref) where ref is not null do nothing;
  else
    insert into public.profiles (id, email, credits) values (new.id, new.email, 0) on conflict (id) do nothing;
    if new.email_confirmed_at is not null then perform public.grant_signup_bonus(new.id, new.email); end if;
  end if;
  return new;
end $$;

-- Anonymous -> email: only keep the address in sync here; the bonus waits for confirmation.
create or replace function public.handle_user_upgrade()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  update public.profiles set email = coalesce(new.email, email) where id = new.id;
  if new.email_confirmed_at is not null then perform public.grant_signup_bonus(new.id, new.email); end if;
  return new;
end $$;

create or replace function public.handle_email_confirmed()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  perform public.grant_signup_bonus(new.id, new.email);
  return new;
end $$;

drop trigger if exists on_auth_email_confirmed on auth.users;
create trigger on_auth_email_confirmed
  after update of email_confirmed_at on auth.users
  for each row when (old.email_confirmed_at is null and new.email_confirmed_at is not null and new.email is not null)
  execute function public.handle_email_confirmed();

revoke all on function public.grant_signup_bonus(uuid, text) from public, anon, authenticated;
