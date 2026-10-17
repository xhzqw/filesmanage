-- A source item marked not applicable requires a distinct reviewer decision.
-- The nine XMind stages and their original names remain unchanged.
ALTER TABLE dhf_items DROP CONSTRAINT dhf_items_state_check;
ALTER TABLE dhf_items ADD CONSTRAINT dhf_items_state_check CHECK (state IN
 ('unclassified','missing','submitted','accepted','returned','not_applicable_pending','not_applicable'));
ALTER TABLE dhf_items ADD CONSTRAINT dhf_items_na_independent_check CHECK (
 state <> 'not_applicable' OR
 (submitted_by IS NOT NULL AND submitted_at IS NOT NULL AND reviewed_by IS NOT NULL
  AND reviewed_at IS NOT NULL AND reviewed_by <> submitted_by));
CREATE INDEX dhf_events_project_ascending ON dhf_events(project_id,id ASC);
