-- Migration: bidirectional reviews (client rates provider + provider rates client)
-- Run at: https://app.supabase.com/project/ogzqlmnivkvoxmsrawmn/sql/new

-- 0. Make provider_id nullable (was NOT NULL, but provider ratings don't have one)
ALTER TABLE reviews
  ALTER COLUMN provider_id DROP NOT NULL;

-- 1. Add reviewee_id (who is being rated)
ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS reviewee_id UUID REFERENCES profiles(id) ON DELETE SET NULL;

-- 2. Add reviewer_role to distinguish direction
ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS reviewer_role TEXT
    CHECK (reviewer_role IN ('client', 'provider'))
    DEFAULT 'client';

-- 3. Backfill existing reviews: reviewee_id = provider_id, reviewer_role = 'client'
UPDATE reviews
SET reviewee_id = provider_id,
    reviewer_role = 'client'
WHERE reviewee_id IS NULL AND provider_id IS NOT NULL;

-- 4. Drop old unique constraint on booking_id alone (only one review per booking was allowed)
--    Allow one per (booking_id, reviewer_id) so both parties can leave a review
ALTER TABLE reviews
  DROP CONSTRAINT IF EXISTS reviews_booking_id_key;

ALTER TABLE reviews
  DROP CONSTRAINT IF EXISTS reviews_booking_reviewer_unique;

ALTER TABLE reviews
  ADD CONSTRAINT reviews_booking_reviewer_unique
  UNIQUE (booking_id, reviewer_id);
