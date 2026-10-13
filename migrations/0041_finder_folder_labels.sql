-- A folder is a directly tagged resource, not an instruction to recursively tag descendants.
CREATE TABLE finder_folder_labels (
 label_id text NOT NULL REFERENCES finder_labels(id) ON DELETE CASCADE,
 folder_id text NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
 PRIMARY KEY(label_id,folder_id)
);
CREATE INDEX ix_finder_folder_labels_folder ON finder_folder_labels(folder_id);
