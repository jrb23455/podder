-- handle_user_upgrade still paid a hardcoded 25 when the launch promo was exhausted, while
-- handle_new_user and SIGNUP_BONUS in api/_lib/config.js both say 50. Migration
-- 0005_signup_bonus_50 raised the bonus but only touched handle_new_user, so the app has been
-- advertising 50 and paying 25 on the anonymous-upgrade path. Bring it in line.
--
-- Keep this in step with SIGNUP_BONUS and with handle_new_user if the number changes again,
-- and keep it below PACKS.starter.credits or the cheapest paid tier becomes unsellable.
--
-- NOTE the two bonuses stack on the anonymous route: handle_new_user grants on account
-- creation, then this grants again when an email is attached. A converting anonymous visitor
-- therefore receives 50 + 50 = 100, not 50.
create or replace function public.handle_user_upgrade()
returns trigger language plpgsql security definer set search_path = public
as $function$
declare bonus int; bonus_reason text; already boolean;
begin
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
    bonus := 50;                 -- was 25; matches SIGNUP_BONUS / handle_new_user
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
end $function$;
