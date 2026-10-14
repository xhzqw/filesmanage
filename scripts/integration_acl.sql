-- Test strong ACL reference and cycle invariants with rollback-only fixtures.
BEGIN;
INSERT INTO users(id,login,display_name,password_hash)
 VALUES('acl_user','acl_user','ACL Fixture','unusable');
INSERT INTO workgroups(id,name) VALUES('acl_group','test group');
INSERT INTO folders(id,name,owner_id,parent_id) VALUES
 ('acl_root','test root','acl_user',NULL);
INSERT INTO folders(id,name,owner_id,parent_id)
 VALUES('acl_child','child','acl_user','acl_root');
INSERT INTO folders(id,name,owner_id,parent_id)
 VALUES('acl_grandchild','grandchild','acl_user','acl_child');

DO $guard$
DECLARE blocked boolean := false;
BEGIN
  BEGIN
    UPDATE folders SET parent_id='acl_grandchild' WHERE id='acl_root';
  EXCEPTION WHEN check_violation THEN blocked:=true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'folder cycle was allowed'; END IF;
END $guard$;

DO $guard$
DECLARE blocked boolean := false;
BEGIN
  BEGIN
    INSERT INTO acls(id,folder_id,subject_kind,subject_id,actions,granted_by)
     VALUES('acl_invalid','acl_root','group','missing_group',ARRAY['list'],'acl_user');
  EXCEPTION WHEN foreign_key_violation THEN blocked:=true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'dangling ACL principal was allowed'; END IF;
END $guard$;

DO $guard$
DECLARE blocked boolean := false;
BEGIN
  BEGIN
    INSERT INTO shares(id,folder_id,recipient_kind,recipient_id,actions,created_by)
     VALUES('share_invalid','acl_root','user','missing_user',ARRAY['preview'],'acl_user');
  EXCEPTION WHEN foreign_key_violation THEN blocked:=true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'dangling share recipient was allowed'; END IF;
END $guard$;

INSERT INTO acls(id,folder_id,subject_kind,subject_id,actions,granted_by)
 VALUES('acl_valid','acl_root','group','acl_group',ARRAY['list','preview'],'acl_user');
DO $guard$
DECLARE blocked boolean := false;
BEGIN
  BEGIN
    DELETE FROM workgroups WHERE id='acl_group';
  EXCEPTION WHEN foreign_key_violation THEN blocked:=true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'principal deletion broke ACL integrity'; END IF;
END $guard$;

DO $guard$
DECLARE blocked boolean := false;
BEGIN
  BEGIN
    INSERT INTO acls(id,folder_id,subject_kind,subject_id,actions,granted_by)
     VALUES('acl_empty','acl_root','group','acl_group',ARRAY[]::text[],'acl_user');
  EXCEPTION WHEN check_violation THEN blocked:=true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'empty ACL was accepted'; END IF;
END $guard$;
SELECT 'PASS: ACL/share referential integrity, nonempty rights, cycle checks' AS result;
ROLLBACK;
