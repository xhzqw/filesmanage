-- Stable global order for streamed exports and cross-folder listings (SPEC
-- DB-PERF-04): without it a 100k-row export sorts the whole joined result on
-- disk before the first row can be written.
CREATE INDEX IF NOT EXISTS ix_files_export_order ON files(updated_at DESC, id DESC) WHERE deleted_at IS NULL;
