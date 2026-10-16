-- An independently derived projection of the exact, immutable distributed
-- artifact. Ordinary file_text is NEVER authoritative for a CDW pointer.
-- Old rows are retained for forensic recovery; serving requires a live
-- active effective pointer, state, exact hash and live access authorization.
CREATE TABLE cdw_effective_search_index (
 release_id text PRIMARY KEY REFERENCES cdw_controlled_releases(id),
 artifact_id text NOT NULL,
 blob_id text NOT NULL REFERENCES blobs(id),
 sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
 state text NOT NULL CHECK(state IN ('pending','ready','retry')),
 content text NOT NULL DEFAULT '',
 spaced text NOT NULL DEFAULT '',
 tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple',spaced)) STORED,
 lease_token text,
 lease_until timestamptz,
 attempts int NOT NULL DEFAULT 0 CHECK(attempts>=0),
 retry_after timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(release_id,artifact_id,sha256)
   REFERENCES cdw_release_artifacts(release_id,id,sha256),
 CHECK((lease_token IS NULL)=(lease_until IS NULL))
);
CREATE INDEX cdw_effective_search_gin ON cdw_effective_search_index USING GIN(tsv)
 WHERE state='ready';
CREATE INDEX cdw_effective_search_claim ON cdw_effective_search_index(retry_after,release_id)
 WHERE state IN ('pending','retry');
