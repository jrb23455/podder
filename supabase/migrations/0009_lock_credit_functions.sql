-- Close the credit-minting hole flagged by the Supabase security advisor.
--
-- Postgres grants EXECUTE on new functions to PUBLIC, and Supabase exposes everything in the
-- public schema at /rest/v1/rpc/<name>. So credit_credits / debit_credits, which are SECURITY
-- DEFINER, could be called by anyone holding the anon key (served publicly by /api/config):
-- add any amount to any account, or drain someone else's. Only the API functions, which use the
-- service-role key, are meant to move credits. The two trigger functions never need direct calls.

revoke execute on function public.credit_credits(uuid, int, text, text) from public, anon, authenticated;
revoke execute on function public.debit_credits(uuid, int, text, text)  from public, anon, authenticated;
revoke execute on function public.handle_new_user()     from public, anon, authenticated;
revoke execute on function public.handle_user_upgrade() from public, anon, authenticated;

grant execute on function public.credit_credits(uuid, int, text, text) to service_role;
grant execute on function public.debit_credits(uuid, int, text, text)  to service_role;

-- Functions created later in this schema should not be public by default either.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- Which account paid for which Tripo task. /api/model3d checks this before converting to STL or
-- refunding, so nobody can convert or refund a task they did not pay for, and each paid mesh gets
-- a bounded number of STL conversions (each one costs real Tripo credits).
create table if not exists public.model3d_tasks (
  task_id      text primary key,
  user_id      uuid references auth.users(id) on delete cascade,   -- null = owner (PIN)
  converts     int  not null default 0,
  stl_task_id  text,
  refunded     boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists model3d_tasks_user_idx on public.model3d_tasks(user_id, created_at desc);
alter table public.model3d_tasks enable row level security;

-- Failed owner-PIN attempts per IP, so the PIN cannot be guessed by brute force.
create table if not exists public.pin_failures (
  id         bigserial primary key,
  ip         text not null,
  created_at timestamptz not null default now()
);
create index if not exists pin_failures_ip_idx on public.pin_failures(ip, created_at desc);
alter table public.pin_failures enable row level security;
