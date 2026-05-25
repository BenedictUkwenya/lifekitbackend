-- Migration: add JSONB translation columns to the services table
-- Run this once in the Supabase SQL editor:
--   Dashboard → SQL Editor → paste this file → Run

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS title_translations       JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS description_translations JSONB NOT NULL DEFAULT '{}';

-- Optional index so filtering by a specific language is fast later
CREATE INDEX IF NOT EXISTS idx_services_title_translations
  ON services USING gin (title_translations);
