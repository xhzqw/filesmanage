-- Revocation is a new, auditable state transition. Never delete old
-- appointment/decision evidence; pending and historical facts remain visible.
ALTER TABLE cdw_qms_appointments ADD COLUMN revocation_reason text;
ALTER TABLE cdw_qms_appointments ADD CONSTRAINT cdw_qms_revocation_reason_required
 CHECK (status<>'revoked' OR length(btrim(revocation_reason))>=16);

-- In-product durable individual alerts. Reading one is a separate operation;
-- a queued outbox event alone does not establish recipient delivery.
CREATE TABLE cdw_qms_appointment_alerts (
 id text PRIMARY KEY,
 appointment_id text NOT NULL REFERENCES cdw_qms_appointments(id),
 recipient_id text NOT NULL REFERENCES users(id),
 event_kind text NOT NULL CHECK(event_kind IN('revoked')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 read_at timestamptz,
 UNIQUE(appointment_id,recipient_id,event_kind)
);
CREATE INDEX cdw_qms_alerts_unread ON cdw_qms_appointment_alerts(recipient_id,created_at DESC)
 WHERE read_at IS NULL;
CREATE FUNCTION cdw_qms_alert_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id
    OR NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
    OR NEW.event_kind IS DISTINCT FROM OLD.event_kind
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR OLD.read_at IS NOT NULL
    OR (NEW.read_at IS NOT NULL AND NEW.read_at<OLD.created_at) THEN
  RAISE EXCEPTION 'QMS recipient alert history is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_qms_alert_immutable BEFORE UPDATE OR DELETE
 ON cdw_qms_appointment_alerts FOR EACH ROW EXECUTE FUNCTION cdw_qms_alert_immutable();

-- v0060 already forbids modifying immutable verification and appointment
-- particulars. Tighten the previously legal verified->revoked transition:
-- require a real control-role grant, reason, and no self-revocation.
CREATE OR REPLACE FUNCTION cdw_qms_appointment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'QMS appointment evidence is append-only' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' AND NEW.status<>'pending' THEN
  RAISE EXCEPTION 'QMS appointments begin pending independent review' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.file_id IS DISTINCT FROM OLD.file_id
   OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.node_key IS DISTINCT FROM OLD.node_key
   OR NEW.policy_release_id IS DISTINCT FROM OLD.policy_release_id
   OR NEW.evidence_release_id IS DISTINCT FROM OLD.evidence_release_id
   OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by OR NEW.proposed_at IS DISTINCT FROM OLD.proposed_at
   OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
   OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
   OR OLD.status='revoked' OR (OLD.status='verified' AND NEW.status<>'revoked')
   OR (OLD.status='pending' AND NEW.status<>'verified')
   OR (OLD.status='verified' AND (
    NEW.verified_by IS DISTINCT FROM OLD.verified_by OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
    OR NEW.verifier_binding_id IS DISTINCT FROM OLD.verifier_binding_id
    OR NEW.verification_reason IS DISTINCT FROM OLD.verification_reason)) THEN
   RAISE EXCEPTION 'QMS appointment evidence cannot be rewritten' USING ERRCODE='23514';
  END IF;
  IF NEW.status='revoked' AND OLD.status='verified' THEN
   IF NEW.revoked_by IS NULL OR NEW.revoked_by IN (OLD.user_id,OLD.proposed_by)
    OR NEW.revoked_at IS NULL OR length(btrim(NEW.revocation_reason))<16
    OR NOT EXISTS(
     SELECT 1 FROM cdw_business_role_bindings b JOIN users u ON u.id=b.user_id
     WHERE b.user_id=NEW.revoked_by AND b.role='document_control'
      AND (b.file_id=OLD.file_id OR b.file_id IS NULL)
      AND b.department_id IS NULL AND b.revoked_at IS NULL AND u.disabled_at IS NULL
      AND b.valid_from<=clock_timestamp() AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp())
    ) THEN
    RAISE EXCEPTION 'QMS appointment revocation requires independent authorized controller'
      USING ERRCODE='23514';
   END IF;
  ELSIF NEW.revoked_by IS DISTINCT FROM OLD.revoked_by OR
   NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR
   NEW.revocation_reason IS DISTINCT FROM OLD.revocation_reason THEN
   RAISE EXCEPTION 'QMS revocation evidence is immutable' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.status='verified' AND (TG_OP='INSERT' OR OLD.status<>'verified') THEN
  IF NOT cdw_qms_policy_release_effective(NEW.policy_release_id)
   OR NOT cdw_qms_policy_release_effective(NEW.evidence_release_id)
   OR NOT EXISTS(
    SELECT 1 FROM cdw_business_role_bindings b JOIN users u ON u.id=b.user_id
    WHERE b.id=NEW.verifier_binding_id AND b.role='document_control'
     AND b.user_id=NEW.verified_by AND u.disabled_at IS NULL
     AND (b.file_id=NEW.file_id OR b.file_id IS NULL)
     AND b.department_id IS NULL AND b.revoked_at IS NULL
     AND b.valid_from<=clock_timestamp()
     AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp())
   ) THEN
   RAISE EXCEPTION 'QMS appointment lacks independent current verification' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;

-- ZS-QP-09 delegates DHF/DMR signatory authority to separate procedures
-- not proven to be in force. Do not treat the general QMS appointment or an
-- administrator-published template as that missing specific authorization.
-- Release once separately approved dedicated policy/matrix evidence exists.
CREATE FUNCTION cdw_qms_special_authority_pending(fid text) RETURNS boolean
 LANGUAGE sql STABLE AS $$
 SELECT EXISTS(
  SELECT 1 FROM files f LEFT JOIN cdw_document_profiles p ON p.file_id=f.id
  WHERE f.id=fid AND (lower(COALESCE(p.document_type,'')) IN('dhf','dmr')
   OR f.name ~* '(^|[^a-z])(DHF|DMR)([^a-z]|$)'
   OR f.name ~ '(产品设计历史文档|设计历史文件|器械主文档|产品器械主文档)')
 ) $$;
CREATE FUNCTION cdw_qms_special_formal_submission_guard() RETURNS trigger
 LANGUAGE plpgsql AS $$
DECLARE fid text;
BEGIN
 SELECT file_id INTO fid FROM cdw_approval_subjects WHERE id=NEW.subject_id;
 IF cdw_qms_special_authority_pending(fid) THEN
  RAISE EXCEPTION 'DHF/DMR requires ratified dedicated signatory procedure'
   USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_qms_special_formal_submission_guard
 BEFORE INSERT ON cdw_formal_approval_instances
 FOR EACH ROW EXECUTE FUNCTION cdw_qms_special_formal_submission_guard();
CREATE FUNCTION cdw_qms_special_formal_decision_guard() RETURNS trigger
 LANGUAGE plpgsql AS $$
DECLARE fid text;
BEGIN
 SELECT sub.file_id INTO fid FROM cdw_formal_approval_steps st
  JOIN cdw_formal_approval_instances i ON i.id=st.instance_id
  JOIN cdw_approval_subjects sub ON sub.id=i.subject_id WHERE st.id=NEW.step_id;
 IF cdw_qms_special_authority_pending(fid) THEN
  RAISE EXCEPTION 'DHF/DMR cannot be signed without dedicated approved authority'
   USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_qms_special_formal_decision_guard
 BEFORE INSERT ON cdw_formal_approval_decisions
 FOR EACH ROW EXECUTE FUNCTION cdw_qms_special_formal_decision_guard();
