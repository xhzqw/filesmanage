-- The original AFTER ... FOR EACH STATEMENT triggers also fired on UPDATEs
-- that affected ZERO rows. The CAD worker polls an empty conversion queue every
-- three seconds; its CTE performs UPDATE model_derivatives even when no job is
-- claimed. That used to emit a false "file" event every three seconds, making
-- the explorer and previews visibly reload forever.
--
-- Transition relations retain one journal event per *actual non-empty*
-- statement, rather than generating one row per updated resource.
CREATE FUNCTION realtime_table_touched() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE has_rows boolean;
BEGIN
 IF TG_OP='DELETE' THEN
  SELECT EXISTS(SELECT 1 FROM realtime_old_rows) INTO has_rows;
 ELSE
  SELECT EXISTS(SELECT 1 FROM realtime_new_rows) INTO has_rows;
 END IF;
 IF has_rows THEN
  PERFORM realtime_append(NULL,'workspace.changed',string_to_array(TG_ARGV[0],','));
 END IF;
 RETURN NULL;
END;
$$;

DO $$
DECLARE t record;
DECLARE trigger_name text;
BEGIN
 FOR t IN SELECT * FROM (VALUES
 ('files','file,search,stats'),('file_versions','file,search,stats'),
 ('file_text','file,search'),('file_metadata','file,search'),
 ('folders','folder,file,search,stats'),('trash_entries','trash,file,stats'),
 ('acls','permissions,file,folder,stats'),('shares','permissions,collaboration,file'),
 ('management_role_bindings','permissions,organization'),
 ('workgroup_members','permissions,organization,collaboration'),
 ('workgroups','organization,permissions'),('departments','organization,permissions'),
 ('users','organization'),
 ('approvals','review,file'),('approval_policies','approval-policy'),
 ('approval_events','review'),('file_review_comments','review'),
 ('edit_locks','approval-policy'),('file_lifecycle','lifecycle,file,stats'),
 ('folder_lifecycle_policies','lifecycle'),('department_lifecycle_policies','lifecycle'),
 ('model_derivatives','file'),('office_save_events','file')
 ) AS tables(table_name,scope_csv) LOOP
  trigger_name := 'realtime_'||t.table_name||'_changed';
  EXECUTE format('DROP TRIGGER %I ON %I',trigger_name,t.table_name);
  EXECUTE format(
   'CREATE TRIGGER %I AFTER INSERT ON %I
    REFERENCING NEW TABLE AS realtime_new_rows FOR EACH STATEMENT
    EXECUTE FUNCTION realtime_table_touched(%L)',
    'realtime_'||t.table_name||'_insert',t.table_name,t.scope_csv
  );
  EXECUTE format(
   'CREATE TRIGGER %I AFTER UPDATE ON %I
    REFERENCING NEW TABLE AS realtime_new_rows FOR EACH STATEMENT
    EXECUTE FUNCTION realtime_table_touched(%L)',
    'realtime_'||t.table_name||'_update',t.table_name,t.scope_csv
  );
  EXECUTE format(
   'CREATE TRIGGER %I AFTER DELETE ON %I
    REFERENCING OLD TABLE AS realtime_old_rows FOR EACH STATEMENT
    EXECUTE FUNCTION realtime_table_touched(%L)',
    'realtime_'||t.table_name||'_delete',t.table_name,t.scope_csv
  );
 END LOOP;
END;
$$;
