-- One row per billed render, so a "Report a bad render" can be checked against what was actually
-- rendered and charged (prompt_head, cost) and the exact image returned (image_sha). A refunded render
-- is locked: /api/model3d refuses an image whose hash matches a refunded render.
create table if not exists public.renders (
  id             uuid primary key,
  user_id        uuid not null references auth.users(id) on delete cascade,
  cost           int  not null,
  quality        text not null,
  prompt_head    text not null,
  image_sha      text not null,
  created_at     timestamptz not null default now(),
  reported_at    timestamptz,
  report_verdict text,
  report_reason  text,
  refunded       boolean not null default false
);
create index if not exists renders_user_reported_idx on public.renders(user_id, reported_at desc);
create index if not exists renders_sha_idx on public.renders(image_sha);
alter table public.renders enable row level security;
