-- DHF V0.7.2: password-reauthenticated, immutable identity ATTESTATIONS.
-- Does NOT represent a qualified e-signature, CMS/PAdES, corporate Gate
-- acceptance, CDW controlled issuance or conditional release.
CREATE TABLE dhf_pilot_review_attestations(
 id text PRIMARY KEY,
 review_decision_id text NOT NULL UNIQUE REFERENCES dhf_pilot_review_decisions(id) ON DELETE RESTRICT,
 task_id text NOT NULL UNIQUE REFERENCES dhf_pilot_review_obligations(task_id) ON DELETE RESTRICT,
 submission_id text NOT NULL REFERENCES dhf_pilot_submissions(id) ON DELETE RESTRICT,
 signer_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 outcome text NOT NULL CHECK(outcome IN ('recommend_pass','recommend_return')),
 sign_intent text NOT NULL CHECK(sign_intent='I confirm this DHF review opinion and its fixed evidence identity'),
 auth_method text NOT NULL DEFAULT 'password_reauthentication'
   CHECK(auth_method='password_reauthentication'),
 policy_sha char(64) NOT NULL CHECK(policy_sha ~ '^[0-9a-f]{64}$'),
 manifest_sha char(64) NOT NULL CHECK(manifest_sha ~ '^[0-9a-f]{64}$'),
 content_sha char(64) NOT NULL CHECK(content_sha ~ '^[0-9a-f]{64}$'),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 160),
 request_sha char(64) NOT NULL CHECK(request_sha ~ '^[0-9a-f]{64}$'),
 authenticated_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(signer_id,idempotency_key)
);
CREATE INDEX ix_dhf_review_attestations_submission ON dhf_pilot_review_attestations(submission_id,created_at);

CREATE OR REPLACE FUNCTION dhf_pilot_verify_review_attestation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE valid boolean;
DECLARE n_prior integer;
BEGIN
 SELECT (
  d.id=NEW.review_decision_id AND d.task_id=NEW.task_id
  AND d.submission_id=NEW.submission_id AND d.reviewer_id=NEW.signer_id
  AND d.outcome=NEW.outcome AND d.policy_sha=NEW.policy_sha
  AND d.manifest_sha=NEW.manifest_sha
  AND t.reviewer_id=NEW.signer_id
  AND t.status=(CASE WHEN d.outcome='recommend_pass' THEN 'reviewed' ELSE 'returned' END)
  AND s.policy_sha=NEW.policy_sha AND s.manifest_sha=NEW.manifest_sha
  AND s.submitted_by<>NEW.signer_id
  AND o.reviewer_id=NEW.signer_id AND o.submission_id=s.id
  AND project.state='active' AND baseline.active AND baseline.template_id=s.template_id
  AND pol.status='published' AND actor.disabled_at IS NULL
  AND NOT actor.must_change_password
  AND EXISTS(SELECT 1 FROM dhf_pilot_members member
   WHERE member.project_id=s.project_id AND member.user_id=NEW.signer_id)
 ) INTO valid
 FROM dhf_pilot_review_decisions d
 JOIN dhf_pilot_workbench_tasks t ON t.id=d.task_id
 JOIN dhf_pilot_review_obligations o ON o.task_id=t.id
 JOIN dhf_pilot_submissions s ON s.id=d.submission_id
 JOIN dhf_pilot_projects project ON project.id=s.project_id
 JOIN dhf_pilot_baselines baseline ON baseline.project_id=s.project_id AND baseline.stage_id=s.stage_id
 JOIN dhf_pilot_templates pol ON pol.id=s.template_id
 JOIN users actor ON actor.id=NEW.signer_id
 WHERE d.id=NEW.review_decision_id;
 IF valid IS DISTINCT FROM TRUE THEN
  RAISE EXCEPTION 'DHF authenticated review must match assigned original reviewed task and active baseline'
   USING ERRCODE='23514';
 END IF;
 -- Every signed passed G5 Gate opinion requires prior authenticated
 -- professional attestations, not merely old non-signing recommendations.
 SELECT count(*) INTO n_prior
 FROM dhf_pilot_review_obligations before
 JOIN dhf_pilot_review_obligations target ON target.task_id=NEW.task_id
 LEFT JOIN dhf_pilot_review_attestations att ON att.task_id=before.task_id AND att.outcome='recommend_pass'
 WHERE before.submission_id=NEW.submission_id
   AND before.step_ordinal<target.step_ordinal AND att.id IS NULL;
 IF n_prior>0 AND (
  (SELECT review_key FROM dhf_pilot_review_obligations WHERE task_id=NEW.task_id)='__gate__'
  OR NOT EXISTS (SELECT 1 FROM dhf_pilot_early_interventions sponsor
      WHERE sponsor.target_task_id=NEW.task_id AND sponsor.submission_id=NEW.submission_id
        AND sponsor.policy_sha=NEW.policy_sha AND sponsor.manifest_sha=NEW.manifest_sha)
 ) THEN
  RAISE EXCEPTION 'DHF signoff predecessor attestation is still outstanding; early intervention never waives Gate'
    USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER dhf_pilot_attestation_identity
 BEFORE INSERT ON dhf_pilot_review_attestations
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_verify_review_attestation();

CREATE OR REPLACE FUNCTION dhf_pilot_attestation_require_audit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM audit_events a WHERE
   a.event_type='dhf.pilot.review_attested' AND a.actor_id=NEW.signer_id
   AND a.target_kind='dhf_review_task' AND a.target_id=NEW.task_id
   AND a.request_id=NEW.idempotency_key
   AND a.details->>'attestationId'=NEW.id
   AND a.details->>'contentSha'=NEW.content_sha
 ) THEN
   RAISE EXCEPTION 'DHF password-authenticated review must atomically carry its own audit record'
   USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER dhf_pilot_attestation_audit_required
 AFTER INSERT ON dhf_pilot_review_attestations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dhf_pilot_attestation_require_audit();

CREATE TRIGGER dhf_pilot_attestation_immutable
 BEFORE UPDATE OR DELETE ON dhf_pilot_review_attestations
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_reject_submission_mutation();
