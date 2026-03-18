create table if not exists public.disputes (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  initiator_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  admin_verdict text,
  created_at timestamptz not null default now()
);

create index if not exists disputes_booking_id_idx on public.disputes(booking_id);
create index if not exists disputes_status_idx on public.disputes(status);
