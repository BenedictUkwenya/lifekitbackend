-- Direct payments: how a provider accepts payment, and a shared
-- "paid / received" record on bookings. LifeKit never moves the money.
--
-- Bank details live in their own table (not profiles) because profiles are
-- read in many public places. RLS is on with no policies, so only the backend
-- (service role) can read or write it; the API reveals bank details only to
-- the client of an accepted booking.
create table if not exists public.payment_details (
  user_id          uuid primary key references public.profiles(id) on delete cascade,
  accepts_cash     boolean not null default false,
  accepts_card     boolean not null default false,
  accepts_transfer boolean not null default false,
  bank_name        text check (char_length(bank_name) <= 80),
  account_holder   text check (char_length(account_holder) <= 120),
  iban             text check (char_length(iban) <= 34),
  updated_at       timestamptz not null default now()
);
alter table public.payment_details enable row level security;

alter table public.bookings
  add column if not exists client_marked_paid_at timestamptz,
  add column if not exists provider_confirmed_paid_at timestamptz;
