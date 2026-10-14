-- SPEC §6.6 trash lifecycle: purge marker and reserved auto-purge horizon.
-- Additive and idempotent; safe to re-run on an existing database.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='trash_entries' AND column_name='purged_at') THEN
    ALTER TABLE trash_entries ADD COLUMN purged_at timestamptz;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='trash_entries' AND column_name='purge_after') THEN
    ALTER TABLE trash_entries ADD COLUMN purge_after timestamptz;
  END IF;
END
$$;
