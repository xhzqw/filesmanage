-- shares.created_at is required by the sharing UI ordering (SPEC §2.4).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='shares' AND column_name='created_at') THEN
    ALTER TABLE shares ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
  END IF;
END
$$;
