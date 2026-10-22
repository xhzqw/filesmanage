#!/usr/bin/env bash
# Run the project-database PostgreSQL integration test in a disposable database.
# This script MUST execute on the trusted remote developer host, not a laptop.
# No persistent test users, projects, blobs or audit rows survive.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -r .secrets/server.env ]] || { echo "Remote secrets missing; refusing" >&2; exit 1; }
[[ "$(id -u)" -eq 0 ]] || { echo "Run on remote host as root" >&2; exit 1; }
[[ -z "${PROJECT_TEST_DSN:-}" ]] || { echo "Refusing inherited PROJECT_TEST_DSN" >&2; exit 1; }
set -a
source .secrets/server.env
set +a
[[ -n "${DATABASE_URL:-}" ]] || { echo "DATABASE_URL missing" >&2; exit 1; }
lab="project_iso_20261022_$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
[[ "$lab" =~ ^project_iso_20261022_[a-f0-9]{16}$ ]] || exit 1

# The database URI's host/user/password stay in memory on the remote server.
test_dsn=$(PROJECT_LAB_DB="$lab" python3 - <<'PY'
import os,urllib.parse as u
p=u.urlsplit(os.environ["DATABASE_URL"])
if p.scheme not in ("postgres","postgresql") or not p.username or not p.path.strip("/"):
    raise SystemExit("Refusing malformed DATABASE_URL")
if p.path.strip("/")=="postgres":
    raise SystemExit("Refusing server maintenance DSN")
print(u.urlunsplit(p._replace(path="/"+os.environ["PROJECT_LAB_DB"])),end="")
PY
)

cleanup(){
 local rc=$?
 trap - EXIT HUP INT TERM
 # Never interpolate a caller supplied name; only the random lab value above.
 if [[ "$lab" =~ ^project_iso_20261022_[a-f0-9]{16}$ ]]; then
  runuser -u postgres -- dropdb --force --if-exists "$lab" || {
   echo "ALERT: scratch database cleanup failed for $lab" >&2
   exit 1
  }
  echo "PROJECT_FRESH_LAB_DROPPED $lab"
 fi
 exit "$rc"
}
runuser -u postgres -- createdb --owner="$(python3 -c 'import os,urllib.parse as u;print(u.urlsplit(os.environ["DATABASE_URL"]).username)')" "$lab"
trap cleanup EXIT HUP INT TERM
echo "PROJECT_FRESH_LAB_CREATED $lab"
env DATABASE_URL="$test_dsn" go run ./cmd/migrate -dir migrations |
 grep -E '^(APPLIED|MIGRATIONS_OK)' | tail -n 4
env PROJECT_TEST_DSN="$test_dsn" go test ./internal/adapter/postgres -run '^TestProjectPostgresRoundTrip$' -count=1 -timeout=120s -v
echo "PROJECT_FRESH_LAB_PASS $lab"
