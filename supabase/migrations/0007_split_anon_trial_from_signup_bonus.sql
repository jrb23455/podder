-- handle_new_user granted the full 50-credit signup bonus to EVERY new auth user, including
-- anonymous trial sessions that carry no email and cost nothing to create. Combined with
-- handle_user_upgrade granting again on conversion, a converting visitor received 100 credits
-- while the gate advertised 50 — and a visitor who never converted still walked off with 50
-- free renders (~$0.70 of Replicate) for providing no contact details at all.
--
-- Supabase anonymous users have a null email, so the two cases are distinguishable:
--   anonymous trial : 10 credits  (the "trial is ~5 renders" the client code always assumed)
--   real signup     : 50 credits  (SIGNUP_BONUS in api/_lib/config.js — what the gate promises)
-- A visitor who starts anonymous and then converts ends on 10 + 50 = 60, which rewards trying
-- first without handing out two full bonuses.
--
-- Keep the 50 in step with SIGNUP_BONUS and handle_user_upgrade, and keep it below
-- PACKS.starter.credits or the cheapest paid tier becomes unsellable.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $function$
declare bonus int; bonus_reason text;
begin
  if new.email is null then
    bonus := 10; bonus_reason := 'anon_trial';
  else
    bonus := 50; bonus_reason := 'signup_bonus';
  end if;

  insert into public.profiles (id, email, credits) values (new.id, new.email, bonus)
  on conflict (id) do nothing;

  insert into public.credit_ledger(user_id, delta, reason, ref)
  values (new.id, bonus, bonus_reason, 'signup:' || new.id)
  on conflict (ref) where ref is not null do nothing;

  return new;
end $function$;
