#!/usr/bin/env bash
# Fail-closed standalone performance service on the seeded filesmanage_perf
# database only. Never reuses the business server or the UX test database.
# start | status | stop. No schema writes or fixture resets.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
ACTION="${1:-status}"
LAB="/root/.local/share/filesmanage-perf-test"
PID_FILE="$LAB/server.pid"
ADDR="127.0.0.1:18093"
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
 python3 - "$pid" "$LAB/blobs" <<'PY'
import sys,urllib.parse
pid,blobs=sys.argv[1:]
try:
 values=dict(part.decode("utf8",errors="replace").split("=",1)
  for part in open(f"/proc/{pid}/environ","rb").read().split(b"\0") if b"=" in part)
 cmd=open(f"/proc/{pid}/cmdline","rb").read()
except (OSError,ValueError):sys.exit(1)
dsn=urllib.parse.urlparse(values.get("DATABASE_URL",""))
if (dsn.path=="/filesmanage_perf" and dsn.hostname in ("localhost","127.0.0.1")
 and values.get("FILESMANAGE_ADDR")=="127.0.0.1:18093"
 and values.get("FILESMANAGE_BLOB_DIR")==blobs
 and b".bin/server" in cmd):sys.exit(0)
sys.exit(1)
PY
}
case "$ACTION" in
 start)
  if verified_pid; then echo "PERF_READY: $BASE (verified)"; exit 0; fi
  if ss -ltnH "sport = :18093" | grep -q .; then
   echo "PERF_REFUSED: port 18093 occupied by unverified process" >&2; exit 2
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
  echo "usage: bash scripts/perf_isolated_lab.sh [start|status|stop]" >&2; exit 2
  ;;
esac
