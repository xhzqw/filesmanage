-- Immutable signature/seal registry and document-version anchored marks.
CREATE TABLE seal_assets (
 id text PRIMARY KEY,
 kind text NOT NULL CHECK(kind IN ('personal','company')),
 UNIQUE(id,kind),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 owner_id text REFERENCES users(id),
 created_by text NOT NULL REFERENCES users(id),
 png_bytes bytea NOT NULL CHECK(octet_length(png_bytes) BETWEEN 30 AND 1048576),
 sha256 char(64) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 retired_at timestamptz,
 CHECK(kind='personal' OR owner_id IS NULL)
);
CREATE INDEX ix_seals_owner ON seal_assets(owner_id,kind) WHERE retired_at IS NULL;
CREATE TABLE seal_grants (
 asset_id text NOT NULL REFERENCES seal_assets(id),
 user_id text NOT NULL REFERENCES users(id),
 granted_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(asset_id,user_id)
);
-- Separate opt-in authority; file ACLs and signature ownership cannot grant signing.
CREATE TABLE seal_user_permissions (
 user_id text PRIMARY KEY REFERENCES users(id),
 can_sign boolean NOT NULL DEFAULT false,
 can_stamp boolean NOT NULL DEFAULT false,
 updated_by text NOT NULL REFERENCES users(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO seal_user_permissions(user_id,can_sign,can_stamp,updated_by)
 SELECT id,true,true,id FROM users WHERE login='admin' AND is_admin;
CREATE TABLE file_seal_marks (
 id text PRIMARY KEY,
 file_id text NOT NULL REFERENCES files(id),
 version_seq integer NOT NULL,
 file_sha256 char(64) NOT NULL,
 asset_id text NOT NULL REFERENCES seal_assets(id),
 asset_kind text NOT NULL CHECK(asset_kind IN ('personal','company')),
 asset_sha256 char(64) NOT NULL,
 signer_id text NOT NULL REFERENCES users(id),
 page_number integer NOT NULL CHECK(page_number BETWEEN 1 AND 10000),
 x numeric(8,6) NOT NULL CHECK(x>=0 AND x<=1),
 y numeric(8,6) NOT NULL CHECK(y>=0 AND y<=1),
 width numeric(8,6) NOT NULL CHECK(width>0 AND width<=1),
 height numeric(8,6) NOT NULL CHECK(height>0 AND height<=1),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(file_id,version_seq) REFERENCES file_versions(file_id,seq),
 FOREIGN KEY(asset_id,asset_kind) REFERENCES seal_assets(id,kind),
 UNIQUE(file_id,asset_id), -- one exact seal asset per file across all versions
 UNIQUE(file_id,asset_sha256), -- same image under a second asset id is still the same seal
 CHECK(x+width<=1 AND y+height<=1)
);
CREATE INDEX ix_file_seal_marks_file ON file_seal_marks(file_id,version_seq,created_at);
CREATE OR REPLACE FUNCTION prevent_seal_mark_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'signed document evidence is append-only'; END $$;
CREATE TRIGGER seal_marks_append_only BEFORE UPDATE OR DELETE ON file_seal_marks
 FOR EACH ROW EXECUTE FUNCTION prevent_seal_mark_mutation();
