-- DHF V0.7.1: immutable sequential responsibility projection derived from
-- PUBLISHED G5 policy specialties order and the assigned final G5/G6 Gate.
-- An approved early-intervention is only permission to REVIEW out of order:
-- missing predecessor obligations remain UNFULFILLED. No formal signatures
-- or Stage Gate acceptance are granted by this pilot.
CREATE TABLE dhf_pilot_review_obligations (
 task_id text PRIMARY KEY REFERENCES dhf_pilot_workbench_tasks(id) ON DELETE RESTRICT,
 submission_id text NOT NULL REFERENCES dhf_pilot_submissions(id) ON DELETE RESTRICT,
 step_ordinal integer NOT NULL CHECK (step_ordinal BETWEEN 1 AND 33),
 review_key text NOT NULL,
 reviewer_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 policy_sha char(64) NOT NULL CHECK (policy_sha ~ '^[a-f0-9]{64}$'),
 manifest_sha char(64) NOT NULL CHECK (manifest_sha ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(submission_id,step_ordinal),
 UNIQUE(submission_id,review_key)
);

CREATE OR REPLACE FUNCTION dhf_pilot_validate_obligation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 valid boolean;
 expected_step integer;
BEGIN
 SELECT (
   t.submission_id=NEW.submission_id AND t.review_key=NEW.review_key
   AND t.reviewer_id=NEW.reviewer_id AND t.status='pending'
   AND s.policy_sha=NEW.policy_sha AND s.manifest_sha=NEW.manifest_sha
   AND pol.status='published' AND p.state='active'
 ), CASE
   WHEN t.stage_id='G6' AND t.review_key='__gate__' THEN 1
   WHEN t.stage_id='G5' AND t.review_key='__gate__' THEN
     jsonb_array_length(COALESCE(convert_from(pol.policy_body,'UTF8')::jsonb->'specialties','[]'::jsonb))+1
   WHEN t.stage_id='G5' THEN (
     SELECT entry.ordinality::integer FROM jsonb_array_elements(
       COALESCE(convert_from(pol.policy_body,'UTF8')::jsonb->'specialties','[]'::jsonb)
     ) WITH ORDINALITY entry(item,ordinality)
     WHERE entry.item->>'Key'=NEW.review_key
   )
   ELSE NULL END
 INTO valid,expected_step
 FROM dhf_pilot_workbench_tasks t
 JOIN dhf_pilot_submissions s ON s.id=t.submission_id
 JOIN dhf_pilot_templates pol ON pol.id=s.template_id
 JOIN dhf_pilot_projects p ON p.id=s.project_id
 WHERE t.id=NEW.task_id;
 IF valid IS DISTINCT FROM TRUE OR expected_step IS NULL OR expected_step<>NEW.step_ordinal THEN
   RAISE EXCEPTION 'DHF obligation must match frozen published specialty sequence and task'
    USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER dhf_pilot_obligation_source
 BEFORE INSERT ON dhf_pilot_review_obligations
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_validate_obligation();
CREATE TRIGGER dhf_pilot_obligation_immutable
 BEFORE UPDATE OR DELETE ON dhf_pilot_review_obligations
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_reject_submission_mutation();

CREATE TABLE dhf_pilot_early_interventions (
 id text PRIMARY KEY,
 target_task_id text NOT NULL UNIQUE REFERENCES dhf_pilot_review_obligations(task_id) ON DELETE RESTRICT,
 submission_id text NOT NULL REFERENCES dhf_pilot_submissions(id) ON DELETE RESTRICT,
 authorized_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 2000),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 160),
 request_sha char(64) NOT NULL CHECK (request_sha ~ '^[a-f0-9]{64}$'),
 policy_sha char(64) NOT NULL CHECK (policy_sha ~ '^[a-f0-9]{64}$'),
 manifest_sha char(64) NOT NULL CHECK (manifest_sha ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(authorized_by,idempotency_key)
);

CREATE OR REPLACE FUNCTION dhf_pilot_validate_early_intervention()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed boolean;
BEGIN
 SELECT (
    target.submission_id=NEW.submission_id AND target.step_ordinal>1
    AND target.review_key<>'__gate__'
    AND task.status='pending'
    AND gate.review_key='__gate__'
    AND gate.reviewer_id=NEW.authorized_by AND gate.status='pending'
    AND gate.reviewer_id<>target.reviewer_id
    AND s.submitted_by<>NEW.authorized_by
    AND s.policy_sha=NEW.policy_sha AND s.manifest_sha=NEW.manifest_sha
    AND pol.status='published' AND project.state='active'
    AND baseline.active AND baseline.template_id=s.template_id
    AND u.disabled_at IS NULL
    AND EXISTS(SELECT 1 FROM dhf_pilot_members member
       WHERE member.project_id=s.project_id AND member.user_id=NEW.authorized_by)
    AND EXISTS(SELECT 1 FROM dhf_pilot_review_obligations prior
       JOIN dhf_pilot_workbench_tasks prior_task ON prior_task.id=prior.task_id
       WHERE prior.submission_id=target.submission_id
         AND prior.step_ordinal<target.step_ordinal AND prior_task.status<>'reviewed')
 ) INTO allowed
 FROM dhf_pilot_review_obligations target
 JOIN dhf_pilot_workbench_tasks task ON task.id=target.task_id
 JOIN dhf_pilot_submissions s ON s.id=target.submission_id
 JOIN dhf_pilot_templates pol ON pol.id=s.template_id
 JOIN dhf_pilot_projects project ON project.id=s.project_id
 JOIN dhf_pilot_baselines baseline ON baseline.project_id=s.project_id
   AND baseline.stage_id=s.stage_id
 JOIN users u ON u.id=NEW.authorized_by
 JOIN dhf_pilot_workbench_tasks gate ON gate.submission_id=target.submission_id AND gate.review_key='__gate__'
 WHERE target.task_id=NEW.target_task_id;
 IF allowed IS DISTINCT FROM TRUE THEN
   RAISE EXCEPTION 'DHF early review requires assigned Gate sponsor and outstanding prior duty'
    USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER dhf_pilot_early_intervention_authorization
 BEFORE INSERT ON dhf_pilot_early_interventions
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_validate_early_intervention();
CREATE TRIGGER dhf_pilot_early_intervention_immutable
 BEFORE UPDATE OR DELETE ON dhf_pilot_early_interventions
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_reject_submission_mutation();

-- An intervention is a sensitive authorization action: the immutable
-- sponsor decision and the ordinary audit trail must commit atomically.
CREATE OR REPLACE FUNCTION dhf_pilot_require_early_intervention_audit()
RETURNS trigger LANGUAGE plpgsql AS $
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM audit_events a
   WHERE a.actor_id=NEW.authorized_by
     AND a.event_type='dhf.pilot.early_intervention'
     AND a.target_kind='dhf_review_task'
     AND a.target_id=NEW.target_task_id
     AND a.request_id=NEW.idempotency_key
     AND a.details->>'interventionId'=NEW.id
 ) THEN
   RAISE EXCEPTION 'DHF sponsor early intervention requires same-transaction audit event'
     USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$;
CREATE CONSTRAINT TRIGGER dhf_pilot_early_intervention_audit_atomic
 AFTER INSERT ON dhf_pilot_early_interventions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION dhf_pilot_require_early_intervention_audit();

-- Enforce the sequence inside PostgreSQL even for direct SQL inserts.
-- Gate PASS is NEVER allowed by an early-intervention alone: existing 0049
-- Gate check requires every specialty task to become reviewed.
CREATE OR REPLACE FUNCTION dhf_pilot_verify_review_step_order()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_step integer;
DECLARE current_key text;
DECLARE predecessor_count integer;
BEGIN
 SELECT step_ordinal,review_key INTO current_step,current_key
 FROM dhf_pilot_review_obligations WHERE task_id=NEW.task_id
   AND submission_id=NEW.submission_id
   AND reviewer_id=NEW.reviewer_id AND policy_sha=NEW.policy_sha
   AND manifest_sha=NEW.manifest_sha;
 IF current_step IS NULL THEN
   RAISE EXCEPTION 'DHF review requires a frozen sequenced obligation'
      USING ERRCODE='23514';
 END IF;
 SELECT count(*) INTO predecessor_count
 FROM dhf_pilot_review_obligations older
 JOIN dhf_pilot_workbench_tasks older_task ON older_task.id=older.task_id
 WHERE older.submission_id=NEW.submission_id AND older.step_ordinal<current_step
   AND older_task.status<>'reviewed';
 IF predecessor_count>0 THEN
   IF current_key='__gate__' OR NOT EXISTS(
     SELECT 1 FROM dhf_pilot_early_interventions i
     WHERE i.target_task_id=NEW.task_id AND i.submission_id=NEW.submission_id
       AND i.policy_sha=NEW.policy_sha AND i.manifest_sha=NEW.manifest_sha
   ) THEN
     RAISE EXCEPTION 'DHF prior responsibility not fulfilled or authorized for early review'
       USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER dhf_pilot_step_order_review
 BEFORE INSERT ON dhf_pilot_review_decisions
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_verify_review_step_order();

-- Every G5/G6 frozen submitted stage must commit ALL expected immutable
-- reviewer responsibilities. A manual SQL journal must not omit obligations.
CREATE OR REPLACE FUNCTION dhf_pilot_require_complete_duties()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_count integer;
DECLARE actual_count integer;
DECLARE task_count integer;
BEGIN
 IF NEW.stage_id NOT IN ('G5','G6') THEN RETURN NULL; END IF;
 SELECT CASE WHEN NEW.stage_id='G5' THEN
    jsonb_array_length(COALESCE(convert_from(t.policy_body,'UTF8')::jsonb->'specialties','[]'::jsonb))+1
    ELSE 1 END
 INTO expected_count FROM dhf_pilot_templates t WHERE t.id=NEW.template_id;
 SELECT count(*) INTO actual_count FROM dhf_pilot_review_obligations WHERE submission_id=NEW.id;
 SELECT count(*) INTO task_count FROM dhf_pilot_workbench_tasks WHERE submission_id=NEW.id;
 IF expected_count IS NULL OR actual_count<>expected_count OR task_count<>expected_count THEN
   RAISE EXCEPTION 'DHF submitted stage must atomically create complete reviewer duty chain'
      USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER dhf_pilot_submission_duties_complete
 AFTER INSERT ON dhf_pilot_submissions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION dhf_pilot_require_complete_duties();

-- No columns or constraints permitting legal signatures, Gate accepted
-- states, conditionally released states or CDW approval changes.
