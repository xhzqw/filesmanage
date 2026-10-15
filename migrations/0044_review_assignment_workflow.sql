-- Preserve legacy comments while adding transactional review assignment and acceptance.
ALTER TABLE file_review_comments
 ADD COLUMN status text NOT NULL DEFAULT 'open',
 ADD COLUMN assignee_id text REFERENCES users(id),
 ADD COLUMN page_number integer CHECK(page_number BETWEEN 1 AND 100000),
 ADD COLUMN resolution_note text NOT NULL DEFAULT '',
 ADD COLUMN resolved_version_seq integer CHECK(resolved_version_seq > 0),
 ADD COLUMN approval_note text NOT NULL DEFAULT '',
 ADD COLUMN approved_at timestamptz,
 ADD COLUMN revision integer NOT NULL DEFAULT 0;
ALTER TABLE file_review_comments
 ADD CONSTRAINT ck_review_status CHECK(status IN ('open','assigned','pending_approval','approved','completed_self','rejected'));
UPDATE file_review_comments SET status='completed_self' WHERE resolved_at IS NOT NULL;
CREATE INDEX ix_review_assignee_status ON file_review_comments(assignee_id,status,id DESC) WHERE assignee_id IS NOT NULL;
CREATE TABLE file_review_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 review_id bigint NOT NULL REFERENCES file_review_comments(id) ON DELETE CASCADE,
 actor_id text NOT NULL REFERENCES users(id),
 kind text NOT NULL,
 note text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_review_events_review ON file_review_events(review_id,id);
CREATE TABLE file_review_notifications (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 event_id bigint NOT NULL REFERENCES file_review_events(id) ON DELETE CASCADE,
 recipient_id text NOT NULL REFERENCES users(id),
 read_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(event_id,recipient_id)
);
CREATE INDEX ix_file_review_notifications_user ON file_review_notifications(recipient_id,id DESC);
