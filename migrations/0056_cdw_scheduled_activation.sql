-- Explicitly opted-in automatic effectivity, distinct from the planned date.
-- Lease generation fences stale workers and allows crash recovery. All
-- activation facts and pointers remain owned by the existing G8 transaction.
CREATE TABLE cdw_activation_schedules (
 release_id text PRIMARY KEY REFERENCES cdw_controlled_releases(id),
 sponsor_id text NOT NULL REFERENCES users(id),
 status text NOT NULL CHECK(status IN ('enabled','paused','completed','cancelled')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>=1),
 next_attempt_at timestamptz NOT NULL,
 lease_token text,
 lease_until timestamptz,
 attempts bigint NOT NULL DEFAULT 0 CHECK(attempts>=0),
 last_blockers jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(last_blockers)='array'),
 last_error text,
 enabled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((lease_token IS NULL)=(lease_until IS NULL))
);
CREATE INDEX cdw_activation_schedule_due ON cdw_activation_schedules(next_attempt_at,release_id)
 WHERE status='enabled';
