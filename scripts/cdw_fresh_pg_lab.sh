#!/usr/bin/env bash
# Run the complete CDW G2-G11 integration test against a unique empty database.
# This script MUST execute on the trusted remote developer host, not a laptop.
# No persistent test users, due schedules, grants, blobs, or events survive.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -r .secrets/server.env ]] || { echo "Remote secrets missing; refusing" >&2; exit 1; }
[[ "$(id -u)" -eq 0 ]] || { echo "Run on remote host as root" >&2; exit 1; }
[[ -z "${CDW_TASK_TEST_DSN:-}" && -z "${CDW_TASK_TEST_FRESH_LAB:-}" ]] || {
 echo "Refusing inherited CDW lab overrides" >&2; exit 1;
}
set -a
source .secrets/server.env
set +a
[[ -n "${DATABASE_URL:-}" ]] || { echo "DATABASE_URL missing" >&2; exit 1; }
lab="cdw_g2_tasks_iso_20261015_$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
[[ "$lab" =~ ^cdw_g2_tasks_iso_20261015_[a-f0-9]{16}$ ]] || exit 1

# The database URI's host/user/password stay in memory on the remote server.
test_dsn=$(CDW_FRESH_LAB_DB="$lab" python3 - <<'PY'
import os,urllib.parse as u
p=u.urlsplit(os.environ["DATABASE_URL"])
if p.scheme not in ("postgres","postgresql") or not p.username or not p.path.strip("/"):
    raise SystemExit("Refusing malformed DATABASE_URL")
if p.path.strip("/")=="postgres":
    raise SystemExit("Refusing server maintenance DSN")
print(u.urlunsplit(p._replace(path="/"+os.environ["CDW_FRESH_LAB_DB"])),end="")
PY
)

cleanup(){
 local rc=$?
 trap - EXIT HUP INT TERM
 # Never interpolate a caller supplied name; only the random lab value above.
 if [[ "$lab" =~ ^cdw_g2_tasks_iso_20261015_[a-f0-9]{16}$ ]]; then
  runuser -u postgres -- dropdb --force --if-exists "$lab" || {
   echo "ALERT: scratch database cleanup failed for $lab" >&2
   exit 1
  }
  echo "CDW_FRESH_LAB_DROPPED $lab"
 fi
 exit "$rc"
}
runuser -u postgres -- createdb --owner=filesmanage_v21 "$lab"
trap cleanup EXIT HUP INT TERM
echo "CDW_FRESH_LAB_CREATED $lab"
env DATABASE_URL="$test_dsn" go run ./cmd/migrate -dir migrations |
 grep -E '^(APPLIED|MIGRATIONS_OK)' | tail -n 4
env CDW_TASK_TEST_DSN="$test_dsn" CDW_TASK_TEST_FRESH_LAB="$lab" go test ./internal/adapter/postgres -run '^TestCDWTaskPostgresTransactions$' -count=1 -timeout=110s -v
echo "CDW_FRESH_LAB_PASS $lab"
