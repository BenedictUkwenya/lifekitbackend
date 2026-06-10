-- Migration: Cache AI onboarding plan translations per language
-- Run this once in the Supabase SQL editor.
-- After first profile fetch in KA or RU, the translated plan is stored here
-- so subsequent fetches are instant and avoid hitting the MyMemory API.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS onboarding_plan_translations JSONB NOT NULL DEFAULT '{}';
