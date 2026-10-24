-- V0.8.0, slice 1: immutable Stage Gate REVIEW INTAKE; NOT accepted.
-- The G1-G9 DAG is supplied by each published policy, never inferred from
-- stage number or copied from untrusted browser input.
CREATE TABLE dhf_pilot_stage_gate_review_intents(
 id text PRIMARY KEY,
 submission_id text NOT NULL UNIQUE REFERENCES dhf_pilot_submissions(id) ON DELETE RESTRICT,
 gate_candidate_id text NOT NULL UNIQUE REFERENCES dhf_pilot_gate_candidates(id) ON DELETE RESTRICT,
 attempt_id text NOT NULL REFERENCES dhf_pilot_attempts(id) ON DELETE RESTRICT,
 project_id text NOT NULL REFERENCES dhf_pilot_projects(id) ON DELETE RESTRICT,
 stage_id text NOT NULL CHECK(stage_id IN('G5','G6')),
 template_id text NOT NULL REFERENCES dhf_pilot_templates(id) ON DELETE RESTRICT,
 signer_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 mode text NOT NULL CHECK(mode IN('strict','conditional')),
 -- Never change this to 'accepted' without separate signed corporate
 -- authority and its independent state-transition migration.
 state text NOT NULL DEFAULT 'awaiting_enterprise_authority'
  CHECK(state='awaiting_enterprise_authority'),
 policy_sha char(64) NOT NULL CHECK(policy_sha ~ '^[a-f0-9]{64}$'),
 manifest_sha char(64) NOT NULL CHECK(manifest_sha ~ '^[a-f0-9]{64}$'),
 candidate_payload_sha char(64) NOT NULL CHECK(candidate_payload_sha ~ '^[a-f0-9]{64}$'),
 -- Exhaustive policy-defined direct dependency edges + observed positions.
 dependency_snapshot jsonb NOT NULL,
 dependency_snapshot_sha char(64) NOT NULL CHECK(dependency_snapshot_sha ~ '^[a-f0-9]{64}$'),
 missing_preconditions jsonb NOT NULL CHECK(jsonb_typeof(missing_preconditions)='array'),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 160),
 request_sha char(64) NOT NULL CHECK(request_sha ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 trial_only boolean NOT NULL DEFAULT true CHECK(trial_only),
 UNIQUE(signer_id,idempotency_key),
 CHECK(jsonb_typeof(dependency_snapshot)='array')
);
CREATE INDEX ix_dhf_gate_review_intents_project
 ON dhf_pilot_stage_gate_review_intents(project_id,stage_id,created_at DESC);
CREATE TRIGGER dhf_gate_review_intents_immutable BEFORE UPDATE OR DELETE
 ON dhf_pilot_stage_gate_review_intents FOR EACH ROW
 EXECUTE FUNCTION dhf_pilot_reject_submission_mutation();

CREATE FUNCTION dhf_pilot_validate_gate_review_intent()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE valid_source boolean;
DECLARE policy_json jsonb;
DECLARE expected_deps jsonb;
DECLARE expected_missing jsonb;
DECLARE required_total integer;
DECLARE passed_total integer;
BEGIN
 SELECT (
  c.id=NEW.gate_candidate_id
  AND c.submission_id=NEW.submission_id
  AND c.attempt_id=NEW.attempt_id
  AND c.project_id=NEW.project_id AND c.stage_id=NEW.stage_id
  AND c.template_id=NEW.template_id AND c.signer_id=NEW.signer_id
  AND c.policy_sha=NEW.policy_sha AND c.manifest_sha=NEW.manifest_sha
  AND c.decision_payload_sha=NEW.candidate_payload_sha
  AND s.attempt_id=c.attempt_id AND s.policy_sha=c.policy_sha AND s.manifest_sha=c.manifest_sha
  AND a.state='submitted' AND a.manifest_sha=s.manifest_sha
  AND project.state='active' AND base.active AND base.template_id=s.template_id
  AND template.status='published' AND template.policy_sha=s.policy_sha
  AND signer.disabled_at IS NULL AND NOT signer.must_change_password
  AND gate.review_key='__gate__' AND gate.reviewer_id=NEW.signer_id
  AND EXISTS(SELECT 1 FROM dhf_pilot_members member
   WHERE member.project_id=s.project_id AND member.user_id=NEW.signer_id)
 ), convert_from(template.policy_body,'UTF8')::jsonb
 INTO valid_source,policy_json
 FROM dhf_pilot_gate_candidates c
 JOIN dhf_pilot_submissions s ON s.id=c.submission_id
 JOIN dhf_pilot_attempts a ON a.id=c.attempt_id
 JOIN dhf_pilot_projects project ON project.id=s.project_id
 JOIN dhf_pilot_baselines base ON base.project_id=s.project_id AND base.stage_id=s.stage_id
 JOIN dhf_pilot_templates template ON template.id=c.template_id
 JOIN users signer ON signer.id=c.signer_id
 JOIN dhf_pilot_workbench_tasks gate
  ON gate.submission_id=s.id AND gate.review_key='__gate__'
 WHERE c.id=NEW.gate_candidate_id;
 IF valid_source IS DISTINCT FROM TRUE THEN
  RAISE EXCEPTION 'Gate review intent needs current assigned signed frozen Gate candidate'
  USING ERRCODE='23514'; END IF;
 -- Conditional approval is not a general-purpose bypass. No enterprise
 -- conditional grant contract has yet been published, so cannot request it.
 IF NEW.mode='conditional' THEN
  RAISE EXCEPTION 'conditional enterprise Stage Gate authorization not approved'
   USING ERRCODE='23514';
 END IF;
 IF jsonb_typeof(policy_json->'dependencies')<>'array' THEN
  RAISE EXCEPTION 'published template missing explicit dependency array'
   USING ERRCODE='23514'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object(
  'id',d.edge->>'ID','predecessorStage',d.edge->>'PredecessorStage',
  'guardedAction',d.edge->>'GuardedAction',
  'state',COALESCE(position.state,'preparing')
 ) ORDER BY d.edge->>'ID'), '[]'::jsonb)
 INTO expected_deps
 FROM jsonb_array_elements(policy_json->'dependencies') d(edge)
 LEFT JOIN dhf_pilot_stage_positions position
 ON position.project_id=NEW.project_id AND position.stage_id=d.edge->>'PredecessorStage';
 IF NEW.dependency_snapshot<>expected_deps THEN
  RAISE EXCEPTION 'Gate review dependency snapshot does not match every published-policy edge'
   USING ERRCODE='23514'; END IF;
 -- jsonb -> text is not immutable for PostgreSQL generated columns.
 -- Compute the canonical digest inside the guarded INSERT itself.
 NEW.dependency_snapshot_sha:=
  encode(sha256(convert_to(NEW.dependency_snapshot::text,'UTF8')),'hex');
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(expected_deps) d
   WHERE (d->>'id') IS NULL OR (d->>'predecessorStage') IS NULL
   OR d->>'predecessorStage'=NEW.stage_id
   OR d->>'predecessorStage' NOT IN('G1','G2','G3','G4','G5','G6','G7','G8','G9')) THEN
  RAISE EXCEPTION 'invalid or cyclic-self published Stage dependency' USING ERRCODE='23514';
 END IF;
 -- Exact review duties cannot be bypassed by skip-ahead intervention.
 SELECT count(*),count(*) FILTER(WHERE t.status='reviewed'
  AND decision.outcome='recommend_pass'
  AND att.outcome='recommend_pass' AND att.signer_id=t.reviewer_id
  AND att.review_decision_id=decision.id AND att.policy_sha=NEW.policy_sha
  AND att.manifest_sha=NEW.manifest_sha)
 INTO required_total,passed_total FROM dhf_pilot_review_obligations o
 JOIN dhf_pilot_workbench_tasks t ON t.id=o.task_id
 LEFT JOIN dhf_pilot_review_decisions decision ON decision.task_id=t.id
 LEFT JOIN dhf_pilot_review_attestations att ON att.task_id=t.id
 WHERE o.submission_id=NEW.submission_id;
 IF required_total=0 OR required_total<>passed_total OR
  required_total<>(SELECT count(*) FROM dhf_pilot_workbench_tasks
   WHERE submission_id=NEW.submission_id) THEN
  RAISE EXCEPTION 'Gate review cannot erase outstanding reviewer responsibility'
   USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM dhf_pilot_remediation_cases c
  LEFT JOIN dhf_pilot_remediation_verifications verified ON verified.case_id=c.id
  WHERE c.project_id=NEW.project_id AND c.stage_id=NEW.stage_id
  AND (verified.id IS NULL OR
    (c.new_attempt_id=NEW.attempt_id AND verified.revised_submission_id<>NEW.submission_id))) THEN
  RAISE EXCEPTION 'Gate review requires independently verified correction closure'
   USING ERRCODE='23514'; END IF;
 -- Current pilot stage positions cannot be accepted (migration 0043).
 -- Include those blocked edges *as blockers*, not authorizations.
 SELECT COALESCE(jsonb_agg(x.reason ORDER BY x.reason),'[]'::jsonb)
 INTO expected_missing FROM (
  SELECT DISTINCT 'UNACCEPTED_PREDECESSOR:'||(d->>'predecessorStage') AS reason
  FROM jsonb_array_elements(expected_deps) d WHERE d->>'state'<>'accepted'
 ) x;
 expected_missing:=expected_missing||'["ENTERPRISE_GATE_AUTHORITY_NOT_APPROVED"]'::jsonb;
 IF NEW.missing_preconditions<>expected_missing THEN
  RAISE EXCEPTION 'Gate review precondition snapshot mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER dhf_pilot_gate_review_intent_check
 BEFORE INSERT ON dhf_pilot_stage_gate_review_intents
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_validate_gate_review_intent();

CREATE FUNCTION dhf_pilot_gate_review_intent_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM audit_events e
  WHERE e.actor_id=NEW.signer_id AND e.event_type='dhf.pilot.gate.review_requested'
  AND e.target_kind='dhf_stage_gate_review' AND e.target_id=NEW.id
  AND e.request_id=NEW.idempotency_key
  AND e.details->>'dependencySnapshotSha'=NEW.dependency_snapshot_sha
  AND e.details->>'candidateId'=NEW.gate_candidate_id
  AND e.details->>'formalAccepted'='false')
  OR NOT EXISTS(SELECT 1 FROM outbox_jobs job
   WHERE job.id='dhf-gate-review:'||NEW.id AND job.kind='dhf.pilot.gate.review_requested'
   AND job.payload->>'reviewId'=NEW.id AND job.payload->>'candidateId'=NEW.gate_candidate_id
   AND job.payload->>'trialOnly'='true'
   AND job.payload->>'formalAccepted'='false') THEN
  RAISE EXCEPTION 'Gate review requires atomic exact audit and pilot-only outbox'
   USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER dhf_pilot_gate_review_intent_audit_required
 AFTER INSERT ON dhf_pilot_stage_gate_review_intents
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION dhf_pilot_gate_review_intent_audit();
