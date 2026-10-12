#!/usr/bin/env bash
# Execute only on the target host against its configured PostgreSQL.
# The probe takes a shared advisory lock, writes inside a transaction and
# rolls back: no business row or journal row survives a successful check.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
. .secrets/server.env
set +a
psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL'
SELECT pg_advisory_lock(21007722);
CREATE TEMP TABLE ws_replay_probe_baseline AS
 SELECT count(*)::bigint AS n FROM realtime_events;
BEGIN;
DO $probe$
DECLARE
 first_id bigint;
 owner text;
 marker text;
BEGIN
 SELECT COALESCE(max(id),0) INTO first_id FROM realtime_events;
 -- Statement trigger proves a mutation enters the transaction's journal.
 UPDATE folders SET name=name WHERE id=(SELECT id FROM folders ORDER BY id LIMIT 1);
 IF NOT EXISTS (SELECT 1 FROM realtime_events
    WHERE id>first_id AND user_id IS NULL AND 'folder'=ANY(scopes)) THEN
    RAISE EXCEPTION 'folder mutation did not append transactional event';
 END IF;
 SELECT id INTO owner FROM users ORDER BY id LIMIT 1;
 IF owner IS NULL THEN RAISE EXCEPTION 'no user for private event probe'; END IF;
 marker:='rt_probe_'||substring(md5(random()::text),1,20);
 INSERT INTO search_presets(user_id,name,fields) VALUES(owner,marker,'{}'::jsonb);
 IF NOT EXISTS (SELECT 1 FROM realtime_events
    WHERE id>first_id AND user_id=owner AND event_type='workspace.changed'
    AND scopes=ARRAY['presets']::text[]) THEN
    RAISE EXCEPTION 'private event missing or broadcast';
 END IF;
 -- Private row cannot appear under another user's replay predicate.
 IF EXISTS (SELECT 1 FROM realtime_events
    WHERE id>first_id AND user_id=owner
    AND (user_id IS NULL OR user_id='rt_unrelated_user')) THEN
    RAISE EXCEPTION 'private event leaked to another user';
 END IF;
END
$probe$;
ROLLBACK;
DO $probe$
BEGIN
 IF (SELECT count(*) FROM realtime_events) <>
    (SELECT n FROM ws_replay_probe_baseline) THEN
  RAISE EXCEPTION 'rolled-back transaction left durable event rows';
 END IF;
END
$probe$;
SELECT pg_advisory_unlock(21007722);
SQL
echo "DURABLE_REALTIME_DB_PASS: transactional trigger, user isolation, rollback atomicity"
