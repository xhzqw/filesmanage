-- CAD derivative columns used by the conversion pipeline (SPEC §20.5).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='model_derivatives' AND column_name='source_format') THEN
    ALTER TABLE model_derivatives ADD COLUMN source_format text NOT NULL DEFAULT '';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='model_derivatives' AND column_name='output_sha256') THEN
    ALTER TABLE model_derivatives ADD COLUMN output_sha256 char(64);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='model_derivatives' AND column_name='output_size') THEN
    ALTER TABLE model_derivatives ADD COLUMN output_size bigint;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='model_derivatives' AND column_name='started_at') THEN
    ALTER TABLE model_derivatives ADD COLUMN started_at timestamptz;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='model_derivatives' AND column_name='finished_at') THEN
    ALTER TABLE model_derivatives ADD COLUMN finished_at timestamptz;
  END IF;
END
$$;
