-- Things that went wrong and need a human: failed refunds, payments that could not be credited,
-- webhooks dropped, account deletions that failed. Written by api/_lib/server.js alert(); read by
-- the owner through /api/admin/alerts. Service role only (RLS on, no policies).
create table if not exists public.ops_alerts (
  id         bigserial primary key,
  kind       text not null,
  detail     jsonb not null default '{}'::jsonb,
  seen       boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists ops_alerts_created_idx on public.ops_alerts(created_at desc);
alter table public.ops_alerts enable row level security;
