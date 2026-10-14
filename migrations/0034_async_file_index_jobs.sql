-- File versions enqueue indexing in the same transaction that publishes them.
-- Retained jobs survive an API restart; multiple replicas claim with SKIP LOCKED.
CREATE TABLE file_index_jobs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    file_id text NOT NULL,
    version_seq integer NOT NULL,
    state text NOT NULL DEFAULT 'queued'
        CHECK (state IN ('queued','running','done','failed')),
    attempts integer NOT NULL DEFAULT 0,
    ready_at timestamptz NOT NULL DEFAULT now(),
    lease_owner text,
    lease_until timestamptz,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (file_id, version_seq),
    FOREIGN KEY (file_id, version_seq)
        REFERENCES file_versions(file_id, seq) ON DELETE CASCADE
);

CREATE INDEX ix_file_index_jobs_ready ON file_index_jobs (state, ready_at, id);
CREATE INDEX ix_file_index_jobs_lease ON file_index_jobs (lease_until, id)
    WHERE state = 'running';

CREATE FUNCTION queue_file_version_index() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO file_index_jobs(file_id, version_seq)
    VALUES (NEW.file_id, NEW.seq)
    ON CONFLICT (file_id, version_seq) DO NOTHING;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tr_queue_file_version_index
AFTER INSERT ON file_versions
FOR EACH ROW EXECUTE FUNCTION queue_file_version_index();
