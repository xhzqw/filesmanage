-- G11 explicit management, integration and reporting accountability.
-- This is separate from delivery acceptance and formal document approval.
CREATE TABLE cdw_obligation_fulfillments (
 id text PRIMARY KEY,
 obligation_id text NOT NULL UNIQUE REFERENCES cdw_accountability_obligations(id),
 task_id text NOT NULL REFERENCES cdw_tasks(id),
 actor_id text NOT NULL REFERENCES users(id),
 obligation_kind text NOT NULL CHECK(obligation_kind IN ('manage','integrate','report','acknowledge_override')),
 statement text NOT NULL CHECK(length(btrim(statement)) BETWEEN 12 AND 3000),
 evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
 prerequisite_snapshot jsonb NOT NULL CHECK(jsonb_typeof(prerequisite_snapshot)='object'),
 completed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX cdw_obligation_fulfillments_task ON cdw_obligation_fulfillments(task_id,completed_at);
CREATE TRIGGER cdw_obligation_fulfillments_immutable BEFORE UPDATE OR DELETE ON cdw_obligation_fulfillments
 FOR EACH ROW EXECUTE FUNCTION cdw_prevent_fact_mutation();
