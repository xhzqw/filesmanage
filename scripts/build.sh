#!/usr/bin/env bash
# Reproducible build for filesmanage v2.1 (SPEC §14.3 Step C / M8).
#
# Order matters: the frontend must be built first because the dev server serves
# web/dist from disk, and the Go binaries are built afterwards so they never
# embed a stale bundle.
#
# Usage: scripts/build.sh [--with-tests]
set -euo pipefail

cd "$(dirname "$0")/.."

echo "== web: npm ci + vite build =="
if [ -d web/node_modules ]; then
  (cd web && npm run build)
else
  (cd web && npm ci && npm run build)
fi

echo "== go: build server and worker =="
go build -o .bin/server ./cmd/server
go build -o .bin/worker ./cmd/worker

echo "== go: vet =="
go vet ./...

echo "== architecture gate =="
python3 scripts/check_architecture.py

echo "== openapi contract drift gate =="
python3 scripts/gen_openapi.py --check

if [ "${1:-}" = "--with-tests" ]; then
  echo "== go: full test suite =="
  go test ./...
  echo "== migrations: checksum re-verify =="
  set -a; . .secrets/server.env; set +a
  go run ./cmd/migrate -dir migrations -check
fi

echo "BUILD_OK server=$(du -h .bin/server | cut -f1) worker=$(du -h .bin/worker | cut -f1)"
