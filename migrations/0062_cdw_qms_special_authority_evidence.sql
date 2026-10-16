-- DHF/DMR: a general QMS policy and generic signer appointment are never
-- sufficient to prove the dedicated approval rule entrusted by ZS-QP-09.
-- This is a technical evidence gate, not an automatic legal determination.
CREATE FUNCTION cdw_qms_special_kind(fid text) RETURNS text
 LANGUAGE sql STABLE AS $$
 SELECT CASE
  WHEN f.name ~ '(产品设计历史文档管理规定|设计历史文档管理规定|产品器械主文档管理规定|器械主文档管理规定)' THEN NULL
  WHEN lower(COALESCE(p.document_type,''))='dhf'
   OR f.name ~* '(^|[^a-z])DHF([^a-z]|$)'
   OR f.name ~ '(产品设计历史文档|设计历史文件)'
  THEN 'dhf'
  WHEN lower(COALESCE(p.document_type,''))='dmr'
   OR f.name ~* '(^|[^a-z])DMR([^a-z]|$)'
   OR f.name ~ '(器械主文档|产品器械主文档)'
  THEN 'dmr'
  ELSE NULL END
 FROM files f LEFT JOIN cdw_document_profiles p ON p.file_id=f.id
 WHERE f.id=fid AND f.deleted_at IS NULL
 $$;
CREATE FUNCTION cdw_qms_special_policy_qualified(kind text, policy text)
 RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(
  SELECT 1 FROM cdw_controlled_releases r
  JOIN files source_file ON source_file.id=r.file_id AND source_file.deleted_at IS NULL
  JOIN cdw_document_profiles profile ON profile.file_id=r.file_id
    AND profile.approval_class='qms'
  WHERE r.id=policy AND cdw_qms_policy_release_effective(r.id)
   AND ((kind='dhf' AND source_file.name ~ '(产品设计历史文档管理规定|设计历史文档管理规定)')
    OR (kind='dmr' AND source_file.name ~ '(产品器械主文档管理规定|器械主文档管理规定)'))
 ) $$;

CREATE TABLE cdw_qms_special_authorities (
 id text PRIMARY KEY,
 file_id text NOT NULL REFERENCES files(id),
 kind text NOT NULL CHECK(kind IN ('dhf','dmr')),
 template_version_id text NOT NULL REFERENCES cdw_workflow_template_versions(id),
 policy_release_id text NOT NULL REFERENCES cdw_controlled_releases(id),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','verified','revoked')),
 reason text NOT NULL CHECK(length(btrim(reason))>=16),
 proposed_by text NOT NULL REFERENCES users(id),
 proposed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 verified_by text REFERENCES users(id),
 verified_at timestamptz,
 verifier_binding_id text REFERENCES cdw_business_role_bindings(id),
 verification_statement text,
 revoked_by text REFERENCES users(id),
 revoked_at timestamptz,
 revocation_reason text,
 CHECK(status='pending' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL
  AND verifier_binding_id IS NOT NULL AND length(btrim(verification_statement))>=16)),
 CHECK(status<>'revoked' OR (revoked_by IS NOT NULL AND revoked_at IS NOT NULL
  AND length(btrim(revocation_reason))>=16)),
 CHECK(verified_by IS NULL OR proposed_by<>verified_by),
 CHECK(revoked_by IS NULL OR revoked_by<>proposed_by)
);
CREATE INDEX cdw_qms_special_review ON cdw_qms_special_authorities(file_id,status,proposed_at DESC);
CREATE UNIQUE INDEX cdw_qms_special_one_live_evidence
 ON cdw_qms_special_authorities(file_id,template_version_id)
 WHERE status IN('pending','verified');

-- Once identified as DHF/DMR for a special-authority request, no ordinary
-- file rename can turn the same immutable file ID into a generic document.
CREATE OR REPLACE FUNCTION cdw_qms_special_kind(fid text) RETURNS text
 LANGUAGE sql STABLE AS $$
 SELECT COALESCE(
  (SELECT a.kind FROM cdw_qms_special_authorities a
   WHERE a.file_id=fid ORDER BY a.proposed_at,a.id LIMIT 1),
  (SELECT CASE
    WHEN f.name ~ '(产品设计历史文档管理规定|设计历史文档管理规定|产品器械主文档管理规定|器械主文档管理规定)' THEN NULL
    WHEN lower(COALESCE(p.document_type,''))='dhf'
      OR f.name ~* '(^|[^a-z])DHF([^a-z]|$)'
      OR f.name ~ '(产品设计历史文档|设计历史文件)' THEN 'dhf'
    WHEN lower(COALESCE(p.document_type,''))='dmr'
      OR f.name ~* '(^|[^a-z])DMR([^a-z]|$)'
      OR f.name ~ '(器械主文档|产品器械主文档)' THEN 'dmr'
    ELSE NULL END
   FROM files f LEFT JOIN cdw_document_profiles p ON p.file_id=f.id
   WHERE f.id=fid AND f.deleted_at IS NULL)
 ) $$;

CREATE FUNCTION cdw_qms_special_authority_current(fid text, template text)
 RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(
  SELECT 1 FROM cdw_qms_special_authorities a
  JOIN cdw_workflow_template_versions tv ON tv.id=a.template_version_id
  JOIN cdw_controlled_releases rel ON rel.id=a.policy_release_id
  WHERE a.file_id=fid AND a.template_version_id=template
   AND a.status='verified' AND a.kind=cdw_qms_special_kind(fid)
   AND tv.lifecycle='published' AND tv.authority_basis_release_id=a.policy_release_id
   AND lower(tv.template_key) ~ '^(cdw_)?qms_'
   AND rel.file_id<>fid
   AND cdw_qms_special_policy_qualified(a.kind,a.policy_release_id)
 ) $$;

CREATE FUNCTION cdw_qms_special_authority_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'Dedicated authority evidence is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' AND (NEW.status<>'pending' OR NEW.verified_by IS NOT NULL
    OR NEW.revoked_by IS NOT NULL OR NEW.kind IS DISTINCT FROM cdw_qms_special_kind(NEW.file_id)) THEN
  RAISE EXCEPTION 'Dedicated authority requires classified pending evidence' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.file_id IS DISTINCT FROM OLD.file_id
   OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.template_version_id IS DISTINCT FROM OLD.template_version_id
   OR NEW.policy_release_id IS DISTINCT FROM OLD.policy_release_id
   OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by
   OR NEW.proposed_at IS DISTINCT FROM OLD.proposed_at OR OLD.status='revoked'
   OR (OLD.status='pending' AND NEW.status<>'verified')
   OR (OLD.status='verified' AND NEW.status<>'revoked') THEN
   RAISE EXCEPTION 'Dedicated authority cannot be rewritten' USING ERRCODE='23514';
  END IF;
  IF OLD.status='verified' AND (
   NEW.verified_by IS DISTINCT FROM OLD.verified_by OR
   NEW.verified_at IS DISTINCT FROM OLD.verified_at OR
   NEW.verifier_binding_id IS DISTINCT FROM OLD.verifier_binding_id OR
   NEW.verification_statement IS DISTINCT FROM OLD.verification_statement) THEN
   RAISE EXCEPTION 'Dedicated authority verification is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.status='pending' AND NEW.status='verified' THEN
   IF NEW.verified_by IS NULL OR NEW.verified_by=OLD.proposed_by
    OR NEW.verified_at IS NULL OR length(btrim(NEW.verification_statement))<16
    OR NOT EXISTS (
     SELECT 1 FROM cdw_business_role_bindings b JOIN users u ON u.id=b.user_id
     WHERE b.id=NEW.verifier_binding_id AND b.user_id=NEW.verified_by
      AND b.role='document_control' AND u.disabled_at IS NULL
      AND (b.file_id=OLD.file_id OR b.file_id IS NULL)
      AND b.department_id IS NULL AND b.revoked_at IS NULL
      AND b.valid_from<=clock_timestamp() AND
       (b.expires_at IS NULL OR b.expires_at>clock_timestamp())
    ) OR NEW.kind IS DISTINCT FROM cdw_qms_special_kind(NEW.file_id)
    OR NOT cdw_qms_special_policy_qualified(NEW.kind,NEW.policy_release_id)
    OR NOT EXISTS (
     SELECT 1 FROM cdw_workflow_template_versions tv
     JOIN cdw_controlled_releases rel ON rel.id=NEW.policy_release_id
     WHERE tv.id=NEW.template_version_id AND tv.lifecycle='published'
      AND lower(tv.template_key) ~ '^(cdw_)?qms_'
      AND tv.authority_basis_release_id=NEW.policy_release_id
      AND rel.file_id<>NEW.file_id
    ) THEN
    RAISE EXCEPTION 'Dedicated authority lacks independent valid specific basis'
      USING ERRCODE='23514';
   END IF;
  END IF;
  IF OLD.status='verified' AND NEW.status='revoked' THEN
   IF NEW.revoked_by IS NULL OR NEW.revoked_by=OLD.proposed_by OR NEW.revoked_at IS NULL
    OR length(btrim(NEW.revocation_reason))<16
    OR NOT EXISTS (
     SELECT 1 FROM cdw_business_role_bindings b JOIN users u ON u.id=b.user_id
     WHERE b.user_id=NEW.revoked_by AND b.role='document_control'
      AND (b.file_id=OLD.file_id OR b.file_id IS NULL)
      AND b.revoked_at IS NULL AND u.disabled_at IS NULL AND b.department_id IS NULL
      AND b.valid_from<=clock_timestamp()
      AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp())
    ) THEN
    RAISE EXCEPTION 'Only independent document control may revoke dedicated authority'
      USING ERRCODE='23514';
   END IF;
  ELSIF NEW.revoked_by IS DISTINCT FROM OLD.revoked_by OR
    NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR
    NEW.revocation_reason IS DISTINCT FROM OLD.revocation_reason THEN
   RAISE EXCEPTION 'Dedicated revocation evidence cannot be altered' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_qms_special_authority_guard
 BEFORE INSERT OR UPDATE OR DELETE ON cdw_qms_special_authorities
 FOR EACH ROW EXECUTE FUNCTION cdw_qms_special_authority_guard();

-- BOTH insert and decision guards enforce the exact file/template/release
-- pairing. A direct SQL write cannot bypass the independently reviewed basis.
CREATE OR REPLACE FUNCTION cdw_qms_special_formal_submission_guard() RETURNS trigger
 LANGUAGE plpgsql AS $$
DECLARE fid text;
BEGIN
 SELECT file_id INTO fid FROM cdw_approval_subjects WHERE id=NEW.subject_id;
 IF cdw_qms_special_kind(fid) IS NOT NULL AND
   NOT cdw_qms_special_authority_current(fid,NEW.template_version_id) THEN
  RAISE EXCEPTION 'DHF/DMR dedicated signatory authority is pending'
   USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION cdw_qms_special_formal_decision_guard() RETURNS trigger
 LANGUAGE plpgsql AS $$
DECLARE fid text; template text;
BEGIN
 SELECT sub.file_id,i.template_version_id INTO fid,template
 FROM cdw_formal_approval_steps st
 JOIN cdw_formal_approval_instances i ON i.id=st.instance_id
 JOIN cdw_approval_subjects sub ON sub.id=i.subject_id WHERE st.id=NEW.step_id;
 IF cdw_qms_special_kind(fid) IS NOT NULL AND
   NOT cdw_qms_special_authority_current(fid,template) THEN
  RAISE EXCEPTION 'DHF/DMR signing authority no longer valid'
   USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
