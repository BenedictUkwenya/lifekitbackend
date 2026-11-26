-- Replies to feed comments: a reply points at the comment it answers.
-- One level deep in the app (replies to a reply attach to the same parent).
alter table public.post_comments
  add column if not exists parent_id uuid references public.post_comments(id) on delete cascade;
create index if not exists post_comments_parent_idx on public.post_comments(parent_id);
