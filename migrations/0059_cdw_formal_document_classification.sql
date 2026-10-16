-- QMS routing is a property of the FILE, never an untrusted template name or
-- request-side toggle. No previous unclassified file is silently "general".
ALTER TABLE cdw_document_profiles
 ADD COLUMN approval_class text NOT NULL DEFAULT 'pending'
   CHECK (approval_class IN ('pending','general','qms')),
 ADD COLUMN classification_reason text,
 ADD COLUMN classified_by text REFERENCES users(id),
 ADD COLUMN classified_at timestamptz,
 ADD COLUMN classification_role_binding_id text REFERENCES cdw_business_role_bindings(id),
 ADD CONSTRAINT cdw_document_class_evidence CHECK (
  approval_class='pending' OR
  (length(btrim(classification_reason))>=16 AND classified_by IS NOT NULL
   AND classified_at IS NOT NULL AND classification_role_binding_id IS NOT NULL)
 );

CREATE FUNCTION cdw_formal_document_must_be_qms(fid text) RETURNS boolean
 LANGUAGE sql STABLE AS $$
 SELECT EXISTS(
  SELECT 1 FROM files f LEFT JOIN cdw_document_profiles p ON p.file_id=f.id
  WHERE f.id=fid AND
   (COALESCE(p.managed,false) OR p.controlled_code IS NOT NULL
    OR f.name ~* '^(ZS-QP[-_0-9]|WI-ZL[-_0-9]|QP-[0-9]+)'
    OR f.name ~ '(质量手册|控制程序|作业指导书|器械主文档|设计历史文档)')
 ) $$;

CREATE FUNCTION cdw_formal_document_class_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.approval_class<>'pending'
    AND NEW.approval_class IS DISTINCT FROM OLD.approval_class THEN
  RAISE EXCEPTION 'CDW documented classification is immutable'
   USING ERRCODE='23514';
 END IF;
 IF NEW.approval_class='general' AND
   (NEW.managed OR NEW.controlled_code IS NOT NULL
    OR cdw_formal_document_must_be_qms(NEW.file_id)) THEN
  RAISE EXCEPTION 'Controlled/QMS documents cannot be classified as general'
   USING ERRCODE='23514';
 END IF;
 IF NEW.approval_class<>'pending' AND NOT EXISTS(
  SELECT 1 FROM cdw_business_role_bindings b JOIN users u ON u.id=b.user_id
  WHERE b.id=NEW.classification_role_binding_id AND b.role='document_control'
    AND b.user_id=NEW.classified_by AND u.disabled_at IS NULL
    AND b.department_id IS NULL
    AND (b.file_id=NEW.file_id OR b.file_id IS NULL)
    AND b.valid_from<=now() AND (b.expires_at IS NULL OR b.expires_at>now())
    AND b.revoked_at IS NULL AND NEW.classified_at <= clock_timestamp()
 ) THEN
  RAISE EXCEPTION 'Classification requires current document-control authority'
   USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_formal_document_class_guard
 BEFORE INSERT OR UPDATE ON cdw_document_profiles
 FOR EACH ROW EXECUTE FUNCTION cdw_formal_document_class_guard();

CREATE FUNCTION cdw_formal_classified_submission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 fid text;
 category text;
 tmpl text;
 basis text;
BEGIN
 SELECT s.file_id,tv.template_key,tv.authority_basis_release_id
 INTO fid,tmpl,basis
 FROM cdw_approval_subjects s CROSS JOIN cdw_workflow_template_versions tv
 WHERE s.id=NEW.subject_id AND tv.id=NEW.template_version_id;
 SELECT p.approval_class INTO category FROM cdw_document_profiles p WHERE p.file_id=fid;
 IF category IS NULL OR category='pending' OR
    (category='general' AND cdw_formal_document_must_be_qms(fid)) THEN
  RAISE EXCEPTION 'Formal document classification pending'
   USING ERRCODE='23514';
 END IF;
 IF category='qms' AND
   (lower(tmpl) !~ '^(cdw_)?qms_' OR NOT cdw_qms_policy_release_effective(basis)) THEN
  RAISE EXCEPTION 'QMS document requires an effective QMS approval template'
   USING ERRCODE='23514';
 END IF;
 IF category='general' AND (lower(tmpl) ~ '^(cdw_)?qms_' OR basis IS NOT NULL) THEN
  RAISE EXCEPTION 'General document cannot use QMS authority template'
   USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_formal_classified_submission_guard
 BEFORE INSERT ON cdw_formal_approval_instances
 FOR EACH ROW EXECUTE FUNCTION cdw_formal_classified_submission_guard();
