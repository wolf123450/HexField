-- FTS5 full-text search index over message content.
-- Uses content= mode so FTS5 reads from the messages table at query time.
-- Triggers keep the index synchronized with the content table.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='rowid'
);

-- Backfill existing non-deleted messages
INSERT INTO messages_fts(rowid, content)
  SELECT rowid, content FROM messages WHERE content IS NOT NULL;

-- Keep in sync with inserts
CREATE TRIGGER IF NOT EXISTS messages_fts_ai
  AFTER INSERT ON messages
BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content) ;
END;

-- Keep in sync with deletes
CREATE TRIGGER IF NOT EXISTS messages_fts_ad
  AFTER DELETE ON messages
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content)
    VALUES('delete', old.rowid, old.content);
END;

-- Keep in sync with content updates (edit/delete mutations update the content column via db_save_mutation)
CREATE TRIGGER IF NOT EXISTS messages_fts_au
  AFTER UPDATE OF content ON messages
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content)
    VALUES('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content)
    SELECT new.rowid, new.content WHERE new.content IS NOT NULL;
END;
