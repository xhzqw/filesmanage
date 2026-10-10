-- Immutable approval activity and recipient-scoped, read-tracked in-app notifications.
CREATE TABLE approval_events (
 id bigserial PRIMARY KEY,
 approval_id text NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
 actor_id text NOT NULL REFERENCES users(id),
 kind text NOT NULL CHECK(kind IN ('submitted','advanced','approved','rejected','cancelled','conflicted')),
 step_index integer NOT NULL CHECK(step_index>=0),
 comment text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_approval_events ON approval_events(approval_id,id);
CREATE TABLE approval_notifications (
 id bigserial PRIMARY KEY,
 event_id bigint NOT NULL REFERENCES approval_events(id) ON DELETE CASCADE,
 approval_id text NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
 recipient_id text NOT NULL REFERENCES users(id),
 read_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(event_id,recipient_id)
);
CREATE INDEX ix_approval_notifications_user ON approval_notifications(recipient_id,id DESC);
-- Best-effort legacy state reconstruction. Intermediate decisions before
-- activity tracking were never stored as individual records.
INSERT INTO approval_events(approval_id,actor_id,kind,step_index,created_at)
SELECT id,requester_id,'submitted',0,created_at FROM approvals;
INSERT INTO approval_events(approval_id,actor_id,kind,step_index,comment,created_at)
SELECT id,
 CASE WHEN state='cancelled' THEN requester_id ELSE approver_id END,
 CASE state WHEN 'approved' THEN 'approved' WHEN 'rejected' THEN 'rejected'
 WHEN 'cancelled' THEN 'cancelled' ELSE 'conflicted' END,
 step_index,coalesce(decision_comment,''),coalesce(decided_at,created_at)
FROM approvals WHERE state<>'pending';
