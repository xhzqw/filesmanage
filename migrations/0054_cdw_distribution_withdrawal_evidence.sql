-- G9: immutable proof of withdrawal of a dispatched but NOT effective batch.
-- Existing department receipts and confirmed readings remain preserved.
CREATE TABLE cdw_distribution_withdrawal_events (
 id text PRIMARY KEY,
 batch_id text NOT NULL UNIQUE REFERENCES cdw_distribution_batches(id),
 plan_id text NOT NULL REFERENCES cdw_distribution_plans(id),
 release_id text NOT NULL REFERENCES cdw_controlled_releases(id),
 actor_id text NOT NULL REFERENCES users(id),
 authority_binding_id text NOT NULL REFERENCES cdw_business_role_bindings(id),
 manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[0-9a-f]{64}$'),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 12 AND 3000),
 revoked_grants integer NOT NULL CHECK(revoked_grants>=0),
 cancelled_pending_readers integer NOT NULL CHECK(cancelled_pending_readers>=0),
 invalidated_targets integer NOT NULL CHECK(invalidated_targets>=0),
 withdrawn_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(batch_id,plan_id) REFERENCES cdw_distribution_batches(id,plan_id)
);
CREATE TRIGGER cdw_distribution_withdrawal_immutable BEFORE UPDATE OR DELETE ON cdw_distribution_withdrawal_events
 FOR EACH ROW EXECUTE FUNCTION cdw_prevent_fact_mutation();
