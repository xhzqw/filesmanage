-- DHF V0.7.4: immutable CRYPTOGRAPHICALLY ATTESTED PILOT Gate candidate.
-- Not qualified legal signature, accepted stage, controlled distribution,
-- department receipt, or enterprise policy approval. Keep stage positions
-- accepted-forbidden: DB migration does NOT weaken original constraints.
CREATE TABLE dhf_pilot_gate_candidates (
 id text PRIMARY KEY,
 submission_id text NOT NULL UNIQUE REFERENCES dhf_pilot_submissions(id) ON DELETE RESTRICT,
 attempt_id text NOT NULL REFERENCES dhf_pilot_attempts(id) ON DELETE RESTRICT,
 project_id text NOT NULL REFERENCES dhf_pilot_projects(id) ON DELETE RESTRICT,
 stage_id text NOT NULL CHECK(stage_id IN ('G5','G6')),
 template_id text NOT NULL REFERENCES dhf_pilot_templates(id) ON DELETE RESTRICT,
 gate_attestation_id text NOT NULL UNIQUE REFERENCES dhf_pilot_review_attestations(id) ON DELETE RESTRICT,
 signer_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 policy_sha char(64) NOT NULL CHECK(policy_sha ~ '^[0-9a-f]{64}$'),
 manifest_sha char(64) NOT NULL CHECK(manifest_sha ~ '^[0-9a-f]{64}$'),
 decision_payload_sha char(64) NOT NULL CHECK(decision_payload_sha ~ '^[0-9a-f]{64}$'),
 trusted_key_sha char(64) NOT NULL CHECK(trusted_key_sha ~ '^[0-9a-f]{64}$'),
 trusted_public_key_ed25519 bytea NOT NULL CHECK(octet_length(trusted_public_key_ed25519)=32),
 signature_ed25519 bytea NOT NULL CHECK(octet_length(signature_ed25519)=64),
 verdict text NOT NULL DEFAULT 'trial_candidate' CHECK(verdict='trial_candidate'),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 160),
 request_sha char(64) NOT NULL CHECK(request_sha ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(project_id,stage_id),
 UNIQUE(signer_id,idempotency_key)
);
CREATE OR REPLACE FUNCTION dhf_pilot_check_gate_candidate()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE valid boolean;
DECLARE total integer;
DECLARE fully_signed integer;
BEGIN
 SELECT (
  s.id=NEW.submission_id AND s.attempt_id=NEW.attempt_id
  AND s.project_id=NEW.project_id AND s.stage_id=NEW.stage_id
  AND s.template_id=NEW.template_id
  AND s.policy_sha=NEW.policy_sha AND s.manifest_sha=NEW.manifest_sha
  AND a.state='submitted' AND a.manifest_sha=s.manifest_sha
  AND p.state='active' AND baseline.active AND baseline.template_id=s.template_id
  AND template.status='published' AND template.policy_sha=NEW.policy_sha
  AND s.submitted_by<>NEW.signer_id
  AND t.reviewer_id=NEW.signer_id AND t.status='reviewed'
  AND t.review_key='__gate__' AND t.submission_id=NEW.submission_id
  AND signer.id=NEW.signer_id AND signer.disabled_at IS NULL AND NOT signer.must_change_password
  AND att.id=NEW.gate_attestation_id AND att.task_id=t.id
  AND att.signer_id=NEW.signer_id AND att.outcome='recommend_pass'
  AND att.policy_sha=NEW.policy_sha AND att.manifest_sha=NEW.manifest_sha
  AND gate_dec.id=att.review_decision_id AND gate_dec.outcome='recommend_pass'
  AND EXISTS(SELECT 1 FROM dhf_pilot_members member
    WHERE member.project_id=s.project_id AND member.user_id=NEW.signer_id)
 ) INTO valid
 FROM dhf_pilot_submissions s
 JOIN dhf_pilot_attempts a ON a.id=s.attempt_id
 JOIN dhf_pilot_projects p ON p.id=s.project_id
 JOIN dhf_pilot_baselines baseline ON baseline.project_id=s.project_id AND baseline.stage_id=s.stage_id
 JOIN dhf_pilot_templates template ON template.id=s.template_id
 JOIN dhf_pilot_workbench_tasks t ON t.submission_id=s.id AND t.review_key='__gate__'
 JOIN dhf_pilot_review_attestations att ON att.task_id=t.id
 JOIN dhf_pilot_review_decisions gate_dec ON gate_dec.id=att.review_decision_id
 JOIN users signer ON signer.id=NEW.signer_id
 WHERE s.id=NEW.submission_id;
 IF valid IS DISTINCT FROM TRUE THEN
  RAISE EXCEPTION 'DHF pilot Gate candidate requires frozen signed final reviewer and active published baseline'
   USING ERRCODE='23514';
 END IF;
 SELECT count(*),count(*) FILTER(WHERE t.status='reviewed' AND d.outcome='recommend_pass'
    AND att.outcome='recommend_pass' AND att.review_decision_id=d.id
    AND att.signer_id=t.reviewer_id AND att.policy_sha=NEW.policy_sha
    AND att.manifest_sha=NEW.manifest_sha)
 INTO total,fully_signed
 FROM dhf_pilot_review_obligations o
 JOIN dhf_pilot_workbench_tasks t ON t.id=o.task_id
 LEFT JOIN dhf_pilot_review_decisions d ON d.task_id=t.id
 LEFT JOIN dhf_pilot_review_attestations att ON att.task_id=t.id
 WHERE o.submission_id=NEW.submission_id;
 IF total<1 OR total<>fully_signed OR
   total<>(SELECT count(*) FROM dhf_pilot_workbench_tasks WHERE submission_id=NEW.submission_id)
 THEN
  RAISE EXCEPTION 'DHF pilot Gate candidate has unsigned, returned or missing reviewer responsibilities'
   USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM dhf_pilot_remediation_cases c
  LEFT JOIN dhf_pilot_remediation_verifications v ON v.case_id=c.id
  WHERE c.project_id=NEW.project_id AND c.stage_id=NEW.stage_id AND v.id IS NULL)
 OR EXISTS(SELECT 1 FROM dhf_pilot_remediation_cases c
  LEFT JOIN dhf_pilot_remediation_verifications v ON v.case_id=c.id
  WHERE c.new_attempt_id=NEW.attempt_id AND (v.id IS NULL OR v.revised_submission_id<>NEW.submission_id))
 THEN
  RAISE EXCEPTION 'DHF pilot Gate candidate blocked by outstanding original return responsibility or corrective reverification'
   USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER dhf_pilot_gate_candidate_source
 BEFORE INSERT ON dhf_pilot_gate_candidates FOR EACH ROW
 EXECUTE FUNCTION dhf_pilot_check_gate_candidate();
CREATE TRIGGER dhf_pilot_gate_candidate_immutable
 BEFORE UPDATE OR DELETE ON dhf_pilot_gate_candidates
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_reject_submission_mutation();

CREATE OR REPLACE FUNCTION dhf_pilot_require_gate_candidate_atomic()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM audit_events e
    WHERE e.actor_id=NEW.signer_id AND e.event_type='dhf.pilot.gate.candidate'
    AND e.target_kind='dhf_gate_candidate' AND e.target_id=NEW.id
    AND e.request_id=NEW.idempotency_key
    AND e.details->>'decisionSha'=NEW.decision_payload_sha
    AND e.details->>'submissionId'=NEW.submission_id)
 OR NOT EXISTS (SELECT 1 FROM outbox_jobs q
    WHERE q.id='dhf-gate-candidate:'||NEW.id
    AND q.kind='dhf.pilot.gate.candidate'
    AND q.payload->>'candidateId'=NEW.id
    AND q.payload->>'decisionSha'=NEW.decision_payload_sha
    AND q.payload->>'submissionId'=NEW.submission_id)
 THEN
   RAISE EXCEPTION 'DHF signed Gate candidate must atomically append audit and trial-only outbox'
   USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER dhf_pilot_gate_candidate_audit_outbox
 AFTER INSERT ON dhf_pilot_gate_candidates
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION dhf_pilot_require_gate_candidate_atomic();

-- Critically, no UPDATE to dhf_pilot_stage_positions, attempts, CDW,
-- seals or organization distribution/receipt lifecycle is allowed here.
