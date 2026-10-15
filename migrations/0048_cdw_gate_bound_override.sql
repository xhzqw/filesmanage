-- CDW G6: a delegation is bound to ONE immutable gate and review round.
-- Existing grants (if any) lack gate identity and are deliberately unusable
-- for substitute_review_gate until reissued through the G6 transaction.
ALTER TABLE cdw_override_grants ADD COLUMN gate_id text REFERENCES cdw_review_gates(id);
CREATE INDEX cdw_override_gate_actor_active ON cdw_override_grants(gate_id,actor_id)
 WHERE revoked_at IS NULL;
-- Even privileged direct SQL cannot pair a grant with a mismatched task.
CREATE OR REPLACE FUNCTION cdw_guard_override_gate_task() RETURNS trigger AS $$
BEGIN
 IF NEW.gate_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM cdw_review_gates g JOIN cdw_deliveries d ON d.id=g.delivery_id
  WHERE g.id=NEW.gate_id AND d.task_id=NEW.task_id
 ) THEN RAISE EXCEPTION 'CDW grant gate/task mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER cdw_override_grant_gate_task
 BEFORE INSERT OR UPDATE OF gate_id,task_id ON cdw_override_grants
 FOR EACH ROW EXECUTE FUNCTION cdw_guard_override_gate_task();
