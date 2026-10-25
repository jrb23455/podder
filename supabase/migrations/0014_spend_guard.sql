-- Spend guard (2026-10-25). Estimated provider spend per day and bucket, so free-credit renders
-- can be held to a daily budget without ever limiting paying customers:
--   bucket 'paid'  - users with a purchase on record: counted, never limited
--   bucket 'free'  - everyone else (signup bonus, anonymous trial): limited by FREE_DAILY_BUDGET_CENTS
--   bucket 'owner' - owner PIN renders (not billed): limited by OWNER_DAILY_BUDGET_CENTS
-- spend_hourly counts all renders per hour for the spike alarm. Server (service role) only.

create table if not exists public.spend_counters (
  day     date not null,
  bucket  text not null,
  cents   int  not null default 0,
  renders int  not null default 0,
  paused_alerted boolean not null default false,
  primary key (day, bucket)
);
create table if not exists public.spend_hourly (
  hour    timestamptz primary key,
  renders int not null default 0,
  alerted boolean not null default false
);
alter table public.spend_counters enable row level security;
alter table public.spend_hourly  enable row level security;

-- Adds one render's estimated cost if it fits the budget (null budget = unlimited).
-- Returns {ok, total, hour_renders, hour_alerted} or {ok:false, total, paused_alerted}.
create or replace function public.spend_add(p_bucket text, p_cents int, p_budget int)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare t int; pa boolean; h int; ha boolean;
begin
  insert into spend_counters(day, bucket) values (current_date, p_bucket) on conflict do nothing;
  update spend_counters set cents = cents + p_cents, renders = renders + 1
   where day = current_date and bucket = p_bucket and (p_budget is null or cents + p_cents <= p_budget)
  returning cents into t;
  if t is null then
    select cents, paused_alerted into t, pa from spend_counters where day = current_date and bucket = p_bucket;
    update spend_counters set paused_alerted = true where day = current_date and bucket = p_bucket;
    return jsonb_build_object('ok', false, 'total', t, 'paused_alerted', pa);
  end if;
  insert into spend_hourly(hour) values (date_trunc('hour', now())) on conflict do nothing;
  update spend_hourly set renders = renders + 1 where hour = date_trunc('hour', now())
  returning renders, alerted into h, ha;
  return jsonb_build_object('ok', true, 'total', t, 'hour_renders', h, 'hour_alerted', ha);
end $$;

-- A failed render gives its estimate back, so errors don't eat the free budget.
create or replace function public.spend_undo(p_bucket text, p_cents int)
returns void language sql security definer set search_path to 'public' as $$
  update spend_counters set cents = greatest(0, cents - p_cents), renders = greatest(0, renders - 1)
   where day = current_date and bucket = p_bucket;
$$;

create or replace function public.spend_mark_spike()
returns void language sql security definer set search_path to 'public' as $$
  update spend_hourly set alerted = true where hour = date_trunc('hour', now());
$$;

revoke all on function public.spend_add(text, int, int) from public, anon, authenticated;
revoke all on function public.spend_undo(text, int) from public, anon, authenticated;
revoke all on function public.spend_mark_spike() from public, anon, authenticated;
