-- Up

-- Full-text index over the transcript corpus.
--
-- ## Why a dedicated table rather than `memory_search_fts`
--
-- `memory_search_fts` stores its own copy of every indexed document and carries
-- `source_type` / `source_id` as UNINDEXED columns. That shape is fine for the
-- 8k memory documents it holds today and wrong for 115k transcript entries:
--
--   * **Size.** Appending the corpus to it grew the database 449MB → 605MB.
--     An external-content index over the same rows costs 449MB → 486MB, because
--     the content lives once, in `memory_transcript_entries`.
--   * **Deletes.** FTS5 cannot index an UNINDEXED column, so removing one
--     source_id is a full scan of the index. Entries are deleted per source file
--     on re-import and on crash rollback — hundreds of rows at a time, each a
--     scan. Keyed on `content_rowid`, a delete is a rowid lookup.
--   * **Queries** came out 2–3x faster besides (45ms vs 72ms on "proxy port",
--     88ms vs 267ms on a term as common as "claudia").
--
-- Search still presents as one surface — `memory.search` fans out across both
-- indexes. The unification belongs at the query layer, not the storage layer.
--
-- ## What is indexed
--
-- Every user message, and assistant messages that carry prose. 148k of the 242k
-- assistant entries are the ingest's `[Used tools: Bash]` placeholder, which has
-- no searchable content and would otherwise be 55% of the index.
--
-- ## Immutability assumption
--
-- `memory_transcript_entries` is append-and-delete only — nothing updates
-- `content` in place — so there is no UPDATE trigger. An external-content index
-- would silently rot against in-place edits, so anything that starts updating
-- entries must add the trigger (or delete + reinsert) at the same time.

CREATE VIRTUAL TABLE IF NOT EXISTS memory_transcript_fts USING fts5(
  content,
  content='memory_transcript_entries',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- Backfill the existing corpus (~115k rows, a couple of seconds).
INSERT INTO memory_transcript_fts(rowid, content)
SELECT id, content
  FROM memory_transcript_entries
 WHERE role = 'user'
    OR (content NOT LIKE '[Used tools:%' AND length(content) > 40);

-- The WHEN clauses on these two triggers must stay identical. An external
-- content table tracks its own term counts, so issuing a 'delete' for a row that
-- was never inserted corrupts the index rather than being a no-op.

CREATE TRIGGER IF NOT EXISTS memory_transcript_fts_insert
AFTER INSERT ON memory_transcript_entries
WHEN new.role = 'user'
  OR (new.content NOT LIKE '[Used tools:%' AND length(new.content) > 40)
BEGIN
  INSERT INTO memory_transcript_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memory_transcript_fts_delete
AFTER DELETE ON memory_transcript_entries
WHEN old.role = 'user'
  OR (old.content NOT LIKE '[Used tools:%' AND length(old.content) > 40)
BEGIN
  INSERT INTO memory_transcript_fts(memory_transcript_fts, rowid, content)
  VALUES ('delete', old.id, old.content);
END;

-- Down
DROP TRIGGER IF EXISTS memory_transcript_fts_insert;
DROP TRIGGER IF EXISTS memory_transcript_fts_delete;
DROP TABLE IF EXISTS memory_transcript_fts;
