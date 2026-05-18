-- Add image_urls array column to posts for multi-image support (max 3)
ALTER TABLE posts ADD COLUMN IF NOT EXISTS image_urls TEXT[] DEFAULT '{}';
