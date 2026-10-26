-- DHF V0.6.5: a durable frozen evidence reference also freezes the
-- immutable Blob locator and digest/size metadata. A SQL status-only GC fence
-- (0045) would otherwise allow moving storage_key after a DHF submission.
--
-- Physical files may still be deleted outside PostgreSQL by privileged
-- operators; production release requires a separately authorized filesystem
-- and backup/restore retention policy. No ready-blob deletion API is added.
CREATE OR REPLACE FUNCTION dhf_pilot_protect_referenced_blob_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (
   NEW.storage_key IS DISTINCT FROM OLD.storage_key OR
   NEW.sha256 IS DISTINCT FROM OLD.sha256 OR
   NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
 ) AND EXISTS (
   SELECT 1 FROM dhf_pilot_submission_evidence WHERE blob_id = OLD.id
 ) THEN
   RAISE EXCEPTION 'DHF evidence Blob locator, digest and size are immutable'
      USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

CREATE TRIGGER dhf_pilot_blob_identity_immutable
 BEFORE UPDATE OF storage_key,sha256,size_bytes ON blobs
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_protect_referenced_blob_identity();
