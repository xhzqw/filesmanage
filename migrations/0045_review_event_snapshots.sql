-- Durable transition snapshots; preserve evidence ownership on reassignment.
ALTER TABLE file_review_events
 ADD COLUMN status_before text NOT NULL DEFAULT 'open',
 ADD COLUMN status_after text NOT NULL DEFAULT 'open',
 ADD COLUMN assignee_id text REFERENCES users(id),
 ADD COLUMN resolved_by text REFERENCES users(id),
 ADD COLUMN resolution_note text NOT NULL DEFAULT '',
 ADD COLUMN resolved_version_seq integer,
 ADD COLUMN approval_note text NOT NULL DEFAULT '';
