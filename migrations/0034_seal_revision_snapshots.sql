-- Signing state is an immutable, append-only snapshot chain per PDF source version.
-- Original PDF versions and individual password-verified mark evidence stay intact.
CREATE TABLE file_seal_revisions (
 id text PRIMARY KEY,
 file_id text NOT NULL,
 version_seq integer NOT NULL,
 revision_no integer NOT NULL CHECK (revision_no>=1),
 mark_ids text[] NOT NULL DEFAULT '{}'::text[],
 action text NOT NULL CHECK (action IN ('sign','restore','legacy')),
 actor_id text NOT NULL REFERENCES users(id),
 restored_from integer,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(file_id,version_seq) REFERENCES file_versions(file_id,seq),
 UNIQUE(file_id,version_seq,revision_no),
 CHECK(restored_from IS NULL OR restored_from>=0)
);
CREATE INDEX ix_file_seal_revisions_latest ON file_seal_revisions(file_id,version_seq,revision_no DESC);
-- Preserve previously signed documents on upgrade; their old marks remain visible.
INSERT INTO file_seal_revisions(id,file_id,version_seq,revision_no,mark_ids,action,actor_id)
SELECT 'legacy-seals-'||m.file_id||'-'||m.version_seq,m.file_id,m.version_seq,1,
 array_agg(m.id ORDER BY m.created_at,m.id),'legacy',
 (array_agg(m.signer_id ORDER BY m.created_at,m.id))[1]
FROM file_seal_marks m GROUP BY m.file_id,m.version_seq;
-- Allow later re-sign after a rollback, enforcing uniqueness against the ACTIVE
-- snapshot in the transactional application layer and locked revision append.
ALTER TABLE file_seal_marks DROP CONSTRAINT file_seal_marks_file_id_asset_id_key;
ALTER TABLE file_seal_marks DROP CONSTRAINT file_seal_marks_file_id_asset_sha256_key;
CREATE OR REPLACE FUNCTION prevent_seal_revision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'signed document revision history is append-only'; END $$;
CREATE TRIGGER seal_revision_append_only BEFORE UPDATE OR DELETE ON file_seal_revisions
 FOR EACH ROW EXECUTE FUNCTION prevent_seal_revision_mutation();
