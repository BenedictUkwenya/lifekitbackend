alter table if exists public.services
add column if not exists edit_count integer not null default 0;
