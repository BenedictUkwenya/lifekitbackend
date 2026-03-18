alter table if exists public.profiles
add column if not exists stripe_connect_id text;
