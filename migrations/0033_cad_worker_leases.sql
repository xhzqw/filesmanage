-- Persisted ownership prevents crashed CAD workers from leaving jobs stuck.
ALTER TABLE conversion_jobs
  ADD COLUMN lease_owner text,
  ADD COLUMN lease_until timestamptz;

-- Jobs interrupted before upgrading have no owner and are safe to reclaim
-- once the old worker process has been stopped for the rollout.
UPDATE conversion_jobs
  SET lease_until = now() - interval '1 second'
  WHERE state = 'running' AND lease_until IS NULL;

CREATE INDEX ix_conversion_jobs_claim
  ON conversion_jobs (state, created_at, id);
CREATE INDEX ix_conversion_jobs_expired
  ON conversion_jobs (lease_until, created_at, id)
  WHERE state = 'running';
