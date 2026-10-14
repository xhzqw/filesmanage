-- File-local descending keyset pagination; avoids scanning unrelated audit
-- records as the system grows. Historical trash entry IDs remain stable.
CREATE INDEX IF NOT EXISTS ix_audit_file_history
 ON audit_events(target_id, id DESC) WHERE target_kind='file';
CREATE INDEX IF NOT EXISTS ix_audit_trash_history
 ON audit_events(target_id, id DESC) WHERE target_kind='trash';
CREATE INDEX IF NOT EXISTS ix_trash_history_file
 ON trash_entries(file_id, id) WHERE file_id IS NOT NULL;
