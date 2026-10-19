-- Owner edits to the public e-brochure (/brochure): hidden tiles, cover picks, edited text.
-- One row (id = 1). Read publicly through /api/brochure; written only by that endpoint after
-- it checks the owner PIN. RLS is on with no policies, so only the service role can touch it.
create table if not exists public.brochure_overrides (
  id         int primary key default 1 check (id = 1),
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.brochure_overrides enable row level security;
insert into public.brochure_overrides (id) values (1) on conflict (id) do nothing;
