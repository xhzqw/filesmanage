-- DHF V0.6.6 audit hardening: distinguish responsibility assignment from
-- mutable configuration. No official reviewer decisions are enabled.
-- Never overwrite the reviewer source of an already dispatched task.

CREATE UNIQUE INDEX uq_dhf_pilot_stage_reviewer_separation
 ON dhf_pilot_review_assignments(project_id,stage_id,reviewer_id);

CREATE OR REPLACE FUNCTION dhf_pilot_guard_assignment_history()
 RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (
   SELECT 1 FROM dhf_pilot_workbench_tasks t
   WHERE t.project_id=OLD.project_id AND t.stage_id=OLD.stage_id
     AND t.review_key=OLD.review_key
 ) THEN
   RAISE EXCEPTION 'DHF dispatched reviewer assignment is immutable'
     USING ERRCODE='23514';
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER dhf_pilot_reviewer_history
 BEFORE UPDATE OR DELETE ON dhf_pilot_review_assignments
 FOR EACH ROW EXECUTE FUNCTION dhf_pilot_guard_assignment_history();

-- Manually injecting a task cannot manufacture an extra professional key
-- absent from the published policy. Even an active assignment is insufficient
-- if it is not part of this submission's frozen, published stage template.
CREATE OR REPLACE FUNCTION dhf_pilot_validate_workbench_task()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE matched boolean;
BEGIN
 SELECT (
   s.project_id=NEW.project_id AND s.stage_id=NEW.stage_id
   AND s.submitted_by=NEW.assigned_by
   AND a.reviewer_id=NEW.reviewer_id
   AND s.submitted_by<>NEW.reviewer_id
   AND p.state='active'
   AND u.disabled_at IS NULL
   AND tmpl.status='published'
   AND (
     (NEW.review_key='__gate__' AND s.stage_id IN ('G5','G6'))
     OR
     (s.stage_id='G5' AND NEW.review_key<>'__gate__' AND EXISTS(
       SELECT 1
       FROM jsonb_array_elements(
         COALESCE((convert_from(tmpl.policy_body,'UTF8')::jsonb)->'specialties','[]'::jsonb)
       ) x
       WHERE x->>'Key'=NEW.review_key
     ))
   )
 ) INTO matched
 FROM dhf_pilot_submissions s
 JOIN dhf_pilot_review_assignments a
   ON a.project_id=s.project_id AND a.stage_id=s.stage_id
      AND a.review_key=NEW.review_key
 JOIN dhf_pilot_templates tmpl
   ON tmpl.id=s.template_id AND tmpl.stage_id=s.stage_id
 JOIN dhf_pilot_projects p ON p.id=s.project_id
 JOIN users u ON u.id=a.reviewer_id
 WHERE s.id=NEW.submission_id;
 IF matched IS DISTINCT FROM TRUE THEN
   RAISE EXCEPTION 'DHF review task not authorized by signed stage policy and assignment'
     USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
