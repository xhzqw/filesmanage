#!/usr/bin/env bash
# Dedicated, loopback-only destructive UX lab. Never drops a database.
# Must run on the target server, never on local Mac or the shared dev DB.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077

ACTION="${1:-status}"
TEST_DB="filesmanage_ux_test"
LAB="/root/.local/share/filesmanage-ux-test"
PORT="18092"
TEST_ADDR="127.0.0.1:$PORT"
BASE="http://$TEST_ADDR"
ENV_FILE=".secrets/server.env"
PASS_FILE="$LAB/admin.password"
PID_FILE="$LAB/server.pid"
MARK_FILE="$LAB/initialized"

if [[ ! -r "$ENV_FILE" ]]; then echo "LAB_REFUSED: remote .secrets/server.env required" >&2; exit 2; fi
set -a
# shellcheck disable=SC1091
. "$ENV_FILE"
set +a
: "${DATABASE_URL:?LAB_REFUSED: DATABASE_URL not configured}"

# Reject an unexpected source instead of guessing role/cluster.
DB_ROLE="$(python3 -c 'import os,urllib.parse,re,sys;u=urllib.parse.urlparse(os.environ["DATABASE_URL"]);db=u.path.lstrip("/");role=u.username or "";sys.exit(2) if u.hostname not in ("127.0.0.1","localhost") or db!="filesmanage_v21" or not re.fullmatch("[a-z_][a-z0-9_]*",role) else None;print(role)')"
TEST_DSN="$(python3 -c 'import os,urllib.parse;u=urllib.parse.urlparse(os.environ["DATABASE_URL"]);print(urllib.parse.urlunparse(u._replace(path="/filesmanage_ux_test")))')"
export TEST_DSN

assert_test_dsn(){
 python3 - <<'PY'
import os,urllib.parse,sys
url=urllib.parse.urlparse(os.environ["TEST_DSN"])
if url.path!="/filesmanage_ux_test" or url.hostname not in ("localhost","127.0.0.1"):
 sys.exit("LAB_REFUSED: isolated database URL mismatch")
PY
}

# Bind a stored PID to its actual environment; this is stronger than trusting
# the caller's DATABASE_URL when a service could use another database.
verified_pid(){
 [[ -s "$PID_FILE" ]] || return 1
 local pid
 pid="$(cat "$PID_FILE")"
 [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null || return 1
 python3 - "$pid" "$TEST_DB" "$TEST_ADDR" "$LAB/blobs" <<'PY'
import sys,urllib.parse
pid,db,addr,blobs=sys.argv[1:]
try:
 values=dict(part.decode("utf8",errors="replace").split("=",1)
  for part in open(f"/proc/{pid}/environ","rb").read().split(b"\0") if b"=" in part)
except (OSError,ValueError):sys.exit(1)
dsn=urllib.parse.urlparse(values.get("DATABASE_URL",""))
if (dsn.path=="/"+db and values.get("FILESMANAGE_ADDR")==addr
    and values.get("FILESMANAGE_BLOB_DIR")==blobs):sys.exit(0)
sys.exit(1)
PY
}

assert_test_dsn
case "$ACTION" in
 setup)
  mkdir -p "$LAB/blobs"
  chmod 700 "$LAB" "$LAB/blobs"
  if [[ -s "$PID_FILE" ]] && verified_pid; then
   echo "LAB_READY: isolated service already running at $BASE"
   exit 0
  fi
  if ss -ltnH "sport = :$PORT" | grep -q .; then
   echo "LAB_REFUSED: port $PORT already occupied; never interrupt an unknown service" >&2
   exit 2
  fi
  EXISTS="$(runuser -u postgres -- psql -Atqc "SELECT count(*) FROM pg_database WHERE datname='$TEST_DB'")"
  if [[ "$EXISTS" == "0" ]]; then
   runuser -u postgres -- createdb -O "$DB_ROLE" "$TEST_DB"
   echo "LAB_CREATED: dedicated test database (no production data copied)"
  elif [[ "$EXISTS" != "1" || ! -f "$MARK_FILE" ]]; then
   echo "LAB_REFUSED: existing unclaimed test database; no takeover/overwrite" >&2
   exit 2
  fi
  if [[ ! -f "$MARK_FILE" ]]; then
   openssl rand -base64 36 > "$PASS_FILE"
   chmod 600 "$PASS_FILE"
   DATABASE_URL="$TEST_DSN" go run ./cmd/migrate -dir migrations
   DATABASE_URL="$TEST_DSN" FILESMANAGE_ALLOW_BOOTSTRAP=new-empty-database \
    BOOTSTRAP_ADMIN_PASSWORD_FILE="$PASS_FILE" go run ./cmd/bootstrap
   # Only the disposable database is modified. The real admin password is
   # never read or changed. Tests do not support the first-login redirect.
   DATABASE_URL="$TEST_DSN" psql "$TEST_DSN" -v ON_ERROR_STOP=1 -q \
    -c "UPDATE users SET must_change_password=false WHERE id='u_admin'"
   touch "$MARK_FILE"
  fi
  [[ -r "$PASS_FILE" ]] || { echo "LAB_REFUSED: QA password missing" >&2; exit 2; }
  DATABASE_URL="$TEST_DSN" FILESMANAGE_ADDR="$TEST_ADDR" \
   FILESMANAGE_BLOB_DIR="$LAB/blobs" FILESMANAGE_COOKIE_SECURE=false \
   FILESMANAGE_DB_MAX_CONNS=3 nohup ./.bin/server >> "$LAB/server.log" 2>&1 &
  pid=$!
  printf '%s\n' "$pid" > "$PID_FILE"
  sleep 2
  verified_pid && curl -fsS -o /dev/null "$BASE/health/ready" ||
   { echo "LAB_FAILED: service did not start with verified isolation" >&2; exit 1; }
  echo "LAB_READY: isolated server at $BASE (business service untouched)"
  ;;
 status)
  if verified_pid && curl -fsS -o /dev/null "$BASE/health/ready"; then
   echo "LAB_READY: $BASE, isolated DB $TEST_DB"
  else
   echo "LAB_STOPPED: setup required"
  fi
  ;;
 run)
  if ! verified_pid || ! curl -fsS -o /dev/null "$BASE/health/ready"; then
   echo "LAB_REFUSED: no running server with proven test DB and isolated blob path" >&2
   exit 2
  fi
  suite="${2:-}"
  case "$suite" in
   ux_desktop_check|ux_visual_check|ux_workflows_check|ux_perf_check|ux_approval_check)
    DATABASE_URL="$TEST_DSN" FILESMANAGE_UX_FIXTURE_DB="$TEST_DB" \
     node "scripts/$suite.mjs" --isolated-fixtures --base "$BASE" --password-file "$PASS_FILE"
    ;;
   ui_geometry_check)
    DATABASE_URL="$TEST_DSN" FILESMANAGE_UX_FIXTURE_DB="$TEST_DB" \
     FILESMANAGE_BASE="$BASE" FILESMANAGE_ADMIN_PASSWORD_FILE="$PASS_FILE" \
     node scripts/ui_geometry_check.mjs --isolated-fixtures
    ;;
   *) echo "LAB_REFUSED: unknown suite; explicit allowlist required" >&2; exit 2 ;;
  esac
  ;;
 stop)
  if verified_pid; then
   kill "$(cat "$PID_FILE")"
   rm -f "$PID_FILE"
   echo "LAB_STOPPED: QA service; test database and evidence retained"
  else
   echo "LAB_REFUSED: no verified QA server; did not signal any process" >&2
   exit 2
  fi
  ;;
 *)
  echo "usage: scripts/ux_isolated_lab.sh [setup|status|run <ux_desktop_check|ux_visual_check|ux_workflows_check|ux_perf_check|ux_approval_check|ui_geometry_check>|stop]" >&2
  exit 2
  ;;
esac
