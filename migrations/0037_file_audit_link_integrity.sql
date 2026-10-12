-- Event-to-file associations are evidence. Correct mistaken associations
-- using new compensating audit events, never by mutating existing links.
CREATE OR REPLACE FUNCTION reject_file_audit_link_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'file audit links are append-only'
 USING ERRCODE='23514';
END $$;

CREATE TRIGGER trg_file_audit_links_immutable
 BEFORE UPDATE OR DELETE ON file_audit_links
 FOR EACH ROW EXECUTE FUNCTION reject_file_audit_link_mutation();
