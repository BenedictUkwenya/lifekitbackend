alter table if exists public.profiles
add column if not exists status text default 'active';

create table if not exists public.disputes (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  initiator_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null,
  status text not null default 'open',
  admin_verdict text,
  created_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text,
  message text,
  type text,
  reference_id uuid,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

alter table if exists public.notifications
add column if not exists title text;

alter table if exists public.notifications
add column if not exists message text;

alter table if exists public.notifications
add column if not exists user_id uuid references public.profiles(id) on delete cascade;
