-- Knowledge-to-knowledge explicit relation, bidirectional navigation projection.
-- Not a replacement for folder ACL or controlled DHF/CDW records.
CREATE TABLE knowledge_page_links(
 source_page_id text NOT NULL REFERENCES knowledge_pages(id) ON DELETE RESTRICT,
 target_page_id text NOT NULL REFERENCES knowledge_pages(id) ON DELETE RESTRICT,
 linked_by text NOT NULL REFERENCES users(id),
 linked_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(source_page_id,target_page_id),
 CHECK(source_page_id<>target_page_id)
);
CREATE INDEX ix_knowledge_page_links_target ON knowledge_page_links(target_page_id,source_page_id);
