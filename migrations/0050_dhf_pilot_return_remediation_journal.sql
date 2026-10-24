-- DHF V0.7.0 — remediation of a returned PILOT review.
-- One corrective preparation branch per original submission. Multiple returned
-- reviewer opinions remain discoverable through the original submission ID.
-- Immutable trace: recommendation -> case -> new preparing attempt -> optional
-- later submission. An "opened" case NEVER means remediation closed or a
-- formal Gate has passed. No change to CDW issuance / accepted stage states.
CREATE TABLE dhf_pilot_remediation_cases (
 id text PRIMARY KEY,
 return_decision_id text NOT NULL UNIQUE
   REFERENCES dhf_pilot_review_decisions(id) ON DELETE RESTRICT,
 original_submission_id text NOT NULL UNIQUE REFERENCES dhf_pilot_submissions(id) ON DELETE RESTRICT,
 new_attempt_id text NOT NULL UNIQUE,
 project_id text NOT NULL,
 stage_id text NOT NULL,
 template_id text NOT NULL,
 opened_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 resolution_plan text NOT NULL CHECK(length(btrim(resolution_plan)) BETWEEN 10 AND 2000),
 original_manifest_sha char(64) NOT NULL CHECK(original_manifest_sha ~ '^[0-9a-f]{64}$'),
 revised_manifest_sha char(64) NOT NULL CHECK(revised_manifest_sha ~ '^[0-9a-f]{64}$'),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 160),
 request_sha char(64) NOT NULL CHECK(request_sha ~ '^[0-9a-f]{64}$'),
 opened_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(opened_by,idempotency_key),
 FOREIGN KEY(project_id,stage_id,new_attempt_id)
   REFERENCES dhf_pilot_attempts(project_id,stage_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(project_id,stage_id,template_id)
   REFERENCES dhf_pilot_baselines(project_id,stage_id,template_id) ON DELETE RESTRICT,
 CHECK(original_manifest_sha<>revised_manifest_sha)
);
CREATE INDEX ix_dhf_pilot_remediation_project
 ON dhf_pilot_remediation_cases(project_id,stage_id,opened_at DESC);

CREATE TABLE dhf_pilot_remediation_events (
 id text PRIMARY KEY,
 case_id text NOT NULL REFERENCES dhf_pilot_remediation_cases(id) ON DELETE RESTRICT,
 kind text NOT NULL CHECK(kind='opened'),
 actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 request_sha char(64) NOT NULL CHECK(request_sha ~ '^[0-9a-f]{64}$'),
 happened_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(case_id,kind)
);

CREATE OR REPLACE FUNCTION dhf_pilot_check_remediation_origin()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE valid boolean;
BEGIN
 SELECT (
   d.outcome='recommend_return' AND d.submission_id=NEW.original_submission_id
   AND d.policy_sha=t.policy_sha
   AND d.manifest_sha=NEW.original_manifest_sha
   AND s.project_id=NEW.project_id AND s.stage_id=NEW.stage_id
   AND s.template_id=NEW.template_id AND s.submitted_by=NEW.opened_by
   AND src.id=s.attempt_id AND src.state='submitted'
   AND revised.id=NEW.new_attempt_id AND revised.state='preparing'
   AND revised.project_id=s.project_id AND revised.stage_id=s.stage_id
   AND revised.template_id=s.template_id AND revised.created_by=NEW.opened_by
   AND revised.manifest_sha=NEW.revised_manifest_sha
   AND convert_from(revised.manifest_body,'UTF8')::jsonb->'requirements'
      IS DISTINCT FROM convert_from(src.manifest_body,'UTF8')::jsonb->'requirements'
   AND p.state='active' AND b.active AND m.can_prepare
   AND u.disabled_at IS NULL AND t.status='published'
 ) INTO valid
 FROM dhf_pilot_review_decisions d
 JOIN dhf_pilot_submissions s ON s.id=d.submission_id
 JOIN dhf_pilot_attempts src ON src.id=s.attempt_id
 JOIN dhf_pilot_attempts revised ON revised.id=NEW.new_attempt_id
 JOIN dhf_pilot_projects p ON p.id=s.project_id
 JOIN dhf_pilot_baselines b ON b.project_id=s.project_id AND b.stage_id=s.stage_id
  AND b.template_id=s.template_id
 JOIN dhf_pilot_templates t ON t.id=s.template_id
 JOIN dhf_pilot_members m ON m.project_id=s.project_id AND m.user_id=NEW.opened_by
 JOIN users u ON u.id=NEW.opened_by
 WHERE d.id=NEW.return_decision_id;
 IF valid IS DISTINCT FROM TRUE THEN
   RAISE EXCEPTION 'DHF remediation must reference own returned review, active policy and changed preparing manifest'
      USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER dhf_pilot_remediation_origin
 BEFORE INSERT ON dhf_pilot_remediation_cases
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_check_remediation_origin();

CREATE OR REPLACE FUNCTION dhf_pilot_check_remediation_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM dhf_pilot_remediation_cases c
   WHERE c.id=NEW.case_id AND c.opened_by=NEW.actor_id AND c.request_sha=NEW.request_sha
 ) THEN
   RAISE EXCEPTION 'DHF remediation event actor/hash inconsistent'
     USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER dhf_pilot_remediation_event_origin
 BEFORE INSERT ON dhf_pilot_remediation_events
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_check_remediation_event();

CREATE OR REPLACE FUNCTION dhf_pilot_remediation_require_open_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM dhf_pilot_remediation_events e
   WHERE e.case_id=NEW.id AND e.kind='opened' AND e.actor_id=NEW.opened_by) THEN
   RAISE EXCEPTION 'DHF remediation case must atomically commit opened event'
     USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER dhf_pilot_remediation_event_atomic
 AFTER INSERT ON dhf_pilot_remediation_cases
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION dhf_pilot_remediation_require_open_event();

-- An attempt is normally editable while preparing; after opening an
-- immutable remediation case its snapshot hash is a recorded audit fact.
-- Freeze identity immediately even though the new attempt has not submitted.
CREATE OR REPLACE FUNCTION dhf_pilot_guard_linked_remediation_attempt()
RETURNS trigger LANGUAGE plpgsql AS $
BEGIN
 IF EXISTS(SELECT 1 FROM dhf_pilot_remediation_cases
   WHERE new_attempt_id=OLD.id)
 AND (
    NEW.manifest_body IS DISTINCT FROM OLD.manifest_body OR
    NEW.manifest_sha IS DISTINCT FROM OLD.manifest_sha OR
    NEW.project_id IS DISTINCT FROM OLD.project_id OR
    NEW.stage_id IS DISTINCT FROM OLD.stage_id OR
    NEW.template_id IS DISTINCT FROM OLD.template_id OR
    NEW.created_by IS DISTINCT FROM OLD.created_by
 ) THEN
   RAISE EXCEPTION 'DHF remediation-linked attempt evidence cannot be rewritten'
     USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$;
CREATE TRIGGER dhf_pilot_rework_attempt_manifest_immutable
 BEFORE UPDATE OF manifest_body,manifest_sha,project_id,stage_id,template_id,created_by
 ON dhf_pilot_attempts FOR EACH ROW
 EXECUTE FUNCTION dhf_pilot_guard_linked_remediation_attempt();

-- Neither remediation cases nor their events can be edited/deleted.
CREATE TRIGGER dhf_pilot_remediation_case_immutable
 BEFORE UPDATE OR DELETE ON dhf_pilot_remediation_cases
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_reject_submission_mutation();
CREATE TRIGGER dhf_pilot_remediation_event_immutable
 BEFORE UPDATE OR DELETE ON dhf_pilot_remediation_events
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_reject_submission_mutation();
