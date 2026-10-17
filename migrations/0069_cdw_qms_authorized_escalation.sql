-- G20. An in-app escalation exists only after an independently verified
-- effective controlled policy. This migration creates NO default policies,
-- timers, external messages or escalations.
CREATE TABLE cdw_qms_escalation_policies (
 id text PRIMARY KEY,
 target_file_id text NOT NULL REFERENCES files(id),
 policy_release_id text NOT NULL REFERENCES cdw_controlled_releases(id),
 clause_ref text NOT NULL CHECK(length(btrim(clause_ref)) BETWEEN 3 AND 180),
 delay_minutes integer NOT NULL CHECK(delay_minutes BETWEEN 60 AND 525600),
 escalation_owner_id text NOT NULL REFERENCES users(id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 16 AND 2000),
 proposed_by text NOT NULL REFERENCES users(id),
 proposed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','verified','revoked')),
 verified_by text REFERENCES users(id),
 verified_at timestamptz,
 verification_reason text,
 revoked_by text REFERENCES users(id),
 revoked_at timestamptz,
 revocation_reason text,
 CHECK(proposed_by<>escalation_owner_id),
 CHECK((status='pending' AND verified_by IS NULL AND verified_at IS NULL)
  OR (status IN('verified','revoked') AND verified_by IS NOT NULL
   AND verified_at IS NOT NULL AND length(btrim(verification_reason))>=16)),
 CHECK(status<>'revoked' OR (revoked_by IS NOT NULL AND revoked_at IS NOT NULL
  AND length(btrim(revocation_reason))>=16)),
 CHECK(status='revoked' OR (revoked_by IS NULL AND revoked_at IS NULL AND revocation_reason IS NULL))
);
CREATE UNIQUE INDEX cdw_qms_one_live_escalation_policy
 ON cdw_qms_escalation_policies(target_file_id)
 WHERE status IN('pending','verified');

CREATE FUNCTION cdw_qms_escalation_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_ok boolean; actor_id text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Escalation policy history is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' AND NEW.status<>'pending' THEN
  RAISE EXCEPTION 'Only pending escalation policy proposals may be inserted' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND
  NOT ((OLD.status='pending' AND NEW.status='verified')
    OR (OLD.status='verified' AND NEW.status='revoked'))
 THEN RAISE EXCEPTION 'Invalid escalation policy state transition' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (
  NEW.id IS DISTINCT FROM OLD.id OR NEW.target_file_id IS DISTINCT FROM OLD.target_file_id
  OR NEW.policy_release_id IS DISTINCT FROM OLD.policy_release_id
  OR NEW.clause_ref IS DISTINCT FROM OLD.clause_ref
  OR NEW.delay_minutes IS DISTINCT FROM OLD.delay_minutes
  OR NEW.escalation_owner_id IS DISTINCT FROM OLD.escalation_owner_id
  OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by
  OR NEW.proposed_at IS DISTINCT FROM OLD.proposed_at
  OR (OLD.status='verified' AND
    (NEW.verified_by IS DISTINCT FROM OLD.verified_by
     OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
     OR NEW.verification_reason IS DISTINCT FROM OLD.verification_reason)))
 THEN RAISE EXCEPTION 'Only independent pending policy verification is permitted' USING ERRCODE='23514'; END IF;
 actor_id:=CASE WHEN TG_OP='INSERT' THEN NEW.proposed_by
  WHEN NEW.status='verified' THEN NEW.verified_by ELSE NEW.revoked_by END;
 SELECT EXISTS(SELECT 1 FROM cdw_business_role_bindings b JOIN users u ON u.id=b.user_id
  WHERE b.user_id=actor_id AND b.role='document_control' AND b.department_id IS NULL
  AND (b.file_id=NEW.target_file_id OR b.file_id IS NULL)
  AND b.revoked_at IS NULL AND b.valid_from<=clock_timestamp()
  AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp()) AND u.disabled_at IS NULL)
 INTO owner_ok;
 IF NOT owner_ok THEN RAISE EXCEPTION 'Escalation requires active document control' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND
   ((NEW.status='verified' AND NEW.verified_by=NEW.proposed_by)
    OR (NEW.status='revoked' AND NEW.revoked_by IN(NEW.proposed_by,NEW.verified_by)))
 THEN RAISE EXCEPTION 'Escalation requires independent verification/revocation' USING ERRCODE='23514'; END IF;
 IF NEW.status<>'revoked' AND NOT EXISTS(SELECT 1 FROM cdw_controlled_releases r
  JOIN cdw_effective_pointers p ON p.file_id=r.file_id AND p.release_id=r.id AND p.state='active'
  WHERE r.id=NEW.policy_release_id AND r.state='effective')
 THEN RAISE EXCEPTION 'Escalation policy needs a currently effective controlled source' USING ERRCODE='23514'; END IF;
 IF NEW.status<>'revoked' AND NOT EXISTS(SELECT 1 FROM cdw_business_role_bindings b JOIN users u ON u.id=b.user_id
  WHERE b.user_id=NEW.escalation_owner_id AND b.role='document_control'
  AND (b.file_id=NEW.target_file_id OR b.file_id IS NULL)
  AND b.department_id IS NULL AND b.revoked_at IS NULL
  AND b.valid_from<=clock_timestamp() AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp())
  AND u.disabled_at IS NULL)
 THEN RAISE EXCEPTION 'Escalation owner must have current designated document-control responsibility' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_qms_escalation_policy_gate BEFORE INSERT OR UPDATE OR DELETE
 ON cdw_qms_escalation_policies FOR EACH ROW EXECUTE FUNCTION cdw_qms_escalation_policy_guard();

CREATE TABLE cdw_qms_escalation_cases (
 id text PRIMARY KEY,
 notice_id text NOT NULL UNIQUE REFERENCES cdw_qms_formal_interruption_alerts(id),
 policy_id text NOT NULL REFERENCES cdw_qms_escalation_policies(id),
 target_file_id text NOT NULL REFERENCES files(id),
 escalated_to text NOT NULL REFERENCES users(id),
 escalated_by text NOT NULL REFERENCES users(id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 16 AND 2000),
 escalated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(escalated_to<>escalated_by)
);
CREATE FUNCTION cdw_qms_escalation_case_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n record; p record;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Escalation case history cannot change' USING ERRCODE='23514'; END IF;
 SELECT e.*,r.state AS release_state,ptr.release_id AS current_release
 INTO p FROM cdw_qms_escalation_policies e
 JOIN cdw_controlled_releases r ON r.id=e.policy_release_id
 LEFT JOIN cdw_effective_pointers ptr ON ptr.file_id=r.file_id AND ptr.state='active'
 WHERE e.id=NEW.policy_id FOR UPDATE OF e;
 SELECT n.read_at,n.created_at,s.file_id,f.notice_id AS followed
 INTO n FROM cdw_qms_formal_interruption_alerts n
 JOIN cdw_formal_approval_instances a ON a.id=n.approval_instance_id
 JOIN cdw_approval_subjects s ON s.id=a.subject_id
 LEFT JOIN cdw_qms_formal_notice_followups f ON f.notice_id=n.id
 WHERE n.id=NEW.notice_id FOR UPDATE OF n;
 IF p.id IS NULL OR n.file_id IS NULL OR n.read_at IS NOT NULL OR n.followed IS NULL
  OR p.status<>'verified' OR p.release_state<>'effective'
  OR p.current_release IS DISTINCT FROM p.policy_release_id
  OR NEW.target_file_id IS DISTINCT FROM n.file_id
  OR NEW.target_file_id IS DISTINCT FROM p.target_file_id
  OR NEW.escalated_to IS DISTINCT FROM p.escalation_owner_id
  OR clock_timestamp()<n.created_at+(p.delay_minutes * interval '1 minute')
 THEN RAISE EXCEPTION 'Unread followed-up notice and verified effective elapsed policy required' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM cdw_business_role_bindings b JOIN users u ON u.id=b.user_id
  WHERE b.user_id=NEW.escalated_by AND b.role='document_control'
  AND (b.file_id=NEW.target_file_id OR b.file_id IS NULL)
  AND b.department_id IS NULL AND b.revoked_at IS NULL AND u.disabled_at IS NULL
  AND b.valid_from<=clock_timestamp() AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp()))
 OR NOT EXISTS(SELECT 1 FROM cdw_business_role_bindings b JOIN users u ON u.id=b.user_id
  WHERE b.user_id=NEW.escalated_to AND b.role='document_control'
  AND (b.file_id=NEW.target_file_id OR b.file_id IS NULL)
  AND b.department_id IS NULL AND b.revoked_at IS NULL AND u.disabled_at IS NULL
  AND b.valid_from<=clock_timestamp() AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp()))
 THEN RAISE EXCEPTION 'No live escalation actor or owner appointment' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_qms_escalation_case_gate BEFORE INSERT OR UPDATE OR DELETE
 ON cdw_qms_escalation_cases FOR EACH ROW EXECUTE FUNCTION cdw_qms_escalation_case_guard();

CREATE TABLE cdw_qms_escalation_resolutions(
 id text PRIMARY KEY,
 case_id text NOT NULL UNIQUE REFERENCES cdw_qms_escalation_cases(id),
 resolution text NOT NULL CHECK(length(btrim(resolution)) BETWEEN 16 AND 2000),
 resolved_by text NOT NULL REFERENCES users(id),
 resolved_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION cdw_qms_escalation_resolution_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_case record;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Escalation closure history is immutable' USING ERRCODE='23514'; END IF;
 SELECT * INTO old_case FROM cdw_qms_escalation_cases WHERE id=NEW.case_id FOR UPDATE;
 IF old_case.id IS NULL OR NEW.resolved_by=old_case.escalated_by
  OR NOT EXISTS(SELECT 1 FROM cdw_business_role_bindings b JOIN users u ON u.id=b.user_id
    WHERE b.user_id=NEW.resolved_by AND b.role='document_control'
    AND (b.file_id=old_case.target_file_id OR b.file_id IS NULL)
    AND b.department_id IS NULL AND b.revoked_at IS NULL AND u.disabled_at IS NULL
    AND b.valid_from<=clock_timestamp() AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp()))
 THEN RAISE EXCEPTION 'Escalation closure requires independent authorized document control' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_qms_escalation_resolution_gate BEFORE INSERT OR UPDATE OR DELETE
 ON cdw_qms_escalation_resolutions FOR EACH ROW EXECUTE FUNCTION cdw_qms_escalation_resolution_guard();
