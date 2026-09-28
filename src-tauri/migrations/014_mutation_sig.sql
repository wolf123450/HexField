-- Ed25519 signature over the mutation (spec 08 §5). Stored so a synced mutation
-- can be re-served to third parties and verified by them. NULL only for rows
-- written before signing existed; peers reject those.
ALTER TABLE mutations ADD COLUMN sig TEXT;
