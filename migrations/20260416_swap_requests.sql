-- ═══════════════════════════════════════════════════════════════════════════
-- Skill Swap Requests table
-- Stores formal bi-directional swap proposals between two providers
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS swap_requests (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The person proposing the swap
  proposer_id          UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  proposer_service_id  UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,

  -- The person being targeted
  target_user_id       UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  target_service_id    UUID REFERENCES services(id) ON DELETE SET NULL,

  -- What the proposer wants in return (category)
  target_category_id   TEXT,
  target_category_name TEXT,

  -- Proposal details
  service_type         TEXT DEFAULT 'Default',
  notes                TEXT,
  scheduled_time       TIMESTAMPTZ,

  -- AI match score set by the backend when creating the match
  ai_match_score       NUMERIC(5,2) DEFAULT 0,
  ai_match_reason      TEXT,

  -- Lifecycle
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','accepted','declined','cancelled','completed')),

  -- Linked booking created on acceptance (null until accepted)
  booking_id           UUID REFERENCES bookings(id) ON DELETE SET NULL,

  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_swap_requests_proposer   ON swap_requests(proposer_id);
CREATE INDEX IF NOT EXISTS idx_swap_requests_target     ON swap_requests(target_user_id);
CREATE INDEX IF NOT EXISTS idx_swap_requests_status     ON swap_requests(status);

-- Enable Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE swap_requests;
