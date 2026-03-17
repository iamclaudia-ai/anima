-- Up

-- Documents table for ingested ~/memory markdown files
CREATE TABLE IF NOT EXISTS memory_documents (
  file_path         TEXT PRIMARY KEY,
  category          TEXT NOT NULL,
  title             TEXT,
  content           TEXT NOT NULL,
  file_modified_at  TEXT,
  ingested_at       TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memory_documents_category ON memory_documents(category);

-- Unified FTS5 index across all memory sources
-- Porter stemming: "fixing" matches "fix", "fixed", "fixes"
-- UNINDEXED columns: stored for filtering but not searched
CREATE VIRTUAL TABLE IF NOT EXISTS memory_search_fts USING fts5(
  content,
  source_type UNINDEXED,
  source_id UNINDEXED,
  cwd UNINDEXED,
  timestamp UNINDEXED,
  category UNINDEXED,
  tokenize='porter unicode61'
);

-- Triggers to keep memory_documents in sync with FTS
CREATE TRIGGER IF NOT EXISTS memory_docs_fts_insert AFTER INSERT ON memory_documents BEGIN
  INSERT INTO memory_search_fts(content, source_type, source_id, cwd, timestamp, category)
  VALUES (new.content, 'document', new.file_path, '', new.file_modified_at, new.category);
END;

CREATE TRIGGER IF NOT EXISTS memory_docs_fts_delete AFTER DELETE ON memory_documents BEGIN
  DELETE FROM memory_search_fts WHERE source_type = 'document' AND source_id = old.file_path;
END;

CREATE TRIGGER IF NOT EXISTS memory_docs_fts_update AFTER UPDATE OF content ON memory_documents BEGIN
  DELETE FROM memory_search_fts WHERE source_type = 'document' AND source_id = old.file_path;
  INSERT INTO memory_search_fts(content, source_type, source_id, cwd, timestamp, category)
  VALUES (new.content, 'document', new.file_path, '', new.file_modified_at, new.category);
END;

-- Trigger to index conversation summaries when archived
CREATE TRIGGER IF NOT EXISTS memory_conv_fts_archive
AFTER UPDATE OF status ON memory_conversations
WHEN new.status = 'archived' AND new.summary IS NOT NULL AND length(new.summary) > 0 BEGIN
  INSERT INTO memory_search_fts(content, source_type, source_id, cwd, timestamp, category)
  VALUES (
    new.summary,
    'summary',
    CAST(new.id AS TEXT),
    COALESCE(json_extract(new.metadata, '$.cwd'), ''),
    new.first_message_at,
    'summary'
  );
END;

-- Down
DROP TRIGGER IF EXISTS memory_docs_fts_insert;
DROP TRIGGER IF EXISTS memory_docs_fts_delete;
DROP TRIGGER IF EXISTS memory_docs_fts_update;
DROP TRIGGER IF EXISTS memory_conv_fts_archive;
DROP TABLE IF EXISTS memory_search_fts;
DROP TABLE IF EXISTS memory_documents;
