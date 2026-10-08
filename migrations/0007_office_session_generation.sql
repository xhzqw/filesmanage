-- ONLYOFFICE editing session state (SPEC §19.6): lock generation per editing
-- session and a per-file compatibility report table.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='office_sessions' AND column_name='lock_generation') THEN
    ALTER TABLE office_sessions ADD COLUMN lock_generation bigint NOT NULL DEFAULT 1;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='office_sessions' AND column_name='document_key') THEN
    -- document_key already exists as NOT NULL UNIQUE in 0001; guard kept for clarity.
    ALTER TABLE office_sessions ADD COLUMN document_key text;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS office_compatibility_reports(
 file_id text NOT NULL REFERENCES files(id),
 version_seq integer NOT NULL,
 engine_version text NOT NULL,
 supported_features jsonb NOT NULL DEFAULT '[]'::jsonb,
 warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
 verification_status text NOT NULL CHECK(verification_status IN('verified','degraded','unverified')),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(file_id,version_seq),
 FOREIGN KEY(file_id,version_seq) REFERENCES file_versions(file_id,seq)
);
