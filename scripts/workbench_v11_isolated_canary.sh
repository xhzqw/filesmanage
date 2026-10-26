#!/usr/bin/env bash
# Only for isolated workbench browser regression. NEVER point to the business DB.
set -euo pipefail
release=/root/repository77/filesmanage-notion-workbench-v11-release-20261026
env_file=/root/repository77/filesmanage-v21/.secrets/server.env
test -x "$release/server"
test -f "$env_file"
set -a
source "$env_file"
set +a
export DATABASE_URL="$(python3 -c 'import os,urllib.parse as u; p=u.urlsplit(os.environ["DATABASE_URL"]); print(u.urlunsplit(p._replace(path="/filesmanage_notion_ui_review_20261026")))')"
[[ "$DATABASE_URL" == *'/filesmanage_notion_ui_review_20261026'* ]]
export FILESMANAGE_ADDR=127.0.0.1:18098
export FILESMANAGE_BLOB_DIR=/tmp/filesmanage-v11-isolated-browser-blobs
mkdir -p "$FILESMANAGE_BLOB_DIR"
cd "$release"
nohup ./server >/tmp/filesmanage-v11-isolated-18098.log 2>&1 </dev/null &
printf '%s\n' "$!" >/tmp/filesmanage-v11-isolated-18098.pid
echo 'Isolated test server started; check process and health separately.'
