-- DHF V0.6.4: submission-to-attempt completeness and DB-level Blob GC fence.
-- Pilot-only. This is NOT a physical BlobStore retention guarantee: external
-- object deletion must still honor the same hold protocol before activation.
--
-- 0044 already enforces submission -> submitted attempt. This adds the reverse
-- invariant (submitted attempt -> exactly one submission) at COMMIT time.
CREATE OR REPLACE FUNCTION dhf_pilot_require_submission_for_submitted_attempt()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state = 'submitted' AND NOT EXISTS (
    SELECT 1 FROM dhf_pilot_submissions WHERE attempt_id=NEW.id
 ) THEN
    RAISE EXCEPTION 'submitted DHF attempt requires immutable submission journal'
      USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER dhf_pilot_attempt_submission_complete
 AFTER INSERT OR UPDATE OF state ON dhf_pilot_attempts
 DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_require_submission_for_submitted_attempt();

-- The pilot cannot produce any formally reviewed or accepted stage. Keep
-- these transitions impossible even for direct database writes until an
-- authorized, independently audited decision aggregate is implemented.
ALTER TABLE dhf_pilot_attempts
 ADD CONSTRAINT ck_dhf_pilot_attempt_preapproval_only
 CHECK (state IN ('preparing','submitted','cancelled'));

-- A durable evidence reference is a database-level hold. Do not let a Blob
-- referenced by any immutable DHF submission be deleted or marked for GC.
-- 0044 holds the Blob row FOR SHARE before inserting the reference. GC state
-- transitions must acquire a conflicting UPDATE lock and evaluate this guard.
CREATE OR REPLACE FUNCTION dhf_pilot_block_referenced_blob_gc()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE held boolean;
BEGIN
 IF TG_OP = 'UPDATE' AND NEW.state = 'ready' THEN
   RETURN NEW;
 END IF;
 SELECT EXISTS (
    SELECT 1 FROM dhf_pilot_submission_evidence WHERE blob_id = OLD.id
 ) INTO held;
 IF held THEN
   RAISE EXCEPTION 'DHF evidence Blob is retained by an immutable submission'
     USING ERRCODE='23514';
 END IF;
 IF TG_OP = 'DELETE' THEN
   RETURN OLD;
 END IF;
 RETURN NEW;
END;
$$;

CREATE TRIGGER dhf_pilot_blob_gc_fence
 BEFORE UPDATE OF state OR DELETE ON blobs
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_block_referenced_blob_gc();

CREATE INDEX ix_dhf_pilot_evidence_blob
 ON dhf_pilot_submission_evidence(blob_id);

-- Enforced DB invariants:
-- (1) Journal insert + attempt state change must commit together.
-- (2) A persisted submission prevents Blob state='gc_pending' / Blob DELETE.
-- (3) Stage approval/review transitions remain unavailable in this pilot.
-- Still missing: physical BlobStore mark/sweep cooperation and signed Gate.
