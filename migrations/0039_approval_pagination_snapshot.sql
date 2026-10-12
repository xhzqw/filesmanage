-- Keep the submission-time name, independent of later renames/deletion.
-- Names of approvals predating this migration can only be backfilled with
-- the name known at migration time.
ALTER TABLE approvals ADD COLUMN file_name_snapshot text NOT NULL DEFAULT '';
UPDATE approvals a SET file_name_snapshot = f.name
FROM files f WHERE a.file_id=f.id AND a.file_name_snapshot='';
CREATE INDEX ix_approvals_requester_page ON approvals(requester_id,created_at DESC,id DESC);
CREATE INDEX ix_approvals_inbox_page ON approvals(approver_id,created_at DESC,id DESC) WHERE state='pending';
CREATE INDEX ix_approvals_admin_page ON approvals(created_at DESC,id DESC) WHERE state='pending';
CREATE INDEX ix_approval_unread ON approval_notifications(recipient_id,id DESC) WHERE read_at IS NULL;
