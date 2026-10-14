#!/usr/bin/env bash
# Fail-closed standalone performance service on the seeded filesmanage_perf
# database only. Never reuses the business server or the UX test database.
# start | status | stop | migrate. Only 'migrate' may add missing schema
# migrations to the isolated perf database, after stopping its server.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
ACTION="${1:-status}"
PORT="${FILESMANAGE_PERF_PORT:-18093}"
[[ "$PORT" =~ ^1809[345]$ ]] || { echo "PERF_REFUSED: port must be one of 18093-18095" >&2; exit 2; }
LAB="/root/.local/share/filesmanage-perf-test-$PORT"
PID_FILE="$LAB/server.pid"
ADDR="127.0.0.1:$PORT"
DB="filesmanage_perf"
BASE="http://$ADDR"
[[ -r .secrets/server.env ]] || { echo "PERF_REFUSED: missing remote environment" >&2; exit 2; }
set -a
. .secrets/server.env
set +a
: "${DATABASE_URL:?PERF_REFUSED: no DSN}"
PERF_DSN="$(python3 - <<'PY'
import os,urllib.parse,sys
url=urllib.parse.urlparse(os.environ["DATABASE_URL"])
if url.hostname not in ("127.0.0.1","localhost") or url.path!="/filesmanage_v21":
 sys.exit("PERF_REFUSED: expected local business DSN as template")
print(urllib.parse.urlunparse(url._replace(path="/filesmanage_perf")))
PY
)"
verified_pid(){
 [[ -s "$PID_FILE" ]] || return 1
 local pid
 pid="$(cat "$PID_FILE")"
 [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null || return 1
 python3 - "$pid" "$LAB/blobs" "$ADDR" <<'PY'
import sys,urllib.parse
pid,blobs,addr=sys.argv[1:]
try:
 values=dict(part.decode("utf8",errors="replace").split("=",1)
  for part in open(f"/proc/{pid}/environ","rb").read().split(b"\0") if b"=" in part)
 cmd=open(f"/proc/{pid}/cmdline","rb").read()
except (OSError,ValueError):sys.exit(1)
dsn=urllib.parse.urlparse(values.get("DATABASE_URL",""))
if (dsn.path=="/filesmanage_perf" and dsn.hostname in ("localhost","127.0.0.1")
 and values.get("FILESMANAGE_ADDR")==addr
 and values.get("FILESMANAGE_BLOB_DIR")==blobs
 and b".bin/server" in cmd):sys.exit(0)
sys.exit(1)
PY
}
case "$ACTION" in
 migrate)
  if verified_pid || ss -ltnH "sport = :$PORT" | grep -q .; then
   echo "PERF_REFUSED: stop the isolated perf server before schema migration" >&2; exit 2
  fi
  python3 scripts/perf_readiness_audit.py
  DATABASE_URL="$PERF_DSN" go run ./cmd/migrate -dir migrations
  python3 scripts/perf_readiness_audit.py
  echo "PERF_SCHEMA_READY: migrations applied to filesmanage_perf only"
  ;;
 start)
  if verified_pid; then echo "PERF_READY: $BASE (verified)"; exit 0; fi
  if ss -ltnH "sport = :$PORT" | grep -q .; then
   echo "PERF_REFUSED: port $PORT occupied by unverified process" >&2; exit 2
  fi
  python3 scripts/perf_readiness_audit.py
  mkdir -p "$LAB/blobs"
  chmod 700 "$LAB" "$LAB/blobs"
  DATABASE_URL="$PERF_DSN" FILESMANAGE_ADDR="$ADDR" \
   FILESMANAGE_BLOB_DIR="$LAB/blobs" FILESMANAGE_COOKIE_SECURE=false \
   FILESMANAGE_DB_MAX_CONNS=6 nohup ./.bin/server >> "$LAB/server.log" 2>&1 &
  printf '%s\n' "$!" > "$PID_FILE"
  sleep 2
  if verified_pid && curl -fsS -o /dev/null "$BASE/health/ready"; then
   echo "PERF_READY: $BASE (DB filesmanage_perf only)"
  else
   echo "PERF_FAILED: isolated server not verified" >&2; exit 2
  fi
  ;;
 status)
  if verified_pid && curl -fsS -o /dev/null "$BASE/health/ready"; then
   echo "PERF_READY: $BASE (DB filesmanage_perf)"
  else
   echo "PERF_STOPPED"
  fi
  ;;
 stop)
  if ! verified_pid; then
   echo "PERF_STOPPED: no verified process; nothing signalled"
   exit 0
  fi
  pid="$(cat "$PID_FILE")"
  kill "$pid"
  for _ in 1 2 3 4 5; do
   if ! kill -0 "$pid" 2>/dev/null; then break; fi
   sleep 1
  done
  echo "PERF_STOPPED: verified perf server only"
  ;;
 *)
  echo "usage: bash scripts/perf_isolated_lab.sh [migrate|start|status|stop]" >&2; exit 2
  ;;
esac
