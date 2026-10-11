-- Business retention is a deletion/unarchive protection, not legal hold or WORM.
ALTER TABLE file_lifecycle ADD COLUMN retention_until timestamptz;
CREATE INDEX ix_lifecycle_retention ON file_lifecycle(retention_until) WHERE retention_until IS NOT NULL;

-- Durable, duplicate-free delivery per due date and phase; no external messages.
CREATE TABLE lifecycle_notifications(
 id bigserial PRIMARY KEY,
 file_id text NOT NULL REFERENCES files(id) ON DELETE CASCADE,
 recipient_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 due_at timestamptz NOT NULL,
 kind text NOT NULL CHECK(kind IN('soon','overdue')),
 read_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(file_id,recipient_id,due_at,kind)
);
CREATE INDEX ix_lifecycle_notifications_user ON lifecycle_notifications(recipient_id,id DESC);

-- Fail closed for recursive folder trash (bypasses file handlers). The main
-- application returns a readable 409 before attempting folder operations.
CREATE FUNCTION forbid_protected_file_trash() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL AND EXISTS (
  SELECT 1 FROM file_lifecycle l WHERE l.file_id=OLD.id
  AND (l.state='archived' OR l.retention_until>now())
 ) THEN
  RAISE EXCEPTION 'file has lifecycle archive or retention protection' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trg_file_retention_guard BEFORE UPDATE OF deleted_at ON files
 FOR EACH ROW EXECUTE FUNCTION forbid_protected_file_trash();
