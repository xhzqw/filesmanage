-- Allow a targeted, audited signature revocation as an immutable revision.
-- Signed evidence rows remain append-only; only visible mark_ids change.
ALTER TABLE file_seal_revisions
 DROP CONSTRAINT file_seal_revisions_action_check;
ALTER TABLE file_seal_revisions
 ADD CONSTRAINT file_seal_revisions_action_check
 CHECK (action IN ('sign','restore','legacy','revoke'));
