-- App waitlist: emails collected on lifekithub.com before the apps launch.
-- Only the backend (service role) reads or writes it.
create table if not exists public.waitlist (
  id bigint generated always as identity primary key,
  email text not null,
  role text not null default 'customer' check (role in ('customer', 'provider')),
  lang text not null default 'en',
  source text,
  created_at timestamptz not null default now()
);
create unique index if not exists waitlist_email_key on public.waitlist (lower(email));
alter table public.waitlist enable row level security;
