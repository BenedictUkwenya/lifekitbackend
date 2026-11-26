-- How a booking is paid. 'wallet' = money held in LifeKit wallets (refunded
-- or paid out by the app); 'direct' = client pays the provider outside the app.
-- Existing bookings were all wallet-based. The default stays 'wallet' so any
-- booking created by older code during the deploy is still settled correctly;
-- current code always sets the value explicitly.
alter table public.bookings
  add column if not exists payment_method text not null default 'wallet'
  check (payment_method in ('wallet', 'direct'));
