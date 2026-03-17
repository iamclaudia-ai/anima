-- Up

-- Drop the trigger that indexed conversation summaries into FTS on archive.
-- Episode files (one per conversation) now replace summaries as the FTS source —
-- they contain far richer detail for search.
DROP TRIGGER IF EXISTS memory_conv_fts_archive;

-- Remove existing summary entries from FTS index.
-- Episodes will be indexed via the document ingestion pipeline.
DELETE FROM memory_search_fts WHERE source_type = 'summary';

-- Add cwd column to memory_documents so episode files can store
-- the project path parsed from **Project:** line.
ALTER TABLE memory_documents ADD COLUMN cwd TEXT DEFAULT '';

-- Recreate FTS triggers to pass cwd through
DROP TRIGGER IF EXISTS memory_docs_fts_insert;
DROP TRIGGER IF EXISTS memory_docs_fts_delete;
DROP TRIGGER IF EXISTS memory_docs_fts_update;

CREATE TRIGGER memory_docs_fts_insert AFTER INSERT ON memory_documents BEGIN
  INSERT INTO memory_search_fts(content, source_type, source_id, cwd, timestamp, category)
  VALUES (new.content, 'document', new.file_path, COALESCE(new.cwd, ''), new.file_modified_at, new.category);
END;

CREATE TRIGGER memory_docs_fts_delete AFTER DELETE ON memory_documents BEGIN
  DELETE FROM memory_search_fts WHERE source_type = 'document' AND source_id = old.file_path;
END;

CREATE TRIGGER memory_docs_fts_update AFTER UPDATE OF content ON memory_documents BEGIN
  DELETE FROM memory_search_fts WHERE source_type = 'document' AND source_id = old.file_path;
  INSERT INTO memory_search_fts(content, source_type, source_id, cwd, timestamp, category)
  VALUES (new.content, 'document', new.file_path, COALESCE(new.cwd, ''), new.file_modified_at, new.category);
END;

-- Down

ALTER TABLE memory_documents DROP COLUMN cwd;

-- Restore original triggers without cwd
DROP TRIGGER IF EXISTS memory_docs_fts_insert;
DROP TRIGGER IF EXISTS memory_docs_fts_delete;
DROP TRIGGER IF EXISTS memory_docs_fts_update;

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

-- Recreate the summary archive trigger
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
