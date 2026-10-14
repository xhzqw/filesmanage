-- Mutable business metadata is independent of immutable document versions.
CREATE TABLE file_metadata (
 file_id text PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
 category text NOT NULL DEFAULT '' CHECK (length(category)<=80),
 description text NOT NULL DEFAULT '' CHECK (length(description)<=2000),
 tags text[] NOT NULL DEFAULT ARRAY[]::text[] CHECK(cardinality(tags)<=20),
 updated_by text NOT NULL REFERENCES users(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_file_metadata_category ON file_metadata(category) WHERE category<>'';
CREATE INDEX ix_file_metadata_tags ON file_metadata USING gin(tags);
CREATE INDEX ix_audit_document_activity ON audit_events(id DESC)
 WHERE target_kind IN ('file','trash') OR event_type LIKE 'office.%' OR event_type LIKE 'approval.%';
