-- "My 3D models" library (2026-10-29): a small thumbnail and a title per paid 3D model, so the
-- STLs people paid for can be found and downloaded again from any browser. Written only by
-- /api/model3d (service role) when the model is created.
alter table public.model3d_tasks
  add column if not exists thumb text check (thumb is null or (length(thumb) <= 40000 and thumb like 'data:image/%')),
  add column if not exists title text check (title is null or length(title) <= 160);
create index if not exists model3d_tasks_user_created on public.model3d_tasks (user_id, created_at desc);
