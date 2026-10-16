-- One frozen physical issue lot per designated department/item.
-- A physical copy has its own mutable state pointer and immutable event trail.
-- Electronic reading receipts are not evidence of paper recovery.
CREATE UNIQUE INDEX cdw_unique_paper_lot_target_item ON cdw_copy_issue_lots(target_id,batch_item_id);
CREATE TABLE cdw_controlled_copy_heads (
 copy_id text PRIMARY KEY REFERENCES cdw_controlled_copies(id),
 state text NOT NULL DEFAULT 'issued' CHECK(state IN ('issued','collected','destroyed','lost','waived')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>=1),
 current_event_id text REFERENCES cdw_withdrawal_events(id) DEFERRABLE INITIALLY DEFERRED,
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((state='issued' AND current_event_id IS NULL) OR (state<>'issued' AND current_event_id IS NOT NULL))
);
CREATE UNIQUE INDEX cdw_copy_head_event_unique ON cdw_controlled_copy_heads(current_event_id)
 WHERE current_event_id IS NOT NULL;
CREATE TRIGGER cdw_paper_withdrawal_immutable BEFORE UPDATE OR DELETE ON cdw_withdrawal_events
 FOR EACH ROW EXECUTE FUNCTION cdw_prevent_fact_mutation();
