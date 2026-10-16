-- Return/reject are immutable terminal outcomes of an individual proposal.
-- A corrected proposal gets its own ID, leaving review history intact.
ALTER TABLE cdw_qms_special_authorities DROP CONSTRAINT cdw_qms_special_authorities_status_check;
ALTER TABLE cdw_qms_special_authorities ADD CONSTRAINT cdw_qms_special_authorities_status_check
 CHECK(status IN('pending','verified','revoked','returned','rejected'));
ALTER TABLE cdw_qms_special_authorities ADD COLUMN reviewed_by text REFERENCES users(id);
ALTER TABLE cdw_qms_special_authorities ADD COLUMN reviewed_at timestamptz;
ALTER TABLE cdw_qms_special_authorities ADD COLUMN review_reason text;
-- Existing records remain historical, but cannot authorize anything without
-- newly reviewed clause-by-clause evidence.
ALTER TABLE cdw_qms_special_authorities ADD COLUMN node_claims jsonb;
-- Replace the old CHECK which required verification fields for every
-- non-pending state, including the newly introduced terminal review outcomes.
DO $$
DECLARE name text;
BEGIN
 SELECT conname INTO name FROM pg_constraint
 WHERE conrelid='cdw_qms_special_authorities'::regclass AND contype='c'
 AND pg_get_constraintdef(oid) LIKE '%verified_by IS NOT NULL%'
 AND pg_get_constraintdef(oid) LIKE '%status%pending%'
 ORDER BY conname LIMIT 1;
 IF name IS NULL THEN RAISE EXCEPTION 'Cannot locate original special-authority status evidence constraint'; END IF;
 EXECUTE format('ALTER TABLE cdw_qms_special_authorities DROP CONSTRAINT %I',name);
END $$;
ALTER TABLE cdw_qms_special_authorities ADD CONSTRAINT cdw_special_verified_evidence
 CHECK (status NOT IN('verified','revoked') OR
  (verified_by IS NOT NULL AND verified_at IS NOT NULL AND verifier_binding_id IS NOT NULL
   AND length(btrim(verification_statement))>=16));
ALTER TABLE cdw_qms_special_authorities ADD CONSTRAINT cdw_special_review_terminal
 CHECK (status NOT IN('returned','rejected') OR
   (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND length(btrim(review_reason))>=16));
ALTER TABLE cdw_qms_special_authorities ADD CONSTRAINT cdw_special_node_claims_array
 CHECK(node_claims IS NULL OR
  (jsonb_typeof(node_claims)='array' AND jsonb_array_length(node_claims) BETWEEN 1 AND 30));

-- Each published template node has exactly one independent clause claim.
-- This is evidence coverage, not an automatic interpretation of legislation.
CREATE FUNCTION cdw_qms_special_node_claims_match(template text, claims jsonb)
 RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT COALESCE(
  jsonb_typeof(claims)='array' AND jsonb_array_length(claims) BETWEEN 1 AND 30
  AND EXISTS(SELECT 1 FROM cdw_workflow_template_versions tv
   WHERE tv.id=template AND tv.lifecycle='published'
    AND jsonb_typeof(tv.graph->'steps')='array'
    AND jsonb_array_length(tv.graph->'steps')=jsonb_array_length(claims)
    AND NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(tv.graph->'steps') step
      WHERE NOT EXISTS(
       SELECT 1 FROM jsonb_array_elements(claims) claim
       WHERE jsonb_typeof(claim)='object'
        AND claim->>'nodeKey'=step->>'nodeKey'
        AND length(btrim(COALESCE(claim->>'clauseRef','')))>=2
        AND length(btrim(COALESCE(claim->>'basisSummary','')))>=8
      )
    )
    AND NOT EXISTS(
     SELECT 1 FROM jsonb_array_elements(claims) claim
     WHERE jsonb_typeof(claim)<>'object'
       OR (SELECT count(*) FROM jsonb_object_keys(claim))<>3
       OR NOT claim ?& ARRAY['nodeKey','clauseRef','basisSummary']
       OR (SELECT count(*) FROM jsonb_array_elements(claims) dup
           WHERE dup->>'nodeKey'=claim->>'nodeKey')<>1
    )
  ),false) $$;

CREATE TABLE cdw_qms_special_alerts(
 id text PRIMARY KEY,
 authority_id text NOT NULL REFERENCES cdw_qms_special_authorities(id),
 recipient_id text NOT NULL REFERENCES users(id),
 event_kind text NOT NULL CHECK(event_kind IN('returned','rejected','revoked')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 read_at timestamptz,
 UNIQUE(authority_id,recipient_id,event_kind)
);
CREATE INDEX cdw_qms_special_alerts_unread
 ON cdw_qms_special_alerts(recipient_id,created_at DESC) WHERE read_at IS NULL;
CREATE FUNCTION cdw_qms_special_alert_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.authority_id IS DISTINCT FROM OLD.authority_id
    OR NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
    OR NEW.event_kind IS DISTINCT FROM OLD.event_kind
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR OLD.read_at IS NOT NULL OR
    (NEW.read_at IS NOT NULL AND NEW.read_at<OLD.created_at) THEN
  RAISE EXCEPTION 'Special review alert is append-only' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_qms_special_alert_immutable BEFORE UPDATE OR DELETE
 ON cdw_qms_special_alerts FOR EACH ROW EXECUTE FUNCTION cdw_qms_special_alert_immutable_guard();
-- Refuse privileged direct DML that skips durable notices.
CREATE FUNCTION cdw_qms_special_emit_alerts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status IN('returned','rejected','revoked') AND NEW.status<>OLD.status THEN
  INSERT INTO cdw_qms_special_alerts(id,authority_id,recipient_id,event_kind)
  SELECT 'cdw_special_alert_'||md5(NEW.id||':'||people.user_id||':'||NEW.status),
   NEW.id,people.user_id,NEW.status
  FROM (
   SELECT NEW.proposed_by AS user_id
   UNION SELECT NEW.verified_by WHERE NEW.verified_by IS NOT NULL
   UNION SELECT (node->>'approverId') FROM cdw_workflow_template_versions tv,
     LATERAL jsonb_array_elements(tv.graph->'steps') node
     WHERE NEW.status='revoked' AND tv.id=NEW.template_version_id
  ) people JOIN users u ON u.id=people.user_id AND u.disabled_at IS NULL
  ON CONFLICT (authority_id,recipient_id,event_kind) DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_qms_special_emit_alerts AFTER UPDATE ON cdw_qms_special_authorities
 FOR EACH ROW EXECUTE FUNCTION cdw_qms_special_emit_alerts();

CREATE OR REPLACE FUNCTION cdw_qms_special_authority_current(fid text, template text)
 RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(
  SELECT 1 FROM cdw_qms_special_authorities a
  JOIN cdw_workflow_template_versions tv ON tv.id=a.template_version_id
  JOIN cdw_controlled_releases rel ON rel.id=a.policy_release_id
  WHERE a.file_id=fid AND a.template_version_id=template
   AND a.status='verified' AND a.kind=cdw_qms_special_kind(fid)
   AND tv.lifecycle='published' AND tv.authority_basis_release_id=a.policy_release_id
   AND lower(tv.template_key) ~ '^(cdw_)?qms_'
   AND rel.file_id<>fid AND cdw_qms_special_node_claims_match(a.template_version_id,a.node_claims)
   AND cdw_qms_special_policy_qualified(a.kind,a.policy_release_id)
 ) $$;

CREATE OR REPLACE FUNCTION cdw_qms_special_authority_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'Dedicated authority evidence is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'pending' OR NEW.verified_by IS NOT NULL OR NEW.revoked_by IS NOT NULL
    OR NEW.reviewed_by IS NOT NULL OR NEW.kind IS DISTINCT FROM cdw_qms_special_kind(NEW.file_id)
    OR NOT cdw_qms_special_node_claims_match(NEW.template_version_id,NEW.node_claims) THEN
   RAISE EXCEPTION 'Dedicated proposal needs complete exact node clauses' USING ERRCODE='23514';
  END IF;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.file_id IS DISTINCT FROM OLD.file_id
   OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.template_version_id IS DISTINCT FROM OLD.template_version_id
   OR NEW.policy_release_id IS DISTINCT FROM OLD.policy_release_id
   OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.node_claims IS DISTINCT FROM OLD.node_claims
   OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by OR NEW.proposed_at IS DISTINCT FROM OLD.proposed_at
   OR OLD.status IN('revoked','returned','rejected')
   OR (OLD.status='pending' AND NEW.status NOT IN('verified','returned','rejected'))
   OR (OLD.status='verified' AND NEW.status<>'revoked') THEN
   RAISE EXCEPTION 'Dedicated authority cannot be rewritten' USING ERRCODE='23514';
  END IF;
  IF OLD.status='verified' AND (
   NEW.verified_by IS DISTINCT FROM OLD.verified_by OR
   NEW.verified_at IS DISTINCT FROM OLD.verified_at OR
   NEW.verifier_binding_id IS DISTINCT FROM OLD.verifier_binding_id OR
   NEW.verification_statement IS DISTINCT FROM OLD.verification_statement) THEN
   RAISE EXCEPTION 'Dedicated verification is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.status IN('verified','returned','rejected') AND OLD.status='pending' THEN
   IF NEW.verified_by IS NULL AND NEW.status='verified' THEN
    RAISE EXCEPTION 'Verified record requires reviewer' USING ERRCODE='23514';
   END IF;
   IF NEW.status='verified' THEN
    IF NEW.verified_by=OLD.proposed_by OR NEW.verified_at IS NULL
     OR length(btrim(NEW.verification_statement))<16
     OR NOT cdw_qms_special_node_claims_match(NEW.template_version_id,NEW.node_claims)
     OR NOT cdw_qms_special_policy_qualified(NEW.kind,NEW.policy_release_id)
     OR NOT EXISTS(SELECT 1 FROM cdw_workflow_template_versions tv
       JOIN cdw_controlled_releases rel ON rel.id=NEW.policy_release_id
       WHERE tv.id=NEW.template_version_id AND tv.lifecycle='published'
        AND lower(tv.template_key) ~ '^(cdw_)?qms_'
        AND tv.authority_basis_release_id=NEW.policy_release_id AND rel.file_id<>NEW.file_id)
    THEN RAISE EXCEPTION 'Dedicated approval lacks valid matching source'
      USING ERRCODE='23514'; END IF;
   ELSE
    IF NEW.reviewed_by IS NULL OR NEW.reviewed_by=OLD.proposed_by
     OR NEW.reviewed_at IS NULL OR length(btrim(NEW.review_reason))<16 THEN
     RAISE EXCEPTION 'Return/reject requires independent reason' USING ERRCODE='23514';
    END IF;
   END IF;
   IF NOT EXISTS(
    SELECT 1 FROM cdw_business_role_bindings b JOIN users u ON u.id=b.user_id
    WHERE b.user_id=CASE WHEN NEW.status='verified' THEN NEW.verified_by ELSE NEW.reviewed_by END
     AND b.role='document_control'
     AND (b.file_id=NEW.file_id OR b.file_id IS NULL)
     AND b.department_id IS NULL AND b.revoked_at IS NULL AND u.disabled_at IS NULL
     AND b.valid_from<=clock_timestamp() AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp())
     AND (NEW.status<>'verified' OR b.id=NEW.verifier_binding_id)
   ) THEN RAISE EXCEPTION 'Independent document controller required' USING ERRCODE='23514'; END IF;
  END IF;
  IF OLD.status='verified' AND NEW.status='revoked' THEN
   IF NEW.revoked_by IS NULL OR NEW.revoked_by=OLD.proposed_by
    OR NEW.revoked_at IS NULL OR length(btrim(NEW.revocation_reason))<16
    OR NOT EXISTS(SELECT 1 FROM cdw_business_role_bindings b JOIN users u ON u.id=b.user_id
      WHERE b.user_id=NEW.revoked_by AND b.role='document_control'
      AND (b.file_id=OLD.file_id OR b.file_id IS NULL)
      AND b.department_id IS NULL AND b.revoked_at IS NULL AND u.disabled_at IS NULL
      AND b.valid_from<=clock_timestamp() AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp()))
    THEN RAISE EXCEPTION 'Independent controller required for revocation' USING ERRCODE='23514'; END IF;
  ELSIF NEW.revoked_by IS DISTINCT FROM OLD.revoked_by
    OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
    OR NEW.revocation_reason IS DISTINCT FROM OLD.revocation_reason THEN
   RAISE EXCEPTION 'Revocation evidence immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.status NOT IN('returned','rejected') AND (
   NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
   OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
   OR NEW.review_reason IS DISTINCT FROM OLD.review_reason) THEN
   RAISE EXCEPTION 'Rejection evidence immutable' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
