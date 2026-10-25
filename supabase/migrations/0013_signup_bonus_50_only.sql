-- Launch promo removed (2026-10-25): the 1000-credit "first N accounts" bonus is gone; every
-- confirmed email gets the flat 50-credit signup bonus, once. The promo row stays at remaining = 0.
create or replace function public.grant_signup_bonus(uid uuid, addr text)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if exists (select 1 from public.credit_ledger
              where ref = 'bonus:' || uid or ref = 'upgrade:' || uid
                 or (ref = 'signup:' || uid and reason = 'signup_bonus')) then
    update public.profiles set email = coalesce(addr, email) where id = uid;
    return;
  end if;
  insert into public.profiles (id, email, credits) values (uid, addr, 0) on conflict (id) do nothing;
  insert into public.credit_ledger(user_id, delta, reason, ref)
  values (uid, 50, 'signup_bonus', 'bonus:' || uid)
  on conflict (ref) where ref is not null do nothing;
  update public.profiles set credits = credits + 50, email = coalesce(addr, email) where id = uid;
end $$;
revoke all on function public.grant_signup_bonus(uuid, text) from public, anon, authenticated;
update public.promos set remaining = 0 where name = 'launch';
