-- DHF V0.6.3: isolated submission journal and exact frozen file-version
-- references. No HTTP route / official approval / file issuance is enabled.
-- Existing file_versions are already immutable (0002_version_invariants.sql).
-- Blob storage GC coordination remains an explicit NO-GO before production.

-- Support a composite FK binding the referenced blob and digest to the
-- *same exact signed file version*. No name/current-latest lookup is allowed.
ALTER TABLE file_versions
 ADD CONSTRAINT uq_dhf_pinned_version
 UNIQUE (file_id,seq,blob_id,sha256);

CREATE TABLE dhf_pilot_submissions (
 id text PRIMARY KEY,
 attempt_id text NOT NULL UNIQUE,
 project_id text NOT NULL,
 stage_id text NOT NULL,
 template_id text NOT NULL,
 submitted_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
 request_sha char(64) NOT NULL CHECK (request_sha ~ '^[0-9a-f]{64}$'),
 policy_sha char(64) NOT NULL CHECK (policy_sha ~ '^[0-9a-f]{64}$'),
 manifest_sha char(64) NOT NULL CHECK (manifest_sha ~ '^[0-9a-f]{64}$'),
 submitted_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (project_id,stage_id,attempt_id)
   REFERENCES dhf_pilot_attempts(project_id,stage_id,id) ON DELETE RESTRICT,
 FOREIGN KEY (template_id,stage_id)
   REFERENCES dhf_pilot_templates(id,stage_id) ON DELETE RESTRICT,
 -- Idempotent retries may return the previous submission; the same key
 -- cannot silently submit another attempt with different parameters.
 UNIQUE (submitted_by,idempotency_key)
);
CREATE INDEX ix_dhf_pilot_submissions_stage
 ON dhf_pilot_submissions(project_id,stage_id,submitted_at DESC);

CREATE TABLE dhf_pilot_submission_evidence (
 submission_id text NOT NULL REFERENCES dhf_pilot_submissions(id) ON DELETE RESTRICT,
 requirement_id text NOT NULL,
 file_id text NOT NULL,
 version_seq integer NOT NULL CHECK (version_seq>0),
 blob_id text NOT NULL REFERENCES blobs(id) ON DELETE RESTRICT,
 sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY (submission_id,requirement_id),
 FOREIGN KEY (file_id,version_seq,blob_id,sha256)
   REFERENCES file_versions(file_id,seq,blob_id,sha256) ON DELETE RESTRICT
);
CREATE INDEX ix_dhf_pilot_evidence_file
 ON dhf_pilot_submission_evidence(file_id,version_seq);

-- This is an append-only journal; correcting evidence requires a NEW attempt.
CREATE FUNCTION dhf_pilot_reject_submission_mutation()
 RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'DHF submission evidence is append-only'
 USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER dhf_pilot_submission_immutable
 BEFORE UPDATE OR DELETE ON dhf_pilot_submissions
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_reject_submission_mutation();
CREATE TRIGGER dhf_pilot_evidence_immutable
 BEFORE UPDATE OR DELETE ON dhf_pilot_submission_evidence
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_reject_submission_mutation();

-- Require each recorded submission to correspond to a non-draft attempt.
-- This deferred check catches manual SQL attempts that insert a journal
-- without moving the attempt to submitted in the same transaction.
CREATE FUNCTION dhf_pilot_check_submission_attempt()
 RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_state text;
BEGIN
 SELECT state INTO current_state FROM dhf_pilot_attempts WHERE id=NEW.attempt_id;
 IF current_state IS DISTINCT FROM 'submitted' THEN
   RAISE EXCEPTION 'DHF submission must reference an attempt in submitted state'
   USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER dhf_pilot_submission_attempt_submitted
 AFTER INSERT ON dhf_pilot_submissions
 DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_check_submission_attempt();

-- No trigger grants published-template authority or stage approval.
-- Formal signature and blob physical-retention enforcement are future steps.
