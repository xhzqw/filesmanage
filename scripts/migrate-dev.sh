#!/usr/bin/env bash
# Apply idempotent development DB migrations on the remote application host.
# Secrets are loaded only in-process and are never printed or transferred.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -r .secrets/server.env ]]; then
  echo "Development database configuration unavailable" >&2
  exit 1
fi
set -a
source .secrets/server.env
set +a
go run ./cmd/migrate -dir migrations
