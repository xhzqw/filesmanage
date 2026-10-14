-- Record which files were affected at the time of a folder operation.
-- Historical membership must not be inferred from current folder paths.
CREATE TABLE file_audit_links (
 event_id bigint NOT NULL REFERENCES audit_events(id) ON DELETE RESTRICT,
 file_id text NOT NULL,
 PRIMARY KEY(event_id, file_id)
);
CREATE INDEX ix_file_audit_links_file ON file_audit_links(file_id, event_id DESC);

CREATE OR REPLACE FUNCTION attach_folder_audit_links() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE root_folder text;
BEGIN
  IF NEW.event_type NOT IN ('folder.rename','folder.move','folder.delete',
                            'trash.restore','trash.purge') THEN
    RETURN NEW;
  END IF;
  IF NEW.target_kind = 'folder' THEN
    root_folder := NEW.target_id;
  ELSIF NEW.target_kind = 'trash' THEN
    SELECT t.folder_id INTO root_folder FROM trash_entries t WHERE t.id=NEW.target_id;
  END IF;
  IF root_folder IS NULL THEN
    RETURN NEW;
  END IF;
  WITH RECURSIVE subtree(id) AS (
    SELECT id FROM folders WHERE id=root_folder
    UNION ALL
    SELECT child.id FROM folders child JOIN subtree parent ON child.parent_id=parent.id
  )
  INSERT INTO file_audit_links(event_id,file_id)
  SELECT DISTINCT NEW.id,f.id
  FROM files f JOIN subtree ON subtree.id=f.folder_id;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_folder_audit_links
 AFTER INSERT ON audit_events
 FOR EACH ROW EXECUTE FUNCTION attach_folder_audit_links();

-- The application only appends committed audit facts. Corrections must be
-- represented by additional events, never an UPDATE of historical evidence.
CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'audit events are append-only'
 USING ERRCODE='23514';
END $$;
CREATE TRIGGER trg_audit_immutable
 BEFORE UPDATE OR DELETE ON audit_events
 FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
