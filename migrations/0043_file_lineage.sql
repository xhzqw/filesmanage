-- Immutable conversion ancestry: one source per generated file, multiple children.
CREATE TABLE IF NOT EXISTS file_lineage (
  file_id text PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  -- Keep historical source IDs without blocking a permitted permanent purge.
  source_file_id text NOT NULL,
  source_file_name text NOT NULL,
  source_version_seq integer NOT NULL CHECK (source_version_seq > 0),
  relation_type text NOT NULL CHECK (relation_type IN ('docx_to_pdf','pdf_to_docx','seal_copy')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (file_id <> source_file_id)
);
CREATE INDEX IF NOT EXISTS idx_file_lineage_source ON file_lineage(source_file_id,created_at DESC);
