-- G8: never prepare competing controlled releases from one approved snapshot.
-- Existing deployed files, versions and audit remain untouched.
CREATE UNIQUE INDEX cdw_one_active_release_per_candidate
 ON cdw_controlled_releases(approved_candidate_id)
 WHERE state <> 'cancelled';

-- A prepared release can progress through lifecycle state, but its approved
-- content, revision label and original policy snapshot cannot be rewritten.
CREATE FUNCTION cdw_guard_release_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.file_id IS DISTINCT FROM OLD.file_id OR
    NEW.approved_candidate_id IS DISTINCT FROM OLD.approved_candidate_id OR
    NEW.controlled_revision IS DISTINCT FROM OLD.controlled_revision OR
    NEW.display_name_snapshot IS DISTINCT FROM OLD.display_name_snapshot OR
    NEW.policy_snapshot IS DISTINCT FROM OLD.policy_snapshot OR
    NEW.prepared_by IS DISTINCT FROM OLD.prepared_by OR
    NEW.prepared_at IS DISTINCT FROM OLD.prepared_at THEN
  RAISE EXCEPTION 'controlled release identity is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cdw_release_identity_guard
 BEFORE UPDATE ON cdw_controlled_releases
 FOR EACH ROW EXECUTE FUNCTION cdw_guard_release_identity();
