-- 011: Add content-addressed hash columns for images.
-- Old avatar_data_url / banner_data_url columns are kept for backward compat
-- during migration; ignored after startup migration runs.
ALTER TABLE members ADD COLUMN avatar_hash TEXT;
ALTER TABLE members ADD COLUMN banner_hash TEXT;
ALTER TABLE servers ADD COLUMN avatar_hash TEXT;
