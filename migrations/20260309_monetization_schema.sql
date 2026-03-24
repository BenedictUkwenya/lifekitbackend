alter table if exists public.profiles
add column if not exists subscription_tier text not null default 'free',
add column if not exists subscription_expiry timestamptz;

create table if not exists public.active_boosts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  service_id uuid references public.services(id) on delete cascade,
  boost_type text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists active_boosts_user_id_idx on public.active_boosts(user_id);
create index if not exists active_boosts_service_id_idx on public.active_boosts(service_id);
create index if not exists active_boosts_expires_at_idx on public.active_boosts(expires_at);

create table if not exists public.purchased_ai_tools (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  tool_key text not null,
  purchased_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, tool_key)
);

create index if not exists purchased_ai_tools_user_id_idx on public.purchased_ai_tools(user_id);
