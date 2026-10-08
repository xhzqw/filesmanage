-- Prevent folder cycles, dangling polymorphic ACL/share principals and empty rights.
-- Applies only within dedicated v2.1 PostgreSQL database.
ALTER TABLE acls ADD CONSTRAINT ck_acl_nonempty_actions CHECK(cardinality(actions)>0);
ALTER TABLE shares ADD CONSTRAINT ck_share_nonempty_actions CHECK(cardinality(actions)>0);

CREATE OR REPLACE FUNCTION guard_folder_parent()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  loop_found boolean := false;
  max_depth integer := 0;
BEGIN
  IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;
  -- Serialize uncommon folder-parent changes; prohibit concurrent cycle creation.
  PERFORM pg_advisory_xact_lock(21007724);
  IF NEW.id=NEW.parent_id THEN
    RAISE EXCEPTION 'folder cannot be its own parent' USING ERRCODE='23514';
  END IF;
  WITH RECURSIVE parents(id,parent_id,depth) AS (
    SELECT id,parent_id,1 FROM folders WHERE id=NEW.parent_id
    UNION ALL
    SELECT f.id,f.parent_id,p.depth+1
      FROM parents p JOIN folders f ON f.id=p.parent_id WHERE p.depth<65
  )
  SELECT coalesce(bool_or(id=NEW.id),false),coalesce(max(depth),0)
    INTO loop_found,max_depth FROM parents;
  IF loop_found OR max_depth>=65 THEN
    RAISE EXCEPTION 'folder parent cycle or excessive depth' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER trg_folder_parent_guard
  BEFORE INSERT OR UPDATE OF parent_id ON folders
  FOR EACH ROW EXECUTE FUNCTION guard_folder_parent();

CREATE OR REPLACE FUNCTION validate_principal_reference()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  kind text;
  principal text;
  exists_row boolean := false;
BEGIN
  IF TG_TABLE_NAME='acls' THEN
    kind:=NEW.subject_kind; principal:=NEW.subject_id;
  ELSIF TG_TABLE_NAME='shares' THEN
    kind:=NEW.recipient_kind; principal:=NEW.recipient_id;
  ELSE
    RAISE EXCEPTION 'unexpected principal table';
  END IF;
  IF kind='user' THEN
    SELECT EXISTS(SELECT 1 FROM users WHERE id=principal)
      INTO exists_row;
  ELSIF kind='group' THEN
    SELECT EXISTS(SELECT 1 FROM workgroups WHERE id=principal)
      INTO exists_row;
  END IF;
  IF NOT exists_row THEN
    RAISE EXCEPTION 'principal does not exist'
      USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER trg_acl_subject
  BEFORE INSERT OR UPDATE OF subject_kind,subject_id ON acls
  FOR EACH ROW EXECUTE FUNCTION validate_principal_reference();
CREATE TRIGGER trg_share_subject
  BEFORE INSERT OR UPDATE OF recipient_kind,recipient_id ON shares
  FOR EACH ROW EXECUTE FUNCTION validate_principal_reference();

-- Prevent hard-deleting a referenced group/user and creating dangling rows.
CREATE OR REPLACE FUNCTION guard_principal_delete()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  kind text;
BEGIN
  IF TG_TABLE_NAME='users' THEN kind:='user';
  ELSIF TG_TABLE_NAME='workgroups' THEN kind:='group';
  ELSE RETURN OLD; END IF;
  IF EXISTS(SELECT 1 FROM acls WHERE subject_kind=kind AND subject_id=OLD.id)
     OR EXISTS(SELECT 1 FROM shares WHERE recipient_kind=kind AND recipient_id=OLD.id)
  THEN
    RAISE EXCEPTION 'cannot delete a principal referenced by a grant/share'
      USING ERRCODE='23503';
  END IF;
  RETURN OLD;
END $fn$;
CREATE TRIGGER trg_user_principal_delete
  BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION guard_principal_delete();
CREATE TRIGGER trg_group_principal_delete
  BEFORE DELETE ON workgroups FOR EACH ROW EXECUTE FUNCTION guard_principal_delete();
