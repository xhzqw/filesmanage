-- G16: historical pending anomalies are reviewed, not retroactively
-- rewritten by the migration. Real interruption notices are recipient facts.
CREATE TABLE cdw_qms_formal_legacy_holds (
 id text PRIMARY KEY,
 approval_instance_id text NOT NULL UNIQUE REFERENCES cdw_formal_approval_instances(id),
 subject_file_id text NOT NULL REFERENCES files(id),
 subject_sha256 text NOT NULL CHECK(subject_sha256 ~ '^[a-f0-9]{64}$'),
 template_version_id text NOT NULL REFERENCES cdw_workflow_template_versions(id),
 held_by text NOT NULL REFERENCES users(id),
 reason text NOT NULL CHECK(length(btrim(reason))>=16),
 completed_decisions integer NOT NULL CHECK(completed_decisions>=0),
 held_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER cdw_qms_formal_legacy_hold_immutable BEFORE UPDATE OR DELETE
 ON cdw_qms_formal_legacy_holds FOR EACH ROW EXECUTE FUNCTION cdw_prevent_fact_mutation();

CREATE FUNCTION cdw_qms_formal_legacy_hold_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inst record;
BEGIN
 SELECT a.state,a.requested_by,s.file_id,s.sha256,a.template_version_id,
 (SELECT count(*) FROM cdw_formal_approval_decisions d
  JOIN cdw_formal_approval_steps step ON step.id=d.step_id WHERE step.instance_id=a.id) signed_count
 INTO inst FROM cdw_formal_approval_instances a
 JOIN cdw_approval_subjects s ON s.id=a.subject_id
 WHERE a.id=NEW.approval_instance_id FOR UPDATE OF a;
 IF NOT FOUND OR inst.state<>'pending' OR inst.requested_by=NEW.held_by
  OR cdw_qms_special_kind(inst.file_id) IS NULL
  OR cdw_qms_special_authority_current(inst.file_id,inst.template_version_id)
  OR NEW.subject_file_id IS DISTINCT FROM inst.file_id
  OR NEW.subject_sha256 IS DISTINCT FROM inst.sha256
  OR NEW.template_version_id IS DISTINCT FROM inst.template_version_id
  OR NEW.completed_decisions IS DISTINCT FROM inst.signed_count
  OR NOT EXISTS (SELECT 1 FROM cdw_business_role_bindings b
   JOIN users u ON u.id=b.user_id
   WHERE b.user_id=NEW.held_by AND b.role='document_control'
    AND (b.file_id=inst.file_id OR b.file_id IS NULL)
    AND b.department_id IS NULL AND b.revoked_at IS NULL
    AND u.disabled_at IS NULL AND b.valid_from<=clock_timestamp()
    AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp())) THEN
   RAISE EXCEPTION 'Legacy quarantine requires an independently verified live anomaly'
     USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_qms_formal_legacy_hold_guard BEFORE INSERT ON cdw_qms_formal_legacy_holds
 FOR EACH ROW EXECUTE FUNCTION cdw_qms_formal_legacy_hold_guard();

CREATE FUNCTION cdw_qms_formal_legacy_hold_execute() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE cdw_formal_approval_instances SET state='conflicted',
  completed_at=clock_timestamp(),revision=revision+1
  WHERE id=NEW.approval_instance_id AND state='pending';
 UPDATE cdw_formal_approval_steps SET state='skipped',revision=revision+1
  WHERE instance_id=NEW.approval_instance_id AND state IN('ready','waiting');
 INSERT INTO cdw_domain_events(aggregate_kind,aggregate_id,event_kind,actor_id,request_id,details)
 VALUES('formal_approval',NEW.approval_instance_id,'qms_legacy_quarantined',NEW.held_by,
  'system:qms_legacy:'||NEW.id,jsonb_build_object('legacyHoldId',NEW.id,
   'reason',NEW.reason,'completedDecisions',NEW.completed_decisions));
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_qms_formal_legacy_hold_execute AFTER INSERT ON cdw_qms_formal_legacy_holds
 FOR EACH ROW EXECUTE FUNCTION cdw_qms_formal_legacy_hold_execute();

-- Live anomaly report: no irreversible operations during deployment.
CREATE VIEW cdw_qms_formal_legacy_pending_anomalies AS
 SELECT a.id approval_instance_id,a.requested_by,s.file_id,s.sha256,
  f.name file_name,a.template_version_id,a.requested_at,
  (SELECT count(*) FROM cdw_formal_approval_decisions d
   JOIN cdw_formal_approval_steps st ON st.id=d.step_id WHERE st.instance_id=a.id)
    completed_decisions
 FROM cdw_formal_approval_instances a
 JOIN cdw_approval_subjects s ON s.id=a.subject_id
 JOIN files f ON f.id=s.file_id AND f.deleted_at IS NULL
 WHERE a.state='pending' AND cdw_qms_special_kind(s.file_id) IS NOT NULL
  AND NOT cdw_qms_special_authority_current(s.file_id,a.template_version_id)
  AND NOT EXISTS(SELECT 1 FROM cdw_qms_formal_legacy_holds h
    WHERE h.approval_instance_id=a.id);

CREATE TABLE cdw_qms_formal_interruption_alerts (
 id text PRIMARY KEY,
 approval_instance_id text NOT NULL REFERENCES cdw_formal_approval_instances(id),
 recipient_id text NOT NULL REFERENCES users(id),
 event_kind text NOT NULL CHECK(event_kind IN('policy_interrupted','legacy_quarantined')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 read_at timestamptz,
 UNIQUE(approval_instance_id,recipient_id,event_kind)
);
CREATE INDEX cdw_qms_interruption_alerts_unread
 ON cdw_qms_formal_interruption_alerts(recipient_id,created_at DESC)
 WHERE read_at IS NULL;
CREATE FUNCTION cdw_qms_interruption_alert_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.id IS DISTINCT FROM OLD.id
  OR NEW.approval_instance_id IS DISTINCT FROM OLD.approval_instance_id
  OR NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
  OR NEW.event_kind IS DISTINCT FROM OLD.event_kind
  OR NEW.created_at IS DISTINCT FROM OLD.created_at OR OLD.read_at IS NOT NULL
  OR NEW.read_at IS NULL OR NEW.read_at<OLD.created_at THEN
   RAISE EXCEPTION 'Formal interruption notification is an immutable recipient fact'
    USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_qms_interruption_alert_immutable BEFORE UPDATE OR DELETE
 ON cdw_qms_formal_interruption_alerts FOR EACH ROW
 EXECUTE FUNCTION cdw_qms_interruption_alert_immutable();

CREATE FUNCTION cdw_qms_emit_formal_interruption_alerts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_type text;
BEGIN
 IF TG_TABLE_NAME='cdw_qms_formal_policy_interruptions' THEN
  event_type:='policy_interrupted';
 ELSE
  event_type:='legacy_quarantined';
 END IF;
 INSERT INTO cdw_qms_formal_interruption_alerts(id,approval_instance_id,recipient_id,event_kind)
 SELECT 'cdwqmsformalalert_'||md5(NEW.approval_instance_id||':'||recipient.user_id||':'||event_type),
  NEW.approval_instance_id,recipient.user_id,event_type
 FROM (
  SELECT requested_by user_id FROM cdw_formal_approval_instances
   WHERE id=NEW.approval_instance_id
  UNION SELECT approver_user_id FROM cdw_formal_approval_steps
   WHERE instance_id=NEW.approval_instance_id
  UNION SELECT a.verified_by FROM cdw_qms_formal_policy_interruptions h
   JOIN cdw_qms_special_authorities a ON a.id=h.authority_id
   WHERE h.approval_instance_id=NEW.approval_instance_id AND a.verified_by IS NOT NULL
 ) recipient JOIN users u ON u.id=recipient.user_id
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_qms_notify_formal_interruption AFTER INSERT
 ON cdw_qms_formal_policy_interruptions FOR EACH ROW
 EXECUTE FUNCTION cdw_qms_emit_formal_interruption_alerts();
CREATE TRIGGER cdw_qms_notify_legacy_hold AFTER INSERT
 ON cdw_qms_formal_legacy_holds FOR EACH ROW
 EXECUTE FUNCTION cdw_qms_emit_formal_interruption_alerts();

-- This is only a new approval lineage edge, not a resumption of prior signed
-- steps or a grant of regulatory signatory authority.
CREATE TABLE cdw_qms_formal_restarts (
 id text PRIMARY KEY,
 previous_approval_id text NOT NULL REFERENCES cdw_formal_approval_instances(id),
 new_approval_id text NOT NULL UNIQUE REFERENCES cdw_formal_approval_instances(id),
 file_id text NOT NULL REFERENCES files(id),
 previous_sha256 text NOT NULL CHECK(previous_sha256 ~ '^[a-f0-9]{64}$'),
 new_sha256 text NOT NULL CHECK(new_sha256 ~ '^[a-f0-9]{64}$'),
 submitted_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(previous_approval_id<>new_approval_id)
);
CREATE TRIGGER cdw_qms_formal_restart_immutable BEFORE UPDATE OR DELETE
 ON cdw_qms_formal_restarts FOR EACH ROW EXECUTE FUNCTION cdw_prevent_fact_mutation();
CREATE FUNCTION cdw_qms_formal_restart_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev record; next_approval record;
BEGIN
 SELECT a.state,a.requested_by,s.file_id,s.sha256 INTO prev
 FROM cdw_formal_approval_instances a JOIN cdw_approval_subjects s ON s.id=a.subject_id
 WHERE a.id=NEW.previous_approval_id;
 SELECT a.state,a.requested_by,a.template_version_id,s.file_id,s.sha256 INTO next_approval
 FROM cdw_formal_approval_instances a JOIN cdw_approval_subjects s ON s.id=a.subject_id
 WHERE a.id=NEW.new_approval_id;
 IF prev.state<>'conflicted' OR next_approval.state<>'pending'
  OR prev.file_id IS DISTINCT FROM next_approval.file_id
  OR NEW.file_id IS DISTINCT FROM prev.file_id
  OR NEW.previous_sha256 IS DISTINCT FROM prev.sha256
  OR NEW.new_sha256 IS DISTINCT FROM next_approval.sha256
  OR NEW.submitted_by IS DISTINCT FROM next_approval.requested_by
  OR NOT cdw_qms_special_authority_current(next_approval.file_id,next_approval.template_version_id)
  OR NOT EXISTS(SELECT 1 FROM cdw_qms_formal_policy_interruptions h
    WHERE h.approval_instance_id=NEW.previous_approval_id)
    AND NOT EXISTS(SELECT 1 FROM cdw_qms_formal_legacy_holds h
    WHERE h.approval_instance_id=NEW.previous_approval_id)
 THEN RAISE EXCEPTION 'Restart must link a conflicting prior DHF/DMR approval to a newly authorized file'
   USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_qms_formal_restart_guard BEFORE INSERT ON cdw_qms_formal_restarts
 FOR EACH ROW EXECUTE FUNCTION cdw_qms_formal_restart_guard();

-- Prevent SQL resurrection and falsified decisions for legacy quarantines.
CREATE OR REPLACE FUNCTION cdw_qms_interruption_no_resurrection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state='conflicted' AND (
  EXISTS(SELECT 1 FROM cdw_qms_formal_policy_interruptions h WHERE h.approval_instance_id=OLD.id)
  OR EXISTS(SELECT 1 FROM cdw_qms_formal_legacy_holds h WHERE h.approval_instance_id=OLD.id)
 ) AND (NEW.state<>'conflicted' OR NEW.completed_at IS DISTINCT FROM OLD.completed_at)
 THEN RAISE EXCEPTION 'Quarantined formal approval cannot resume' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION cdw_qms_interruption_no_forged_decisions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM cdw_formal_approval_steps s WHERE s.id=NEW.step_id AND (
  EXISTS(SELECT 1 FROM cdw_qms_formal_policy_interruptions h WHERE h.approval_instance_id=s.instance_id)
  OR EXISTS(SELECT 1 FROM cdw_qms_formal_legacy_holds h WHERE h.approval_instance_id=s.instance_id)
 )) THEN RAISE EXCEPTION 'Quarantined formal approval cannot be signed' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION cdw_qms_interruption_no_candidate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM cdw_qms_formal_policy_interruptions h WHERE h.approval_instance_id=NEW.approval_instance_id)
  OR EXISTS(SELECT 1 FROM cdw_qms_formal_legacy_holds h WHERE h.approval_instance_id=NEW.approval_instance_id)
 THEN RAISE EXCEPTION 'Quarantined approval cannot produce candidate' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
