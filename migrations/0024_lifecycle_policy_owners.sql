-- Policy defaults apply on future publish/archive only; no historical retroactive changes.
CREATE TABLE folder_lifecycle_policies (
 folder_id text PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE,
 due_days integer NOT NULL DEFAULT 0 CHECK (due_days IN (0,30,90,180,365,730)),
 retention_days integer NOT NULL DEFAULT 0 CHECK (retention_days IN (0,30,90,365,730)),
 updated_by text NOT NULL REFERENCES users(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE department_lifecycle_policies (
 department_id text PRIMARY KEY REFERENCES departments(id) ON DELETE CASCADE,
 due_days integer NOT NULL DEFAULT 0 CHECK (due_days IN (0,30,90,180,365,730)),
 retention_days integer NOT NULL DEFAULT 0 CHECK (retention_days IN (0,30,90,365,730)),
 updated_by text NOT NULL REFERENCES users(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE file_lifecycle ADD COLUMN responsible_id text REFERENCES users(id);
CREATE INDEX ix_lifecycle_responsible ON file_lifecycle(responsible_id) WHERE responsible_id IS NOT NULL;
-- Notifications remain recipient-specific, keyed by due date and phase.
-- Existing notifications are retained for audit; reads hide reassigned recipients.
