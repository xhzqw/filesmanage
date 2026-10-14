-- DMS-03 immutable version-anchored review comments, independently resolvable.
CREATE TABLE file_review_comments(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 file_id text NOT NULL REFERENCES files(id) ON DELETE CASCADE,
 version_seq integer NOT NULL CHECK(version_seq>0),
 author_id text NOT NULL REFERENCES users(id),
 body text NOT NULL CHECK(char_length(body) BETWEEN 1 AND 2000),
 line_number integer CHECK(line_number BETWEEN 1 AND 1000000),
 created_at timestamptz NOT NULL DEFAULT now(),
 resolved_at timestamptz,
 resolved_by text REFERENCES users(id),
 CONSTRAINT fk_review_version FOREIGN KEY(file_id,version_seq)
   REFERENCES file_versions(file_id,seq) ON DELETE CASCADE
);
CREATE INDEX ix_review_file_seq_id ON file_review_comments(file_id,version_seq,id DESC);
