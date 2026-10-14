-- Existing bearer-token hashes stay server-only. Device metadata is intentionally
-- coarse (browser/OS, source IP), with no full user-agent or fingerprint.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS client_ip text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS device_label text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();
UPDATE sessions SET last_seen_at=created_at WHERE device_label='' AND client_ip='';
CREATE INDEX IF NOT EXISTS ix_sessions_active_user
  ON sessions(user_id,created_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_auth_audit_actor_time
  ON audit_events(actor_id,created_at DESC)
  WHERE event_type IN ('auth.login','auth.logout','auth.session_revoke','auth.sessions_revoke');
