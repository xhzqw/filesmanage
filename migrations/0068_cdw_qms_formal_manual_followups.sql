-- G18: explicitly recorded ONE-TIME, human-initiated in-app follow-up.
-- No regulatory SLA, inferred overdue status, or external notification.
CREATE TABLE cdw_qms_formal_notice_followups (
 id text PRIMARY KEY,
 notice_id text NOT NULL UNIQUE REFERENCES cdw_qms_formal_interruption_alerts(id),
 approval_instance_id text NOT NULL REFERENCES cdw_formal_approval_instances(id),
 recipient_id text NOT NULL REFERENCES users(id),
 requested_by text NOT NULL REFERENCES users(id),
 reason text NOT NULL CHECK(length(btrim(reason))>=16),
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(requested_by<>recipient_id)
);
CREATE INDEX cdw_qms_followups_approval
 ON cdw_qms_formal_notice_followups(approval_instance_id,requested_at DESC);
CREATE FUNCTION cdw_qms_notice_followup_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE notice record; file_id text;
BEGIN
 SELECT n.approval_instance_id,n.recipient_id,n.read_at,sub.file_id
 INTO notice FROM cdw_qms_formal_interruption_alerts n
 JOIN cdw_formal_approval_instances a ON a.id=n.approval_instance_id
 JOIN cdw_approval_subjects sub ON sub.id=a.subject_id
 WHERE n.id=NEW.notice_id FOR UPDATE OF n;
 IF NOT FOUND OR notice.read_at IS NOT NULL
  OR NEW.approval_instance_id IS DISTINCT FROM notice.approval_instance_id
  OR NEW.recipient_id IS DISTINCT FROM notice.recipient_id
  OR NOT EXISTS(SELECT 1 FROM cdw_business_role_bindings b
   JOIN users u ON u.id=b.user_id
   WHERE b.user_id=NEW.requested_by AND b.role='document_control'
    AND (b.file_id=notice.file_id OR b.file_id IS NULL)
    AND b.department_id IS NULL AND b.revoked_at IS NULL
    AND b.valid_from<=clock_timestamp() AND u.disabled_at IS NULL
    AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp()))
 THEN RAISE EXCEPTION 'Follow-up requires an unread notice and current independent document control'
  USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_qms_notice_followup_guard BEFORE INSERT
 ON cdw_qms_formal_notice_followups FOR EACH ROW
 EXECUTE FUNCTION cdw_qms_notice_followup_guard();
CREATE TRIGGER cdw_qms_notice_followup_immutable BEFORE UPDATE OR DELETE
 ON cdw_qms_formal_notice_followups FOR EACH ROW
 EXECUTE FUNCTION cdw_prevent_fact_mutation();
