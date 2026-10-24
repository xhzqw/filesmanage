-- DHF V0.6.7: immutable pilot reviewer recommendations. They are NOT a
-- legal electronic signature, official stage acceptance or file issuance.
-- The pilot still cannot set stage/attempt state='reviewing' or 'accepted'.
CREATE TABLE dhf_pilot_review_decisions (
 id text PRIMARY KEY,
 task_id text NOT NULL UNIQUE REFERENCES dhf_pilot_workbench_tasks(id) ON DELETE RESTRICT,
 submission_id text NOT NULL REFERENCES dhf_pilot_submissions(id) ON DELETE RESTRICT,
 reviewer_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 outcome text NOT NULL CHECK(outcome IN ('recommend_pass','recommend_return')),
 comment text NOT NULL DEFAULT '' CHECK(length(comment)<=2000),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 160),
 request_sha char(64) NOT NULL CHECK(request_sha ~ '^[0-9a-f]{64}$'),
 policy_sha char(64) NOT NULL CHECK(policy_sha ~ '^[0-9a-f]{64}$'),
 manifest_sha char(64) NOT NULL CHECK(manifest_sha ~ '^[0-9a-f]{64}$'),
 decided_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(reviewer_id,idempotency_key),
 CHECK(outcome<>'recommend_return' OR length(btrim(comment))>0)
);
CREATE INDEX ix_dhf_pilot_review_by_submission
 ON dhf_pilot_review_decisions(submission_id,decided_at);

-- Verify exact task, reviewer, immutable submission hashes and G5 step order.
CREATE FUNCTION dhf_pilot_check_review_decision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE task_row dhf_pilot_workbench_tasks%ROWTYPE;
DECLARE ok boolean;
DECLARE specialty_count integer;
DECLARE outstanding integer;
BEGIN
 SELECT * INTO task_row FROM dhf_pilot_workbench_tasks WHERE id=NEW.task_id;
 IF NOT FOUND OR task_row.status<>'pending' OR task_row.reviewer_id<>NEW.reviewer_id
    OR task_row.submission_id<>NEW.submission_id THEN
    RAISE EXCEPTION 'DHF review must target own pending task'
      USING ERRCODE='23514';
 END IF;
 SELECT (
   s.submitted_by<>NEW.reviewer_id AND
   s.policy_sha=NEW.policy_sha AND s.manifest_sha=NEW.manifest_sha AND
   p.state='active' AND u.disabled_at IS NULL AND tmpl.status='published'
 ) INTO ok
 FROM dhf_pilot_submissions s
 JOIN dhf_pilot_projects p ON p.id=s.project_id
 JOIN dhf_pilot_members m ON m.project_id=s.project_id AND m.user_id=NEW.reviewer_id
 JOIN users u ON u.id=m.user_id
 JOIN dhf_pilot_templates tmpl ON tmpl.id=s.template_id
 WHERE s.id=NEW.submission_id;
 IF ok IS DISTINCT FROM TRUE THEN
   RAISE EXCEPTION 'DHF review scope or frozen evidence invalid'
     USING ERRCODE='23514';
 END IF;
 IF task_row.stage_id='G5' AND task_row.review_key='__gate__'
    AND NEW.outcome='recommend_pass' THEN
   SELECT count(*),
          count(*) FILTER (WHERE status<>'reviewed')
   INTO specialty_count,outstanding
   FROM dhf_pilot_workbench_tasks
   WHERE submission_id=NEW.submission_id AND review_key<>'__gate__';
   IF specialty_count=0 OR outstanding<>0 THEN
     RAISE EXCEPTION 'G5 final Gate recommendation requires all specialties reviewed'
       USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER dhf_pilot_check_review_scope
 BEFORE INSERT ON dhf_pilot_review_decisions
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_check_review_decision();

CREATE TRIGGER dhf_pilot_review_immutable
 BEFORE UPDATE OR DELETE ON dhf_pilot_review_decisions
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_reject_submission_mutation();

-- Task status changes only if a matching immutable event exists.
CREATE OR REPLACE FUNCTION dhf_pilot_reject_task_identity_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_outcome text;
BEGIN
 IF OLD.id IS DISTINCT FROM NEW.id OR OLD.submission_id IS DISTINCT FROM NEW.submission_id
    OR OLD.project_id IS DISTINCT FROM NEW.project_id OR OLD.stage_id IS DISTINCT FROM NEW.stage_id
    OR OLD.review_key IS DISTINCT FROM NEW.review_key OR OLD.reviewer_id IS DISTINCT FROM NEW.reviewer_id
    OR OLD.assigned_by IS DISTINCT FROM NEW.assigned_by OR OLD.assigned_at IS DISTINCT FROM NEW.assigned_at THEN
   RAISE EXCEPTION 'DHF review task identity is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.status<>NEW.status THEN
   IF OLD.status<>'pending' OR NEW.status NOT IN ('reviewed','returned') THEN
     RAISE EXCEPTION 'DHF trial review task cannot regress or skip status'
       USING ERRCODE='23514';
   END IF;
   expected_outcome:=CASE WHEN NEW.status='reviewed' THEN 'recommend_pass'
                         ELSE 'recommend_return' END;
   IF NOT EXISTS (
     SELECT 1 FROM dhf_pilot_review_decisions d
     WHERE d.task_id=NEW.id AND d.submission_id=NEW.submission_id
       AND d.reviewer_id=NEW.reviewer_id AND d.outcome=expected_outcome
   ) THEN
     RAISE EXCEPTION 'DHF task status requires immutable matching review decision'
       USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END;
$$;

-- Reverse direction: inserting an event without updating the task in the same
-- transaction must not commit either. Ensures exact event↔status atomicity.
CREATE FUNCTION dhf_pilot_require_review_task_state()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE task_status text;
BEGIN
 SELECT status INTO task_status FROM dhf_pilot_workbench_tasks WHERE id=NEW.task_id;
 IF task_status IS DISTINCT FROM CASE WHEN NEW.outcome='recommend_pass' THEN 'reviewed' ELSE 'returned' END THEN
   RAISE EXCEPTION 'DHF review decision must commit with matching task status'
     USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER dhf_pilot_review_task_state_atomic
 AFTER INSERT ON dhf_pilot_review_decisions
 DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_require_review_task_state();

-- No migration here changes dhf_pilot_attempts into an accepted stage.
