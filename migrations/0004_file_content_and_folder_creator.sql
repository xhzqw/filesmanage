-- Milestone 2 additions: file content type and folder creator for audit.
-- Idempotent-safe: column existence is checked before each ALTER.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='files' AND column_name='content_type') THEN
    ALTER TABLE files ADD COLUMN content_type text NOT NULL DEFAULT '';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='folders' AND column_name='created_by') THEN
    ALTER TABLE folders ADD COLUMN created_by text REFERENCES users(id);
    UPDATE folders SET created_by=owner_id WHERE created_by IS NULL;
  END IF;
END
$$;

-- File listing inside one folder already covered by ix_files_page; keep name
-- lookups for restore conflict checks cheap.
CREATE INDEX IF NOT EXISTS ix_files_folder_name ON files(folder_id,name) WHERE deleted_at IS NULL;
