-- 0093: Notion-like knowledge pages, independent from CDW/DHF controlled records.
-- Explicit folder home linking only. Published project template automation is NOT enabled.
CREATE TABLE knowledge_pages (
 id text PRIMARY KEY,
 parent_id text REFERENCES knowledge_pages(id) ON DELETE RESTRICT,
 folder_id text REFERENCES folders(id) ON DELETE RESTRICT,
 owner_id text NOT NULL REFERENCES users(id),
 title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 180),
 blocks jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(blocks)='array' AND pg_column_size(blocks) <= 524288),
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 deleted_at timestamptz,
 CHECK(parent_id IS DISTINCT FROM id)
);
CREATE INDEX ix_knowledge_page_owner ON knowledge_pages(owner_id, parent_id,updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX ix_knowledge_page_folder ON knowledge_pages(folder_id) WHERE deleted_at IS NULL;
CREATE TABLE knowledge_page_revisions (
 page_id text NOT NULL REFERENCES knowledge_pages(id) ON DELETE RESTRICT,
 revision integer NOT NULL CHECK (revision > 0),
 title text NOT NULL,
 blocks jsonb NOT NULL,
 editor_id text NOT NULL REFERENCES users(id),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(page_id,revision)
);
CREATE TABLE folder_knowledge_homes (
 folder_id text PRIMARY KEY REFERENCES folders(id) ON DELETE RESTRICT,
 page_id text NOT NULL UNIQUE REFERENCES knowledge_pages(id) ON DELETE RESTRICT,
 linked_by text NOT NULL REFERENCES users(id),
 linked_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE knowledge_file_refs (
 page_id text NOT NULL REFERENCES knowledge_pages(id) ON DELETE RESTRICT,
 file_id text NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
 linked_by text NOT NULL REFERENCES users(id),
 linked_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(page_id,file_id)
);
CREATE INDEX ix_knowledge_refs_file ON knowledge_file_refs(file_id,page_id);
-- The source page and history never disappear when a file is unlinked:
-- reference removal only deletes the active association and records an audit.
