-- User blocking (App Store Guideline 1.2 — user-generated content must let
-- users block abusive accounts). Blocked users' posts are hidden from the
-- blocker's feed (and vice-versa) by GET /feeds/posts.
create table if not exists public.user_blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create index if not exists user_blocks_blocked_idx on public.user_blocks(blocked_id);

-- Only the service role (backend) touches this table.
alter table public.user_blocks enable row level security;
