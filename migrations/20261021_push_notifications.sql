-- Push notifications (FCM).
-- 1) device_tokens: one row per installed app, owned by a user.
-- 2) A trigger on notifications that forwards every new row to the backend's
--    /push/dispatch endpoint, which delivers it through Firebase.
--
-- BEFORE RUNNING: replace REPLACE_WITH_PUSH_WEBHOOK_SECRET below with the same
-- random value you set as PUSH_WEBHOOK_SECRET in the backend's Vercel env.

create table if not exists public.device_tokens (
  token text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  platform text,
  updated_at timestamptz not null default now()
);
create index if not exists device_tokens_user_idx on public.device_tokens(user_id);
alter table public.device_tokens enable row level security; -- backend (service role) only

create extension if not exists pg_net;

create or replace function public.forward_notification_push()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform net.http_post(
    url := 'https://lifekitbackend.vercel.app/push/dispatch',
    body := jsonb_build_object('record', to_jsonb(new)),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-push-secret', 'REPLACE_WITH_PUSH_WEBHOOK_SECRET'
    ),
    timeout_milliseconds := 5000
  );
  return new;
exception when others then
  -- Never block the notification insert because push delivery failed.
  return new;
end;
$$;

drop trigger if exists notifications_forward_push on public.notifications;
create trigger notifications_forward_push
  after insert on public.notifications
  for each row execute function public.forward_notification_push();
