-- Accelerator for Unicode/CJK file and folder name substring search.
-- No search data is copied to a separate, eventually consistent index: GIN
-- is maintained transactionally with file/folder renames and deletion.
-- Existing file_text.tsv GIN remains the source of full-text matches.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX ix_files_active_name_trgm ON files USING gin (name gin_trgm_ops)
 WHERE deleted_at IS NULL;
CREATE INDEX ix_folders_active_name_trgm ON folders USING gin (name gin_trgm_ops)
 WHERE deleted_at IS NULL;
