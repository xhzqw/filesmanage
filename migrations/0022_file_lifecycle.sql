-- Lifecycle metadata is independent of append-only file_versions; no bytes are copied.
CREATE TABLE file_lifecycle(
 file_id text PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
 state text NOT NULL CHECK(state IN('released','archived')),
 published_seq integer NOT NULL CHECK(published_seq>0),
 published_at timestamptz NOT NULL,
 published_by text NOT NULL REFERENCES users(id),
 due_at timestamptz,
 note text NOT NULL DEFAULT '' CHECK(length(note)<=200),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(file_id,published_seq) REFERENCES file_versions(file_id,seq)
);
CREATE INDEX ix_file_lifecycle_due ON file_lifecycle(due_at,file_id) WHERE due_at IS NOT NULL;
