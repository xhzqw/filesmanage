-- Snapshot the ordered approval chain on submission.
ALTER TABLE approval_policies ADD COLUMN approver_chain text[] NOT NULL DEFAULT ARRAY[]::text[];
UPDATE approval_policies SET approver_chain=ARRAY[approver_id];
ALTER TABLE approvals ADD COLUMN approver_chain text[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE approvals ADD COLUMN step_index integer NOT NULL DEFAULT 0 CHECK(step_index>=0);
UPDATE approvals SET approver_chain=ARRAY[approver_id];
ALTER TABLE approval_policies ADD CONSTRAINT chk_policy_chain CHECK(cardinality(approver_chain) BETWEEN 1 AND 5);
ALTER TABLE approvals ADD CONSTRAINT chk_approval_chain CHECK(cardinality(approver_chain) BETWEEN 1 AND 5 AND step_index<cardinality(approver_chain));
