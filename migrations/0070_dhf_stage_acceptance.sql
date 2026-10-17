-- DHF 1-9 stage gates, using only the newly provided XMind outline.
-- Stages are not the D1/D9 or T1/T8 governance taxonomy.
CREATE TABLE dhf_projects (
 id text PRIMARY KEY, title text NOT NULL CHECK(length(btrim(title)) BETWEEN 2 AND 200),
 template_sha256 text NOT NULL CHECK(template_sha256 ~ '^[0-9a-f]{64}$'),
 owner_id text NOT NULL REFERENCES users(id), reviewer_id text NOT NULL REFERENCES users(id),
 revision bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(owner_id<>reviewer_id)
);
CREATE TABLE dhf_stages (
 project_id text NOT NULL REFERENCES dhf_projects(id), stage_no int NOT NULL CHECK(stage_no BETWEEN 1 AND 9),
 name text NOT NULL, state text NOT NULL CHECK(state IN ('locked','open','accepted')),
 revision bigint NOT NULL DEFAULT 1, accepted_by text REFERENCES users(id), accepted_at timestamptz,
 baseline_sha256 text CHECK(baseline_sha256 ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY(project_id,stage_no),
 CHECK((state='accepted')=(accepted_by IS NOT NULL AND accepted_at IS NOT NULL AND baseline_sha256 IS NOT NULL))
);
CREATE TABLE dhf_items (
 project_id text NOT NULL REFERENCES dhf_projects(id), source_line int NOT NULL,
 stage_no int NOT NULL CHECK(stage_no BETWEEN 1 AND 9), parent_path jsonb NOT NULL DEFAULT '[]'::jsonb,
 title text NOT NULL, state text NOT NULL DEFAULT 'unclassified'
 CHECK(state IN ('unclassified','missing','submitted','accepted','returned','not_applicable')),
 applicability_reason text NOT NULL DEFAULT '', file_id text REFERENCES files(id),
 file_version_id text, file_sha256 text CHECK(file_sha256 ~ '^[0-9a-f]{64}$'),
 submitted_by text REFERENCES users(id), submitted_at timestamptz,
 reviewed_by text REFERENCES users(id), reviewed_at timestamptz, review_reason text NOT NULL DEFAULT '',
 revision bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(project_id,source_line), FOREIGN KEY(project_id,stage_no) REFERENCES dhf_stages(project_id,stage_no),
 FOREIGN KEY(file_id,file_version_id) REFERENCES file_versions(file_id,id),
 CHECK((file_id IS NULL)=(file_version_id IS NULL)),
 CHECK((file_id IS NULL)=(file_sha256 IS NULL)),
 CHECK((state IN('submitted','accepted','returned'))=(file_id IS NOT NULL AND submitted_by IS NOT NULL AND submitted_at IS NOT NULL)),
 CHECK(state<>'not_applicable' OR length(btrim(applicability_reason))>=8),
 CHECK(state<>'accepted' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND reviewed_by<>submitted_by))
);
CREATE INDEX dhf_items_by_stage ON dhf_items(project_id,stage_no,source_line);
CREATE TABLE dhf_events (
 id bigserial PRIMARY KEY, project_id text NOT NULL REFERENCES dhf_projects(id),
 stage_no int CHECK(stage_no BETWEEN 1 AND 9), source_line int,
 action text NOT NULL, actor_id text NOT NULL REFERENCES users(id),
 payload_text text NOT NULL CHECK(left(ltrim(payload_text),1)='{'),
 previous_sha256 text NOT NULL CHECK(previous_sha256 ~ '^[0-9a-f]{64}$'),
 event_sha256 text NOT NULL UNIQUE CHECK(event_sha256 ~ '^[0-9a-f]{64}$'),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX dhf_events_project_id ON dhf_events(project_id,id);
CREATE FUNCTION dhf_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'DHF events are append only'; END $$;
CREATE TRIGGER dhf_events_guard BEFORE UPDATE OR DELETE ON dhf_events
 FOR EACH ROW EXECUTE FUNCTION dhf_events_immutable();
CREATE TABLE dhf_operations (
 actor_id text NOT NULL REFERENCES users(id), request_key text NOT NULL,
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
 response_json jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(actor_id,request_key)
);
