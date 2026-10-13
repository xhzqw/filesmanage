-- Finder-like personal labels are distinct from file_metadata.tags.
-- A label belongs to a user; assignments never move a document or change ACLs.
CREATE TABLE finder_labels (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
 color text NOT NULL CHECK (color IN ('red','orange','yellow','green','blue','purple','gray')),
 sort_order integer NOT NULL DEFAULT 100,
 is_default boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_finder_label_name ON finder_labels(user_id, lower(name));
CREATE UNIQUE INDEX uq_finder_label_default_color ON finder_labels(user_id, color) WHERE is_default;
CREATE INDEX ix_finder_labels_user ON finder_labels(user_id, sort_order, created_at);
CREATE TABLE finder_file_labels (
 label_id text NOT NULL REFERENCES finder_labels(id) ON DELETE CASCADE,
 file_id text NOT NULL REFERENCES files(id) ON DELETE CASCADE,
 PRIMARY KEY(label_id, file_id)
);
CREATE INDEX ix_finder_file_labels_file ON finder_file_labels(file_id);
