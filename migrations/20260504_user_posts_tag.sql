-- Allow any user to post to the feed (not just admin)
-- Add a tag column to posts for LifeKit-themed categorisation

ALTER TABLE posts ADD COLUMN IF NOT EXISTS tag TEXT DEFAULT 'general';

-- Optional: add a check constraint so only valid tags are used
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_tag_check;
ALTER TABLE posts ADD CONSTRAINT posts_tag_check
  CHECK (tag IN ('general', 'skill_offer', 'service', 'looking_for', 'tip', 'swap'));
