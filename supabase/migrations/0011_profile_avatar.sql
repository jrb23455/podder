-- Profile picture for the account menu (top-right profile button). Stored as a small data URL
-- (the client resizes to 128x128 JPEG, ~5-15 KB) so no storage bucket is needed. Written only by
-- /api/account (service role) after it checks the size and type; read back through /api/me.
-- Kept out of auth user_metadata on purpose: metadata is copied into every access token.
alter table public.profiles
  add column if not exists avatar text
  check (avatar is null or (length(avatar) <= 60000 and avatar like 'data:image/%'));
