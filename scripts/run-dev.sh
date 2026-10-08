#!/usr/bin/env bash
# Start the isolated development services (SPEC M8 / deploy/ manifests).
#
# The dev API binds 0.0.0.0:18091 and the CAD worker claims conversion jobs
# from the same business database. Both read their environment from the
# root-only .secrets/server.env (never printed, never logged). Production port
# 8091 stays reserved — switching it needs explicit authorization (BLK-05).
#
# Usage: scripts/run-dev.sh [start|stop|status]
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=.secrets/server.env
if [ ! -f "$ENV_FILE" ]; then
  echo "missing $ENV_FILE (root-only environment)" >&2
  exit 1
fi

start() {
  if pgrep -f '^\./\.bin/server$' >/dev/null; then
    echo "dev server already running (pid $(pgrep -f '^\./\.bin/server$' | tr '\n' ' '))"
  else
    set -a; . "$ENV_FILE"; set +a
    nohup ./.bin/server >> .bin/server.log 2>&1 &
    echo "dev server started on ${FILESMANAGE_ADDR:-127.0.0.1:18091}"
  fi
  if pgrep -f '^\./\.bin/worker$' >/dev/null; then
    echo "cad worker already running (pid $(pgrep -f '^\./\.bin/worker$' | tr '\n' ' '))"
  else
    set -a; . "$ENV_FILE"; set +a
    nohup ./.bin/worker >> .bin/worker.log 2>&1 &
    echo "cad worker started"
  fi
  sleep 2
  curl -fsS -o /dev/null "${FILESMANAGE_ADDR:-http://127.0.0.1:18091}/health/ready" \
    && echo "health/ready OK"
}

stop() {
  pkill -f '^\./\.bin/server$' 2>/dev/null && echo "dev server stopped" || echo "dev server not running"
  pkill -f '^\./\.bin/worker$' 2>/dev/null && echo "cad worker stopped" || echo "cad worker not running"
}

status() {
  echo "server: $(pgrep -f '^\./\.bin/server$' | tr '\n' ' ' || true)"
  echo "worker: $(pgrep -f '^\./\.bin/worker$' | tr '\n' ' ' || true)"
  curl -fsS -o /dev/null "${FILESMANAGE_ADDR:-http://127.0.0.1:18091}/health/ready" \
    && echo "health/ready OK" || echo "health/ready unreachable"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  *) echo "usage: $0 [start|stop|status]" >&2; exit 2 ;;
esac
