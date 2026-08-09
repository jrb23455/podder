-- Raise the signup bonus from 8 to 25 credits.
--
-- 25 is deliberately below the 60-credit Starter pack: a free tier at or above the
-- cheapest paid tier makes that tier unsellable. Keep this invariant if the number
-- changes again — and keep SIGNUP_BONUS in api/_lib/config.js in step with it, since
-- that constant is what the sign-up screen advertises.
--
-- Only affects accounts created from here on; existing profiles are left alone.

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, credits) values (new.id, new.email, 25)
  on conflict (id) do nothing;

  insert into public.credit_ledger(user_id, delta, reason, ref)
  values (new.id, 25, 'signup_bonus', 'signup:' || new.id)
  on conflict (ref) where ref is not null do nothing;

  return new;
end $$;
