-- DHF V0.6.6: workbench task projection for submitted pilot stages.
-- Original file-edit approvals remain authoritative for CDW only.
-- NO electronic-signature or official Gate decision API is enabled here.
-- Reviewers must be explicitly configured; approval is not inferred from
-- project membership, admin rights or submitted evidence existence.

CREATE TABLE dhf_pilot_review_assignments (
 project_id text NOT NULL,
 stage_id text NOT NULL,
 review_key text NOT NULL CHECK(length(review_key) BETWEEN 2 AND 96),
 reviewer_id text NOT NULL,
 configured_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 configured_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(project_id,stage_id,review_key),
 FOREIGN KEY(project_id,stage_id) REFERENCES dhf_pilot_baselines(project_id,stage_id) ON DELETE RESTRICT,
 FOREIGN KEY(project_id,reviewer_id) REFERENCES dhf_pilot_members(project_id,user_id) ON DELETE RESTRICT
);
CREATE INDEX ix_dhf_pilot_assignments_reviewer ON dhf_pilot_review_assignments(reviewer_id,project_id);

CREATE TABLE dhf_pilot_workbench_tasks (
 id text PRIMARY KEY,
 submission_id text NOT NULL REFERENCES dhf_pilot_submissions(id) ON DELETE RESTRICT,
 project_id text NOT NULL,
 stage_id text NOT NULL CHECK(stage_id IN ('G1','G2','G3','G4','G5','G6','G7','G8','G9')),
 review_key text NOT NULL CHECK(length(review_key) BETWEEN 2 AND 96),
 reviewer_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 assigned_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','returned','reviewed','cancelled')),
 assigned_at timestamptz NOT NULL DEFAULT now(),
 -- These tasks are an actionable review queue, not formal electronic signatures.
 UNIQUE(submission_id,review_key),
 FOREIGN KEY(project_id,stage_id,review_key)
   REFERENCES dhf_pilot_review_assignments(project_id,stage_id,review_key) ON DELETE RESTRICT,
 FOREIGN KEY(project_id,reviewer_id)
   REFERENCES dhf_pilot_members(project_id,user_id) ON DELETE RESTRICT
);
CREATE INDEX ix_dhf_pilot_workbench_reviewer ON dhf_pilot_workbench_tasks(reviewer_id,assigned_at DESC,id DESC) WHERE status='pending';
CREATE INDEX ix_dhf_pilot_workbench_stage ON dhf_pilot_workbench_tasks(project_id,stage_id,submission_id);

-- A task must belong to precisely the same submitted stage and reviewer who
-- received the configured assignment. The requester cannot approve their own
-- submission in this workflow. No direct SQL reassignment of old tasks.
CREATE OR REPLACE FUNCTION dhf_pilot_validate_workbench_task()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE matched boolean;
BEGIN
 SELECT (s.project_id=NEW.project_id AND s.stage_id=NEW.stage_id AND
         a.reviewer_id=NEW.reviewer_id AND
         s.submitted_by<>NEW.reviewer_id AND
         p.state='active' AND u.disabled_at IS NULL)
 INTO matched
 FROM dhf_pilot_submissions s
 JOIN dhf_pilot_review_assignments a
   ON a.project_id=s.project_id AND a.stage_id=s.stage_id AND a.review_key=NEW.review_key
 JOIN dhf_pilot_projects p ON p.id=s.project_id
 JOIN users u ON u.id=a.reviewer_id
 WHERE s.id=NEW.submission_id;
 IF matched IS DISTINCT FROM TRUE THEN
   RAISE EXCEPTION 'DHF reviewer assignment or submission identity mismatch'
     USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER dhf_pilot_workbench_validate
 BEFORE INSERT ON dhf_pilot_workbench_tasks
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_validate_workbench_task();

-- Task identity, assignment and submission remain immutable. A future
-- authorized action may update status only while append-only decisions are
-- recorded separately in the same transaction (not yet implemented).
CREATE OR REPLACE FUNCTION dhf_pilot_reject_task_identity_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.id IS DISTINCT FROM NEW.id OR
    OLD.submission_id IS DISTINCT FROM NEW.submission_id OR
    OLD.project_id IS DISTINCT FROM NEW.project_id OR
    OLD.stage_id IS DISTINCT FROM NEW.stage_id OR
    OLD.review_key IS DISTINCT FROM NEW.review_key OR
    OLD.reviewer_id IS DISTINCT FROM NEW.reviewer_id OR
    OLD.assigned_by IS DISTINCT FROM NEW.assigned_by OR
    OLD.assigned_at IS DISTINCT FROM NEW.assigned_at THEN
   RAISE EXCEPTION 'DHF review task identity is immutable' USING ERRCODE='23514';
 END IF;
 -- No review decision write service exists in the pilot: no task can be
 -- marked reviewed/returned/cancelled via ad hoc SQL.
 IF NEW.status IS DISTINCT FROM OLD.status THEN
   RAISE EXCEPTION 'DHF review task decisions are not yet enabled' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER dhf_pilot_workbench_task_immutable
 BEFORE UPDATE ON dhf_pilot_workbench_tasks
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_reject_task_identity_mutation();
CREATE TRIGGER dhf_pilot_workbench_task_delete_reject
 BEFORE DELETE ON dhf_pilot_workbench_tasks
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_reject_submission_mutation();
