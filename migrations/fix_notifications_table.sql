alter table if exists public.profiles
add column if not exists status text default 'active';

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text,
  message text,
  is_read boolean not null default false,
  type text,
  reference_id text
);

alter table if exists public.notifications
add column if not exists created_at timestamptz default now();

alter table if exists public.notifications
add column if not exists user_id uuid references public.profiles(id) on delete cascade;

alter table if exists public.notifications
add column if not exists title text;

alter table if exists public.notifications
add column if not exists message text;

alter table if exists public.notifications
add column if not exists is_read boolean default false;

alter table if exists public.notifications
add column if not exists type text;

alter table if exists public.notifications
add column if not exists reference_id text;
