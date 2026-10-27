-- Image messages in booking chats.
-- Text messages keep working without this; it only adds the column that
-- photo messages use.
alter table public.messages add column if not exists image_url text;
