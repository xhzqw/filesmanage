-- Persistent anonymous invalidation journal. Journal writes share their
-- business transaction; a rollback produces NO visible event. The lock makes
-- generated IDs follow commit order across concurrent writers, eliminating
-- cursor holes caused by sequences allocated in uncommitted transactions.
CREATE TABLE realtime_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id text, -- NULL = public anonymous invalidation; never contains resources
 event_type text NOT NULL CHECK (event_type IN ('workspace.changed','session.changed','approval.changed')),
 scopes text[] NOT NULL DEFAULT '{}'::text[],
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ix_realtime_events_age ON realtime_events(created_at,id);

CREATE FUNCTION realtime_append(p_user text, p_type text, p_scopes text[])
RETURNS void LANGUAGE plpgsql AS $$
DECLARE inserted_id bigint;
BEGIN
 -- This is deliberately transaction-scoped. Never substitute nextval without
 -- serialization: transactions can commit in the opposite ID order.
 PERFORM pg_advisory_xact_lock(21007722);
 INSERT INTO realtime_events(user_id,event_type,scopes)
 VALUES(p_user,p_type,p_scopes) RETURNING id INTO inserted_id;
 PERFORM pg_notify('filesmanage_realtime',inserted_id::text);
END;
$$;

CREATE FUNCTION realtime_table_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM realtime_append(NULL,'workspace.changed',string_to_array(TG_ARGV[0],','));
 RETURN NULL;
END;
$$;

-- Statement triggers make a 100-file batch one event per touched table, not
-- 100 event rows. Table coverage (not best-effort audit calls) guarantees that
-- even direct SQL writes and future application code changes are journaled.
DO $$
DECLARE rec record;
BEGIN
 FOR rec IN
 SELECT * FROM (VALUES
 ('files','file,search,stats'),('file_versions','file,search,stats'),
 ('file_text','file,search'),('file_metadata','file,search'),
 ('folders','folder,file,search,stats'),('trash_entries','trash,file,stats'),
 ('acls','permissions,file,folder,stats'),('shares','permissions,collaboration,file'),
 ('management_role_bindings','permissions,organization'),
 ('workgroup_members','permissions,organization,collaboration'),
 ('workgroups','organization,permissions'),('departments','organization,permissions'),
 ('users','organization'),('favorites','collaboration'),
 ('approvals','review,file'),('approval_policies','approval-policy'),
 ('approval_events','review'),('file_review_comments','review'),
 ('edit_locks','approval-policy'),('file_lifecycle','lifecycle,file,stats'),
 ('folder_lifecycle_policies','lifecycle'),('department_lifecycle_policies','lifecycle'),
 ('model_derivatives','file'),('office_save_events','file'),
 ('lifecycle_notifications','lifecycle'),('approval_notifications','review')
 ) AS t(table_name,scope_csv)
 LOOP
  -- Favorites, notifications and search presets are *private*. They get
  -- recipient-specific row triggers below; never broadcast their changes.
  IF rec.table_name NOT IN ('favorites','lifecycle_notifications','approval_notifications') THEN
   EXECUTE format(
    'CREATE TRIGGER realtime_%I_changed AFTER INSERT OR UPDATE OR DELETE ON %I
     FOR EACH STATEMENT EXECUTE FUNCTION realtime_table_changed(%L)',
    rec.table_name,rec.table_name,rec.scope_csv
   );
  END IF;
 END LOOP;
END $$;

CREATE FUNCTION realtime_private_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner text;
BEGIN
 owner := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD)->>TG_ARGV[0]
               ELSE to_jsonb(NEW)->>TG_ARGV[0] END;
 IF owner IS NOT NULL THEN
  PERFORM realtime_append(owner,TG_ARGV[1],
   CASE WHEN TG_ARGV[2]='' THEN '{}'::text[] ELSE string_to_array(TG_ARGV[2],',') END);
 END IF;
 RETURN NULL;
END;
$$;
CREATE TRIGGER realtime_favorites AFTER INSERT OR UPDATE OR DELETE ON favorites
 FOR EACH ROW EXECUTE FUNCTION realtime_private_changed('user_id','workspace.changed','collaboration');
CREATE TRIGGER realtime_presets AFTER INSERT OR UPDATE OR DELETE ON search_presets
 FOR EACH ROW EXECUTE FUNCTION realtime_private_changed('user_id','workspace.changed','presets');
CREATE TRIGGER realtime_approval_notifications AFTER INSERT OR UPDATE OR DELETE ON approval_notifications
 FOR EACH ROW EXECUTE FUNCTION realtime_private_changed('recipient_id','approval.changed','');
CREATE TRIGGER realtime_lifecycle_notifications AFTER INSERT OR UPDATE OR DELETE ON lifecycle_notifications
 FOR EACH ROW EXECUTE FUNCTION realtime_private_changed('recipient_id','workspace.changed','lifecycle');

-- Credentials and revocation events are always private to the affected user.
CREATE TRIGGER realtime_sessions_insert AFTER INSERT ON sessions
 FOR EACH ROW EXECUTE FUNCTION realtime_private_changed('user_id','session.changed','');
CREATE TRIGGER realtime_sessions_revoke AFTER UPDATE OF revoked_at,expires_at ON sessions
 FOR EACH ROW EXECUTE FUNCTION realtime_private_changed('user_id','session.changed','');
CREATE TRIGGER realtime_sessions_delete AFTER DELETE ON sessions
 FOR EACH ROW EXECUTE FUNCTION realtime_private_changed('user_id','session.changed','');
CREATE TRIGGER realtime_users_credentials AFTER UPDATE OF password_hash,disabled_at,must_change_password ON users
 FOR EACH ROW EXECUTE FUNCTION realtime_private_changed('id','session.changed','');
