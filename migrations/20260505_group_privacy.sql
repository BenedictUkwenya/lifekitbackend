-- Add is_private column to groups table
ALTER TABLE groups ADD COLUMN IF NOT EXISTS is_private BOOLEAN DEFAULT FALSE;
