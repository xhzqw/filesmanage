-- G17: one direct successor per interrupted approval. Subsequent reapproval
-- must cite the latest interrupted successor, not fork an older approval.
-- Existing duplicates are deliberately NOT silently rewritten: operators must
-- review and reconcile such history before applying this uniqueness rule.
CREATE UNIQUE INDEX cdw_qms_restart_one_successor
 ON cdw_qms_formal_restarts(previous_approval_id);
CREATE INDEX cdw_qms_restart_file_history
 ON cdw_qms_formal_restarts(file_id,created_at DESC);

-- Guard the formal lineage from direct SQL linking an old interrupted
-- approval to multiple successors; business delivery acceptance is checked
-- by the existing formal-start application transaction, not this trigger.
CREATE OR REPLACE FUNCTION cdw_qms_formal_restart_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev record; next_approval record;
BEGIN
 SELECT a.state,a.requested_by,s.file_id,s.sha256 INTO prev
 FROM cdw_formal_approval_instances a JOIN cdw_approval_subjects s ON s.id=a.subject_id
 WHERE a.id=NEW.previous_approval_id FOR UPDATE OF a;
 SELECT a.state,a.requested_by,a.template_version_id,s.file_id,s.sha256,
        s.delivery_id,s.source_kind
 INTO next_approval
 FROM cdw_formal_approval_instances a JOIN cdw_approval_subjects s ON s.id=a.subject_id
 WHERE a.id=NEW.new_approval_id FOR UPDATE OF a;
 IF prev.state<>'conflicted' OR next_approval.state<>'pending'
  OR prev.file_id IS DISTINCT FROM next_approval.file_id
  OR NEW.file_id IS DISTINCT FROM prev.file_id
  OR NEW.previous_sha256 IS DISTINCT FROM prev.sha256
  OR NEW.new_sha256 IS DISTINCT FROM next_approval.sha256
  OR NEW.submitted_by IS DISTINCT FROM next_approval.requested_by
  OR NOT cdw_qms_special_authority_current(next_approval.file_id,next_approval.template_version_id)
  OR (NOT EXISTS(SELECT 1 FROM cdw_qms_formal_policy_interruptions h
    WHERE h.approval_instance_id=NEW.previous_approval_id)
    AND NOT EXISTS(SELECT 1 FROM cdw_qms_formal_legacy_holds h
    WHERE h.approval_instance_id=NEW.previous_approval_id))
  OR EXISTS(SELECT 1 FROM cdw_qms_formal_restarts r
    WHERE r.previous_approval_id=NEW.previous_approval_id)
 THEN RAISE EXCEPTION 'Restart must be a unique, currently authorized successor of a genuine interruption'
   USING ERRCODE='23514'; END IF;
 -- Original migration-era test fixtures use existing_version frozen subjects;
 -- real creation through the application already requires accepted delivery.
 RETURN NEW;
END $$;
