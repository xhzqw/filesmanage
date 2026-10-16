-- Formal QMS signer qualification is distinct from an administrator's
-- technical role grant. An appointment is not effective until an independent
-- authorized document controller verifies its CURRENT controlled evidence.
CREATE TABLE cdw_qms_appointments (
 id text PRIMARY KEY,
 file_id text NOT NULL REFERENCES files(id),
 user_id text NOT NULL REFERENCES users(id),
 node_key text NOT NULL CHECK(node_key ~ '^[a-z][a-z0-9_]{2,63}$'),
 policy_release_id text NOT NULL REFERENCES cdw_controlled_releases(id),
 evidence_release_id text NOT NULL REFERENCES cdw_controlled_releases(id),
 valid_from timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','verified','revoked')),
 proposed_by text NOT NULL REFERENCES users(id),
 proposed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 reason text NOT NULL CHECK(length(btrim(reason))>=16),
 verified_by text REFERENCES users(id),
 verified_at timestamptz,
 verifier_binding_id text REFERENCES cdw_business_role_bindings(id),
 verification_reason text,
 revoked_by text REFERENCES users(id),
 revoked_at timestamptz,
 CHECK(expires_at>valid_from),
 CHECK(status='pending' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL
  AND verifier_binding_id IS NOT NULL AND length(btrim(verification_reason))>=16)),
 CHECK(status<>'revoked' OR (revoked_by IS NOT NULL AND revoked_at IS NOT NULL)),
 CHECK(proposed_by<>user_id),
 CHECK(verified_by IS NULL OR (verified_by<>user_id AND verified_by<>proposed_by))
);
CREATE INDEX cdw_qms_appointment_lookup ON cdw_qms_appointments
 (file_id,user_id,node_key,policy_release_id,status,expires_at);

CREATE FUNCTION cdw_qms_appointment_current(fid text, person text, step_key text, policy_id text)
 RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(
  SELECT 1 FROM cdw_qms_appointments a JOIN users u ON u.id=a.user_id
  WHERE a.file_id=fid AND a.user_id=person AND a.node_key=step_key
   AND a.policy_release_id=policy_id AND a.status='verified'
   AND a.valid_from<=clock_timestamp() AND a.expires_at>clock_timestamp()
   AND u.disabled_at IS NULL
   AND cdw_qms_policy_release_effective(a.policy_release_id)
   AND cdw_qms_policy_release_effective(a.evidence_release_id)
 ) $$;

CREATE FUNCTION cdw_qms_appointment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
     OR OLD.status='revoked' OR (OLD.status='verified' AND NEW.status<>'revoked') THEN
   RAISE EXCEPTION 'QMS appointment evidence cannot be rewritten' USING ERRCODE='23514';
  END IF;
  IF (OLD.status='pending' AND NEW.status<>'verified')
      OR (OLD.status='verified' AND (
       NEW.verified_by IS DISTINCT FROM OLD.verified_by
       OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
       OR NEW.verifier_binding_id IS DISTINCT FROM OLD.verifier_binding_id
       OR NEW.verification_reason IS DISTINCT FROM OLD.verification_reason)) THEN
   RAISE EXCEPTION 'QMS verification history is immutable' USING ERRCODE='23514';
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
    RAISE EXCEPTION 'QMS appointment lacks independent current verification'
      USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_qms_appointment_guard
 BEFORE INSERT OR UPDATE OR DELETE ON cdw_qms_appointments
 FOR EACH ROW EXECUTE FUNCTION cdw_qms_appointment_guard();

-- Defence in depth: even direct SQL inserting decisions must respect current
-- QMS appointment evidence for the actor AND the exact workflow node.
CREATE FUNCTION cdw_qms_appointment_decision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 fid text;
 node_name text;
 policy_id text;
 template_key text;
BEGIN
 SELECT s.file_id,st.node_key,tv.authority_basis_release_id,tv.template_key
 INTO fid,node_name,policy_id,template_key
 FROM cdw_formal_approval_steps st
 JOIN cdw_formal_approval_instances a ON a.id=st.instance_id
 JOIN cdw_approval_subjects s ON s.id=a.subject_id
 JOIN cdw_workflow_template_versions tv ON tv.id=a.template_version_id
 WHERE st.id=NEW.step_id;
 IF lower(template_key) ~ '^(cdw_)?qms_'
    AND NOT cdw_qms_appointment_current(fid,NEW.actor_id,node_name,policy_id) THEN
   RAISE EXCEPTION 'QMS decision requires verified, unexpired appointment for the step'
    USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_qms_appointment_decision_guard
 BEFORE INSERT ON cdw_formal_approval_decisions
 FOR EACH ROW EXECUTE FUNCTION cdw_qms_appointment_decision_guard();
