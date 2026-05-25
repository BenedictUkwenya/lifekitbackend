-- Migration: add JSONB translation column to the service_categories table
-- Run this once in the Supabase SQL editor

ALTER TABLE service_categories
  ADD COLUMN IF NOT EXISTS name_translations JSONB NOT NULL DEFAULT '{}';
