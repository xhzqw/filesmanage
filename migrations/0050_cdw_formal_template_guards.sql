-- G7: Published formal-approval templates are immutable evidence.
-- Retirement may update lifecycle only; graph/role policy/version/author never change.
CREATE FUNCTION cdw_guard_published_template() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND OLD.lifecycle='published' THEN
  RAISE EXCEPTION 'published CDW templates are immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND OLD.lifecycle='published' AND
   (NEW.graph IS DISTINCT FROM OLD.graph OR NEW.role_policy IS DISTINCT FROM OLD.role_policy
    OR NEW.template_key IS DISTINCT FROM OLD.template_key OR NEW.version_no IS DISTINCT FROM OLD.version_no
    OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.published_at IS DISTINCT FROM OLD.published_at) THEN
  RAISE EXCEPTION 'published CDW template content is immutable' USING ERRCODE='23514';
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER cdw_template_published_guard
 BEFORE UPDATE OR DELETE ON cdw_workflow_template_versions
 FOR EACH ROW EXECUTE FUNCTION cdw_guard_published_template();
