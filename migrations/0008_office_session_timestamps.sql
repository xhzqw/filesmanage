-- office_sessions lifecycle timestamps (SPEC §19.6): created/closed markers
-- alongside the lock generation added earlier in this migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='office_sessions' AND column_name='created_at') THEN
    ALTER TABLE office_sessions ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='office_sessions' AND column_name='closed_at') THEN
    ALTER TABLE office_sessions ADD COLUMN closed_at timestamptz;
  END IF;
END
$$;
