-- v2.1 immutable signed versions + monotonic current pointer.
-- Schema objects belong to the dedicated filesmanage_v21 database only.
ALTER TABLE file_versions
  ADD CONSTRAINT fk_rollback_target
  FOREIGN KEY(file_id,rollback_target_seq)
  REFERENCES file_versions(file_id,seq)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE file_versions
  ADD CONSTRAINT fk_rollback_from
  FOREIGN KEY(file_id,rollback_from_seq)
  REFERENCES file_versions(file_id,seq)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE file_versions
  ADD CONSTRAINT chk_version_digest
  CHECK (sha256 ~ '^[0-9a-f]{64}$');

CREATE OR REPLACE FUNCTION prevent_signed_version_mutation()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'signed file versions are immutable; append a new version instead'
    USING ERRCODE='23514';
END $$;

CREATE TRIGGER trg_versions_immutable
  BEFORE UPDATE OR DELETE ON file_versions
  FOR EACH ROW EXECUTE FUNCTION prevent_signed_version_mutation();

CREATE OR REPLACE FUNCTION enforce_current_version_monotonic()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.current_version_seq IS NOT NULL AND
     (NEW.current_version_seq IS NULL OR NEW.current_version_seq < OLD.current_version_seq)
  THEN
    RAISE EXCEPTION 'current version cannot move backwards; use append-only rollback'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_current_version_monotonic
  BEFORE UPDATE OF current_version_seq ON files
  FOR EACH ROW EXECUTE FUNCTION enforce_current_version_monotonic();
