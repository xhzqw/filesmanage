-- V0.8.0 slice 3: separated Stage Gate decision REVIEW, never an
-- approved, rejected or conditionally released enterprise Stage transition.
-- The actual corporate SOP/decision mandate is not configured. This
-- delegation is a restricted, independently audited PILOT reviewer role.
CREATE TABLE dhf_pilot_gate_decision_reviewer_grants (
 id text PRIMARY KEY,
 project_id text NOT NULL REFERENCES dhf_pilot_projects(id) ON DELETE RESTRICT,
 stage_id text NOT NULL CHECK(stage_id IN ('G5','G6')),
 reviewer_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 approved_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 authorization_ref text NOT NULL CHECK(length(btrim(authorization_ref)) BETWEEN 8 AND 512),
 valid_from timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 trial_only boolean NOT NULL DEFAULT true CHECK(trial_only),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 CHECK(reviewer_id<>approved_by),
 CHECK(valid_from<expires_at),
 CHECK(expires_at-valid_from<=interval '30 days'),
 UNIQUE(id,project_id,stage_id,reviewer_id)
);
CREATE INDEX ix_dhf_gate_decision_reviewer_scope
 ON dhf_pilot_gate_decision_reviewer_grants(reviewer_id,project_id,stage_id,expires_at);
CREATE TRIGGER dhf_pilot_gate_decision_reviewer_grant_immutable
 BEFORE UPDATE OR DELETE ON dhf_pilot_gate_decision_reviewer_grants
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_reject_submission_mutation();
CREATE FUNCTION dhf_pilot_decision_reviewer_grant_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM audit_events a WHERE
  a.actor_id=NEW.approved_by
  AND a.event_type='dhf.pilot.gate.decision_reviewer_granted'
  AND a.target_kind='dhf_gate_decision_reviewer'
  AND a.target_id=NEW.id
  AND a.details->>'reviewerId'=NEW.reviewer_id
  AND a.details->>'authorizationRef'=NEW.authorization_ref
  AND a.details->>'projectId'=NEW.project_id
  AND a.details->>'stageId'=NEW.stage_id) THEN
  RAISE EXCEPTION 'pilot Gate reviewer delegation requires independent exact audit'
   USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER dhf_gate_reviewer_grant_audit_required
 AFTER INSERT ON dhf_pilot_gate_decision_reviewer_grants
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION dhf_pilot_decision_reviewer_grant_audit();

CREATE TABLE dhf_pilot_gate_decision_reviewer_revocations (
 id text PRIMARY KEY,
 grant_id text NOT NULL UNIQUE REFERENCES dhf_pilot_gate_decision_reviewer_grants(id) ON DELETE RESTRICT,
 revoked_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 8 AND 1000),
 revoked_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
CREATE TRIGGER dhf_pilot_gate_decision_reviewer_revoke_immutable
 BEFORE UPDATE OR DELETE ON dhf_pilot_gate_decision_reviewer_revocations
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_reject_submission_mutation();
CREATE FUNCTION dhf_pilot_validate_gate_reviewer_revoke()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE approver text;
BEGIN
 SELECT approved_by INTO approver FROM dhf_pilot_gate_decision_reviewer_grants
 WHERE id=NEW.grant_id FOR UPDATE;
 IF approver IS NULL OR approver<>NEW.revoked_by THEN
  RAISE EXCEPTION 'only original independent approver may revoke pilot Gate reviewer'
  USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER dhf_pilot_gate_decision_reviewer_revoke_valid
 BEFORE INSERT ON dhf_pilot_gate_decision_reviewer_revocations
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_validate_gate_reviewer_revoke();
CREATE FUNCTION dhf_pilot_gate_reviewer_revoke_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM audit_events a
  WHERE a.actor_id=NEW.revoked_by
  AND a.event_type='dhf.pilot.gate.decision_reviewer_revoked'
  AND a.target_kind='dhf_gate_decision_reviewer'
  AND a.target_id=NEW.grant_id
  AND a.details->>'revokeId'=NEW.id) THEN
  RAISE EXCEPTION 'pilot Gate reviewer revocation must be independently audited'
   USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER dhf_gate_reviewer_revoke_audit_required
 AFTER INSERT ON dhf_pilot_gate_decision_reviewer_revocations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION dhf_pilot_gate_reviewer_revoke_audit();

-- Only the first pilot review disposition is recorded. Corrective evidence
-- uses the *existing* return/remediation/reverification system; this table
-- never modifies attempt or stage positions and grants no downstream actions.
CREATE TABLE dhf_pilot_gate_decision_review_opinions (
 id text PRIMARY KEY,
 review_id text NOT NULL UNIQUE REFERENCES dhf_pilot_stage_gate_review_intents(id) ON DELETE RESTRICT,
 grant_id text NOT NULL REFERENCES dhf_pilot_gate_decision_reviewer_grants(id) ON DELETE RESTRICT,
 reviewer_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 opinion text NOT NULL CHECK(opinion IN ('recommend_return','recommend_reject')),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 2000),
 source_graph_sha char(64) NOT NULL CHECK(source_graph_sha ~ '^[0-9a-f]{64}$'),
 source_candidate_sha char(64) NOT NULL CHECK(source_candidate_sha ~ '^[0-9a-f]{64}$'),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 160),
 request_sha char(64) NOT NULL CHECK(request_sha ~ '^[0-9a-f]{64}$'),
 trial_only boolean NOT NULL DEFAULT true CHECK(trial_only),
 state text NOT NULL DEFAULT 'recommendation_only'
  CHECK(state='recommendation_only'),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 UNIQUE(reviewer_id,idempotency_key),
 CHECK(opinion NOT IN ('approve','accepted','conditionally_released'))
);
CREATE TRIGGER dhf_pilot_gate_decision_review_opinion_immutable
 BEFORE UPDATE OR DELETE ON dhf_pilot_gate_decision_review_opinions
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_reject_submission_mutation();

CREATE FUNCTION dhf_pilot_require_independent_gate_opinion()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE permitted boolean;
BEGIN
 SELECT (
  r.state='awaiting_enterprise_authority' AND r.mode='strict' AND r.trial_only
  AND r.project_graph_sha=NEW.source_graph_sha
  AND r.candidate_payload_sha=NEW.source_candidate_sha
  AND g.project_id=r.project_id AND g.stage_id=r.stage_id
  AND g.reviewer_id=NEW.reviewer_id AND g.trial_only
  AND g.approved_by<>NEW.reviewer_id AND g.approved_by<>r.signer_id
  AND g.approved_by<>sub.submitted_by
  AND NEW.reviewer_id<>r.signer_id AND NEW.reviewer_id<>sub.submitted_by
  AND now()>=g.valid_from AND now()<g.expires_at
  AND u.disabled_at IS NULL AND NOT u.must_change_password
  AND approver.disabled_at IS NULL
  AND p.state='active'
  AND b.active AND b.template_id=r.template_id
  AND template.status='published' AND template.policy_sha=r.policy_sha
  AND NOT EXISTS(SELECT 1 FROM dhf_pilot_gate_decision_reviewer_revocations revoke
    WHERE revoke.grant_id=g.id)
  AND EXISTS(SELECT 1 FROM dhf_pilot_members m
    WHERE m.project_id=r.project_id AND m.user_id=NEW.reviewer_id)
 ) INTO permitted
 FROM dhf_pilot_stage_gate_review_intents r
 JOIN dhf_pilot_submissions sub ON sub.id=r.submission_id
 JOIN dhf_pilot_gate_decision_reviewer_grants g ON g.id=NEW.grant_id
 JOIN users u ON u.id=NEW.reviewer_id
 JOIN users approver ON approver.id=g.approved_by
 JOIN dhf_pilot_projects p ON p.id=r.project_id
 JOIN dhf_pilot_baselines b ON b.project_id=r.project_id AND b.stage_id=r.stage_id
 JOIN dhf_pilot_templates template ON template.id=r.template_id
 WHERE r.id=NEW.review_id
 FOR SHARE OF r,g;
 IF permitted IS DISTINCT FROM TRUE THEN
   RAISE EXCEPTION 'pilot Gate opinion requires independent active stage-scoped delegation'
    USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER dhf_pilot_gate_decision_opinion_identity_guard
 BEFORE INSERT ON dhf_pilot_gate_decision_review_opinions
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_require_independent_gate_opinion();

CREATE FUNCTION dhf_pilot_require_gate_decision_review_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM audit_events a WHERE
  a.actor_id=NEW.reviewer_id
  AND a.event_type='dhf.pilot.gate.decision_review_recommended'
  AND a.target_kind='dhf_gate_decision_review' AND a.target_id=NEW.id
  AND a.request_id=NEW.idempotency_key
  AND a.details->>'reviewId'=NEW.review_id
  AND a.details->>'graphSha'=NEW.source_graph_sha
  AND a.details->>'opinion'=NEW.opinion
  AND a.details->>'formalAccepted'='false')
  OR NOT EXISTS(SELECT 1 FROM outbox_jobs job
    WHERE job.id='dhf-gate-decision-review:'||NEW.id
    AND job.kind='dhf.pilot.gate.decision_review_recommended'
    AND job.payload->>'opinionId'=NEW.id
    AND job.payload->>'reviewId'=NEW.review_id
    AND job.payload->>'trialOnly'='true'
    AND job.payload->>'formalAccepted'='false') THEN
  RAISE EXCEPTION 'independent Gate review requires atomic exact audit and trial outbox'
   USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER dhf_pilot_gate_decision_review_audit_required
 AFTER INSERT ON dhf_pilot_gate_decision_review_opinions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION dhf_pilot_require_gate_decision_review_audit();
