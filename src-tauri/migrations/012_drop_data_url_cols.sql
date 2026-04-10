-- 012: Remove deprecated data URL storage columns.
-- avatar_hash / banner_hash (added in 011) are now the canonical image references.
-- The migrate_data_urls_to_files command ran on all existing installs during the
-- 011 transition period. These columns are safe to drop.
ALTER TABLE members DROP COLUMN avatar_data_url;
ALTER TABLE members DROP COLUMN banner_data_url;
