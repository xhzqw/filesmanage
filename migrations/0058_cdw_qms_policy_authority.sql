-- QMS formal approval is only valid with a verifiable, currently effective
-- controlled-release policy basis. Existing non-QMS templates remain unchanged.
-- A released document establishes document provenance, not by itself that the
-- grantor or named signers are substantively authorized under its contents.
ALTER TABLE cdw_workflow_template_versions
 ADD COLUMN authority_basis_release_id text REFERENCES cdw_controlled_releases(id);
ALTER TABLE cdw_business_role_bindings
 ADD COLUMN authority_basis_release_id text REFERENCES cdw_controlled_releases(id);
CREATE INDEX cdw_formal_role_policy_basis
 ON cdw_business_role_bindings(user_id,role,file_id,authority_basis_release_id)
 WHERE revoked_at IS NULL;

-- Shared with the application during publish, start and signing.
-- No QMS policy becomes effective because an administrator typed its ID.
CREATE FUNCTION cdw_qms_policy_release_effective(basis_id text)
 RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(
  SELECT 1 FROM cdw_controlled_releases r
  JOIN cdw_effective_pointers p ON p.file_id=r.file_id
    AND p.release_id=r.id AND p.state='active'
  WHERE r.id=basis_id AND r.state='effective'
 ) $$;

-- Defence in depth for writes that bypass the HTTP application.
CREATE FUNCTION cdw_qms_template_basis_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.lifecycle='published'
    AND lower(NEW.template_key) ~ '^(cdw_)?qms_'
    AND (NEW.authority_basis_release_id IS NULL
         OR NOT cdw_qms_policy_release_effective(NEW.authority_basis_release_id)) THEN
  RAISE EXCEPTION 'QMS template requires an effective policy authority basis'
   USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_qms_template_basis_guard
 BEFORE INSERT OR UPDATE ON cdw_workflow_template_versions
 FOR EACH ROW EXECUTE FUNCTION cdw_qms_template_basis_guard();

-- Published evidence is immutable, including newly added authority basis.
CREATE OR REPLACE FUNCTION cdw_guard_published_template() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND OLD.lifecycle='published' THEN
  RAISE EXCEPTION 'published CDW templates are immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND OLD.lifecycle='published' AND
   (NEW.graph IS DISTINCT FROM OLD.graph OR NEW.role_policy IS DISTINCT FROM OLD.role_policy
    OR NEW.template_key IS DISTINCT FROM OLD.template_key OR NEW.version_no IS DISTINCT FROM OLD.version_no
    OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.published_at IS DISTINCT FROM OLD.published_at
    OR NEW.authority_basis_release_id IS DISTINCT FROM OLD.authority_basis_release_id) THEN
  RAISE EXCEPTION 'published CDW template content is immutable' USING ERRCODE='23514';
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
