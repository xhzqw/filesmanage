-- New PostgreSQL-only schema. All IDs are opaque; original SQLite data excluded.
CREATE TABLE users(
 id text PRIMARY KEY, login text NOT NULL UNIQUE, display_name text NOT NULL,
 password_hash text NOT NULL, is_admin boolean NOT NULL DEFAULT false,
 must_change_password boolean NOT NULL DEFAULT true,
 department_id text, disabled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE departments(
 id text PRIMARY KEY, name text NOT NULL, parent_id text REFERENCES departments(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD CONSTRAINT fk_user_department FOREIGN KEY(department_id) REFERENCES departments(id);
CREATE TABLE workgroups(
 id text PRIMARY KEY, department_id text REFERENCES departments(id),
 name text NOT NULL, UNIQUE(id,department_id)
);
CREATE TABLE workgroup_members(
 group_id text NOT NULL REFERENCES workgroups(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 PRIMARY KEY(group_id,user_id)
);
CREATE TABLE folders(
 id text PRIMARY KEY, parent_id text REFERENCES folders(id) ON DELETE RESTRICT,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
 owner_id text NOT NULL REFERENCES users(id),
 deleted_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(id IS DISTINCT FROM parent_id)
);
CREATE UNIQUE INDEX uq_folder_active_name ON folders(parent_id,name) NULLS NOT DISTINCT WHERE deleted_at IS NULL;
CREATE INDEX ix_folders_parent ON folders(parent_id) WHERE deleted_at IS NULL;
CREATE TABLE acls(
 id text PRIMARY KEY, folder_id text NOT NULL REFERENCES folders(id),
 subject_kind text NOT NULL CHECK(subject_kind IN('user','group')),
 subject_id text NOT NULL,
 actions text[] NOT NULL CHECK(actions <@ ARRAY['list','preview','upload','download','modify','delete','rename','move','print']::text[]),
 scope_only boolean NOT NULL DEFAULT false, expires_at timestamptz,
 granted_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_acls_folder ON acls(folder_id);
CREATE INDEX ix_acls_subject ON acls(subject_kind,subject_id);
CREATE TABLE blobs(
 id text PRIMARY KEY, storage_key text NOT NULL UNIQUE, sha256 char(64) NOT NULL,
 size_bytes bigint NOT NULL CHECK(size_bytes>=0),
 state text NOT NULL CHECK(state IN('staging','ready','gc_pending')),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(storage_key NOT LIKE '%..%' AND left(storage_key,1)<>'/')
);
CREATE TABLE files(
 id text PRIMARY KEY, folder_id text NOT NULL REFERENCES folders(id),
 name text NOT NULL, uploaded_by text NOT NULL REFERENCES users(id),
 current_version_seq integer CHECK(current_version_seq>0),
 deleted_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_file_active_name ON files(folder_id,name) WHERE deleted_at IS NULL;
CREATE INDEX ix_files_page ON files(folder_id,updated_at DESC,id) WHERE deleted_at IS NULL;
CREATE TABLE file_versions(
 id text PRIMARY KEY, file_id text NOT NULL REFERENCES files(id),
 seq integer NOT NULL CHECK(seq>0), blob_id text NOT NULL REFERENCES blobs(id),
 size_bytes bigint NOT NULL CHECK(size_bytes>=0), sha256 char(64) NOT NULL,
 action text NOT NULL CHECK(action IN('upload','edit','rollback','restore')),
 base_seq integer, rollback_target_seq integer, rollback_from_seq integer,
 reason text, created_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(file_id,seq),
 CHECK((action='rollback')=(rollback_target_seq IS NOT NULL AND rollback_from_seq IS NOT NULL))
);
ALTER TABLE files ADD CONSTRAINT fk_current_version
 FOREIGN KEY(id,current_version_seq) REFERENCES file_versions(file_id,seq)
 DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE edit_locks(
 file_id text PRIMARY KEY REFERENCES files(id), owner_id text NOT NULL REFERENCES users(id),
 token_hash char(64) NOT NULL, base_seq integer NOT NULL,
 expires_at timestamptz NOT NULL, generation bigint NOT NULL DEFAULT 1
);
CREATE TABLE approval_policies(
 id text PRIMARY KEY, folder_id text NOT NULL UNIQUE REFERENCES folders(id),
 approver_id text NOT NULL REFERENCES users(id), enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE approvals(
 id text PRIMARY KEY, file_id text NOT NULL REFERENCES files(id),
 requester_id text NOT NULL REFERENCES users(id),
 approver_id text NOT NULL REFERENCES users(id),
 payload_blob_id text NOT NULL REFERENCES blobs(id),
 base_seq integer NOT NULL CHECK(base_seq>0),
 action text NOT NULL CHECK(action IN('edit','rollback')),
 rollback_target_seq integer,
 state text NOT NULL CHECK(state IN('pending','approved','rejected','cancelled','conflicted')),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((action='rollback')=(rollback_target_seq IS NOT NULL))
);
CREATE UNIQUE INDEX uq_pending_approval ON approvals(file_id) WHERE state='pending';
CREATE TABLE shares(
 id text PRIMARY KEY, file_id text REFERENCES files(id),
 folder_id text REFERENCES folders(id),
 recipient_kind text NOT NULL CHECK(recipient_kind IN('user','group')),
 recipient_id text NOT NULL,
 actions text[] NOT NULL CHECK(actions <@ ARRAY['list','preview','download']::text[]),
 include_descendants boolean NOT NULL DEFAULT false,
 expires_at timestamptz, revoked_at timestamptz,
 created_by text NOT NULL REFERENCES users(id),
 CHECK((file_id IS NULL)<>(folder_id IS NULL))
);
CREATE TABLE favorites(
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id),
 file_id text REFERENCES files(id), folder_id text REFERENCES folders(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((file_id IS NULL)<>(folder_id IS NULL))
);
CREATE UNIQUE INDEX uq_fav_file ON favorites(user_id,file_id) WHERE file_id IS NOT NULL;
CREATE UNIQUE INDEX uq_fav_folder ON favorites(user_id,folder_id) WHERE folder_id IS NOT NULL;
CREATE TABLE trash_entries(
 id text PRIMARY KEY, file_id text REFERENCES files(id), folder_id text REFERENCES folders(id),
 old_parent_id text, old_name text NOT NULL,
 deleted_by text NOT NULL REFERENCES users(id),
 deleted_at timestamptz NOT NULL DEFAULT now(), restored_at timestamptz,
 CHECK((file_id IS NULL)<>(folder_id IS NULL))
);
CREATE TABLE file_text(
 file_id text PRIMARY KEY REFERENCES files(id), current_seq integer NOT NULL,
 content text NOT NULL DEFAULT '', spaced text NOT NULL DEFAULT '',
 tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple',spaced)) STORED,
 FOREIGN KEY(file_id,current_seq) REFERENCES file_versions(file_id,seq) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX ix_file_text_tsv ON file_text USING gin(tsv);
CREATE TABLE office_sessions(
 id text PRIMARY KEY, file_id text NOT NULL REFERENCES files(id),
 owner_id text NOT NULL REFERENCES users(id),
 base_seq integer NOT NULL, document_key text NOT NULL UNIQUE,
 state text NOT NULL CHECK(state IN('open','saving','pending','committed','failed','abandoned')),
 expires_at timestamptz NOT NULL
);
CREATE TABLE office_save_events(
 id text PRIMARY KEY, session_id text NOT NULL REFERENCES office_sessions(id),
 generation integer NOT NULL, callback_status integer NOT NULL,
 event_hash char(64) NOT NULL, outcome text NOT NULL,
 UNIQUE(session_id,event_hash)
);
CREATE TABLE model_derivatives(
 id text PRIMARY KEY, file_id text NOT NULL REFERENCES files(id),
 version_seq integer NOT NULL, source_sha256 char(64) NOT NULL,
 output_kind text NOT NULL, blob_id text REFERENCES blobs(id),
 converter text NOT NULL, converter_version text NOT NULL,
 settings_hash char(64) NOT NULL,
 state text NOT NULL CHECK(state IN('queued','running','ready','failed','cancelled')),
 error_code text,
 FOREIGN KEY(file_id,version_seq) REFERENCES file_versions(file_id,seq),
 UNIQUE(file_id,version_seq,output_kind,converter,converter_version,settings_hash)
);
CREATE TABLE conversion_jobs(
 id text PRIMARY KEY, derivative_id text NOT NULL REFERENCES model_derivatives(id),
 state text NOT NULL CHECK(state IN('queued','running','ready','failed','cancelled')),
 attempts integer NOT NULL DEFAULT 0, last_error text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audit_events(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_id text REFERENCES users(id), event_type text NOT NULL,
 target_kind text NOT NULL, target_id text NOT NULL,
 request_id text NOT NULL, outcome text NOT NULL,
 details jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE idempotency_keys(
 actor_id text NOT NULL REFERENCES users(id),
 operation text NOT NULL, request_key text NOT NULL,
 response jsonb, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(actor_id,operation,request_key)
);
CREATE TABLE outbox_jobs(
 id text PRIMARY KEY, kind text NOT NULL, payload jsonb NOT NULL,
 state text NOT NULL CHECK(state IN('queued','running','done','failed')) DEFAULT 'queued',
 attempts integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_outbox_queue ON outbox_jobs(state,created_at);
CREATE TABLE sessions(
 sid_hash char(64) PRIMARY KEY, user_id text NOT NULL REFERENCES users(id),
 expires_at timestamptz NOT NULL, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_session_user ON sessions(user_id,expires_at);
