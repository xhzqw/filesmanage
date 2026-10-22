-- Project database (workbench view "项目"): one row per project plus its
-- comments, todos and linked controlled documents. Enum values stay in their
-- stable English/Chinese forms; labels live only in the frontend.
CREATE TABLE projects(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
 icon text NOT NULL DEFAULT '◇' CHECK(icon IN ('◇','◈','▦','✦','◎')),
 description text NOT NULL DEFAULT '' CHECK(length(description)<=4000),
 status text NOT NULL DEFAULT 'notstarted' CHECK(status IN ('notstarted','progress','done')),
 priority text NOT NULL DEFAULT 'mid' CHECK(priority IN ('high','mid','low')),
 team text NOT NULL DEFAULT '' CHECK(team IN ('','销售部','产品设计','人力资源','供应链','工程部','文件管理')),
 owner_id text REFERENCES users(id),
 progress smallint NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
 start_date date, end_date date,
 archived boolean NOT NULL DEFAULT false,
 favorite boolean NOT NULL DEFAULT false,
 created_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(start_date IS NULL OR end_date IS NULL OR end_date>=start_date)
);
-- The list read is always "live projects, newest edit first"; archived rows are
-- kept for audit but never returned by the default view.
CREATE INDEX ix_projects_live ON projects(updated_at DESC,id DESC) WHERE NOT archived;

CREATE TABLE project_comments(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 project_id bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 author_id text NOT NULL REFERENCES users(id),
 body text NOT NULL CHECK(length(btrim(body)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_project_comments_project ON project_comments(project_id,created_at,id);

CREATE TABLE project_todos(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 project_id bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 body text NOT NULL CHECK(length(btrim(body)) BETWEEN 1 AND 500),
 done boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_project_todos_project ON project_todos(project_id,id);

-- doc_id shares the identifier space of files.id; the stored name is a fallback
-- used only when the live file row is gone.
CREATE TABLE project_docs(
 project_id bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 doc_id text NOT NULL CHECK(length(doc_id) BETWEEN 1 AND 200),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 300),
 kind text NOT NULL CHECK(kind IN ('gdrive','pdf','figma','file')),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(project_id,doc_id)
);

-- Per-user view preferences (column visibility, sort, filters, scope, view kind,
-- gantt scale). One row per user and view; whole-object overwrite.
CREATE TABLE project_view_states(
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 view_key text NOT NULL CHECK(length(view_key) BETWEEN 1 AND 40),
 config jsonb NOT NULL CHECK(jsonb_typeof(config)='object' AND length(config::text)<=16384),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,view_key)
);
