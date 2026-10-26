-- DHF V0.7.3: evidence-coupled remediation reverification, not official
-- Stage Gate acceptance or enterprise-approved electronic signature.
-- The original return is an immutable reason. The new submission and all
-- new assigned reviewer opinions must be password-reauthenticated before
-- the ORIGINAL RETURN REVIEWER may attest the remediation closure.
CREATE TABLE dhf_pilot_remediation_verifications(
 id text PRIMARY KEY,
 case_id text NOT NULL UNIQUE REFERENCES dhf_pilot_remediation_cases(id) ON DELETE RESTRICT,
 original_return_attestation_id text NOT NULL REFERENCES dhf_pilot_review_attestations(id) ON DELETE RESTRICT,
 revised_submission_id text NOT NULL UNIQUE REFERENCES dhf_pilot_submissions(id) ON DELETE RESTRICT,
 verifier_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 comment text NOT NULL CHECK(length(btrim(comment)) BETWEEN 10 AND 2000),
 original_manifest_sha char(64) NOT NULL CHECK(original_manifest_sha ~ '^[0-9a-f]{64}$'),
 revised_manifest_sha char(64) NOT NULL CHECK(revised_manifest_sha ~ '^[0-9a-f]{64}$'),
 revised_policy_sha char(64) NOT NULL CHECK(revised_policy_sha ~ '^[0-9a-f]{64}$'),
 request_sha char(64) NOT NULL CHECK(request_sha ~ '^[0-9a-f]{64}$'),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 160),
 verification_method text NOT NULL DEFAULT 'password_reauthentication'
   CHECK(verification_method='password_reauthentication'),
 verified_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(verifier_id,idempotency_key),
 CHECK(original_manifest_sha<>revised_manifest_sha)
);
CREATE INDEX ix_dhf_pilot_remediation_verify_by_case
 ON dhf_pilot_remediation_verifications(case_id,verified_at DESC);

CREATE OR REPLACE FUNCTION dhf_pilot_validate_remediation_verification()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scope_ok boolean;
DECLARE expected_count integer;
DECLARE passed_count integer;
BEGIN
 SELECT (
  original_att.id=NEW.original_return_attestation_id
  AND original_att.review_decision_id=c.return_decision_id
  AND original_att.outcome='recommend_return'
  AND original_att.signer_id=NEW.verifier_id
  AND origin.reviewer_id=NEW.verifier_id
  AND origin.outcome='recommend_return'
  AND original_sub.id=c.original_submission_id
  AND original_sub.manifest_sha=c.original_manifest_sha
  AND c.original_manifest_sha=NEW.original_manifest_sha
  AND next_attempt.id=c.new_attempt_id
  AND next_attempt.state='submitted'
  AND next_attempt.manifest_sha=c.revised_manifest_sha
  AND next_sub.attempt_id=c.new_attempt_id
  AND next_sub.manifest_sha=c.revised_manifest_sha
  AND next_sub.manifest_sha=NEW.revised_manifest_sha
  AND next_sub.policy_sha=NEW.revised_policy_sha
  AND next_sub.project_id=c.project_id AND next_sub.stage_id=c.stage_id
  AND next_sub.template_id=c.template_id
  AND next_sub.submitted_by=c.opened_by
  AND original_sub.project_id=c.project_id AND original_sub.stage_id=c.stage_id
  AND original_sub.template_id=c.template_id
  AND project.state='active' AND base.active AND base.template_id=c.template_id
  AND policy.status='published' AND usr.disabled_at IS NULL AND NOT usr.must_change_password
  AND EXISTS (SELECT 1 FROM dhf_pilot_members member
    WHERE member.project_id=c.project_id AND member.user_id=NEW.verifier_id)
 ) INTO scope_ok
 FROM dhf_pilot_remediation_cases c
 JOIN dhf_pilot_review_decisions origin ON origin.id=c.return_decision_id
 JOIN dhf_pilot_review_attestations original_att
   ON original_att.review_decision_id=origin.id
 JOIN dhf_pilot_submissions original_sub ON original_sub.id=c.original_submission_id
 JOIN dhf_pilot_attempts next_attempt ON next_attempt.id=c.new_attempt_id
 JOIN dhf_pilot_submissions next_sub ON next_sub.id=NEW.revised_submission_id
 JOIN dhf_pilot_projects project ON project.id=c.project_id
 JOIN dhf_pilot_baselines base ON base.project_id=c.project_id AND base.stage_id=c.stage_id
 JOIN dhf_pilot_templates policy ON policy.id=c.template_id
 JOIN users usr ON usr.id=NEW.verifier_id
 WHERE c.id=NEW.case_id;
 IF scope_ok IS DISTINCT FROM TRUE THEN
  RAISE EXCEPTION 'DHF remediation closure must match signed original return and exact newly submitted corrected attempt'
    USING ERRCODE='23514';
 END IF;

 SELECT count(*),
   count(*) FILTER (WHERE t.status='reviewed' AND d.outcome='recommend_pass'
      AND att.outcome='recommend_pass' AND d.id=att.review_decision_id
      AND t.reviewer_id=att.signer_id AND att.policy_sha=NEW.revised_policy_sha
      AND att.manifest_sha=NEW.revised_manifest_sha)
 INTO expected_count,passed_count
 FROM dhf_pilot_review_obligations duty
 JOIN dhf_pilot_workbench_tasks t ON t.id=duty.task_id
 LEFT JOIN dhf_pilot_review_decisions d ON d.task_id=duty.task_id
 LEFT JOIN dhf_pilot_review_attestations att ON att.task_id=duty.task_id
 WHERE duty.submission_id=NEW.revised_submission_id;
 IF expected_count=0 OR expected_count<>passed_count OR
   expected_count<>(SELECT count(*) FROM dhf_pilot_workbench_tasks
     WHERE submission_id=NEW.revised_submission_id)
 THEN
   RAISE EXCEPTION 'DHF corrected submission is not fully reviewed and password-attested by every assigned reviewer'
    USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER dhf_pilot_remediation_verification_scope
 BEFORE INSERT ON dhf_pilot_remediation_verifications
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_validate_remediation_verification();

CREATE OR REPLACE FUNCTION dhf_pilot_require_verification_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM audit_events a
  WHERE a.event_type='dhf.pilot.remediation.verified'
    AND a.actor_id=NEW.verifier_id AND a.target_kind='dhf_remediation'
    AND a.target_id=NEW.case_id AND a.request_id=NEW.idempotency_key
    AND a.details->>'verificationId'=NEW.id
    AND a.details->>'revisedSubmissionId'=NEW.revised_submission_id
    AND a.details->>'revisedManifestSha'=NEW.revised_manifest_sha) THEN
   RAISE EXCEPTION 'DHF remediation verification must have atomic immutable audit record'
     USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER dhf_pilot_verification_audit_atomic
 AFTER INSERT ON dhf_pilot_remediation_verifications
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION dhf_pilot_require_verification_audit();

CREATE TRIGGER dhf_pilot_remediation_verification_immutable
 BEFORE UPDATE OR DELETE ON dhf_pilot_remediation_verifications
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_reject_submission_mutation();

-- Stage attempt/submission states remain unchanged; true final Gate will
-- require separately published corporate signature policy and CAS/outbox.
