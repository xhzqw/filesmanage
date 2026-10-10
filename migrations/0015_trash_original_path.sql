-- Immutable deletion-time ancestor identity/name snapshot.
-- Existing trash rows remain NULL: their historic path cannot be reconstructed
-- reliably from today's mutable folder tree.
ALTER TABLE trash_entries ADD COLUMN old_parent_trail jsonb;
ALTER TABLE trash_entries ADD CONSTRAINT ck_trash_parent_trail_array
 CHECK (old_parent_trail IS NULL OR jsonb_typeof(old_parent_trail)='array');
