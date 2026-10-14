-- Approval decision trail: requester reason, approver comment, decision time.
-- Additive and idempotent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='approvals' AND column_name='reason') THEN
    ALTER TABLE approvals ADD COLUMN reason text NOT NULL DEFAULT '';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='approvals' AND column_name='decision_comment') THEN
    ALTER TABLE approvals ADD COLUMN decision_comment text NOT NULL DEFAULT '';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='approvals' AND column_name='decided_at') THEN
    ALTER TABLE approvals ADD COLUMN decided_at timestamptz;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS ix_approvals_approver_state ON approvals(approver_id,state,created_at DESC);
