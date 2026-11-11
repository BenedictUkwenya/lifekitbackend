-- Event likes and comments. feedRoutes already reads and writes these tables,
-- but they were never created, so liking or commenting on an event failed.
create table if not exists public.event_likes (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (event_id, user_id)
);

create table if not exists public.event_comments (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists event_comments_event_id_idx on public.event_comments (event_id, created_at);

-- The backend uses the service role; no direct client access.
alter table public.event_likes enable row level security;
alter table public.event_comments enable row level security;
