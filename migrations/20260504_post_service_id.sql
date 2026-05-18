-- Link posts to services so feed can show rich Book/Swap CTAs
ALTER TABLE posts ADD COLUMN IF NOT EXISTS service_id UUID REFERENCES services(id) ON DELETE SET NULL;
