# M8 development recovery and supervision — target-only evidence

Date: 2026-10-08 (Asia/Shanghai)
Host: `192.168.1.22`
Workspace: `/root/repository77/filesmanage-v21`
Production deployment gate: **NO-GO**. No 8091 cutover is authorized.

## Backup and restore drill

Execution (on the target as root, using the target-only .secrets/server.env):

```sh
cd /root/repository77/filesmanage-v21
set -a
. .secrets/server.env
set +a
python3 scripts/backup_restore_drill.py
```

Actual completed run:
- Output: `RESTORE_DRILL_PASS tables=26 blobs=39`
- Scratch PostgreSQL database created, restored and then removed
- Consistent custom-format `pg_dump` archive restored to isolated scratch database
- A separate gzip archive restored and every referenced ready Blob checked against its SHA-256
- Backup archive and per-table report retained on target at
  `.secrets/backup-drills/20261008T105632Z/`
- `database.dump`, `blobs.tar.gz`, `report.json` remain under root-protected `.secrets`, not committed
- Does not modify original business DB or old Node/SQLite stores

Boundary: this checks logical database/media recovery, not a full same-minute point-in-time recovery.
Concurrent writes during the separate database and filesystem snapshots can produce mixed-time backup sets; production-grade consistent cutover needs a coordinated write barrier or a manifest/transactional media generation contract. Until implemented, backup is a **development restore drill PASS**, not production backup-release GO.

## Anonymous API and cross-origin regression

```sh
cd /root/repository77/filesmanage-v21
python3 scripts/unauth_security_smoke.py --base http://127.0.0.1:18091
```

Result: `SUMMARY pass=17 total=17`.
- 13 private read endpoints reject anonymous access with 401
- Forged foreign origin rejected with 403
- Invalid JSON login rejected with 400
- Incorrect login rejected with 401
- Health/readiness returns 200

Boundary: this is a focused negative smoke test without actual sessions and does not replace S1–S22, API ACL matrices, cross-user isolation or security penetration testing.

## Development systemd manifests

- `deploy/filesmanage-v21-dev.service`
- `deploy/filesmanage-v21-worker.service`

These are **dev-only** units. Unit verification validates syntax; it does not establish that the services have been installed/started.

Target preflight for adoption:

```sh
cd /root/repository77/filesmanage-v21
systemd-analyze verify deploy/filesmanage-v21-dev.service deploy/filesmanage-v21-worker.service
curl -fsS http://127.0.0.1:18091/health/ready
ps -eo pid,ppid,args | grep '[.]bin/server'
```

Before enabling either unit: verify that manual processes are quiesced under a coordinated maintenance window, that port 18091 is no longer owned by a manually launched server, and that the unit's root-owned environment and writable Blob path meet the security policy. For the worker, avoid duplicate task claims and assess transactional queue safety before switching.

Only then, with an approved dev-service switch, install/enable the units and test startup, failure/restart, recovery, editor callback, directory listing and login.

Do not install/enable this unit over an occupied port, kill unrelated services, or interpret development `systemd` readiness as approval to switch 8091.

## Remaining release blockers

- Full PERF PE01–PE18 at specified dataset size and concurrency with workload metrics
- Full BUSINESS S1–S22 and DOCX/CAD sample matrices
- Production-grade backup consistency, recovery time objective and restore of true user access
- Safe dev-to-systemd handover and monitoring/log retention
- Official Logo asset and DWG commercial licensing
- Formal 8091 release approval
