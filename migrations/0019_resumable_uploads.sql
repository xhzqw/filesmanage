-- Durable resumable upload sessions; raw bytes live under the private blob root.
CREATE TABLE resumable_uploads(
 id text PRIMARY KEY,
 owner_id text NOT NULL REFERENCES users(id),
 folder_id text NOT NULL REFERENCES folders(id),
 file_name text NOT NULL,
 content_type text NOT NULL DEFAULT '',
 expected_size bigint NOT NULL CHECK(expected_size BETWEEN 1 AND 1073741824),
 expected_sha256 text NOT NULL DEFAULT '' CHECK(length(expected_sha256)=0 OR length(expected_sha256)=64),
 operation_key text NOT NULL,
 received_bytes bigint NOT NULL DEFAULT 0 CHECK(received_bytes>=0),
 state text NOT NULL DEFAULT 'open' CHECK(state IN('open','committed','cancelled')),
 result_json jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT (now()+interval '24 hours'),
 UNIQUE(owner_id,operation_key),
 CHECK(received_bytes<=expected_size)
);
CREATE INDEX ix_resumable_expiry ON resumable_uploads(expires_at) WHERE state='open';
