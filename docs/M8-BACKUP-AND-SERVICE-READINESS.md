# M8 development recovery and supervision — target-only evidence

Date: 2026-10-08 (Asia/Shanghai)
Host: `203.0.113.10`
Workspace: `/srv/filesmanage`
Production deployment gate: **NO-GO**. No 8091 cutover is authorized.

## Backup and restore drill

Execution (on the target as root, using the target-only .secrets/server.env):

```sh
cd /srv/filesmanage
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
cd /srv/filesmanage
python3 scripts/unauth_security_smoke.py --base http://127.0.0.1:18091
```

Result: `SUMMARY pass=17 total=17`.
- 13 private read endpoints reject anonymous access with 401
- Forged foreign origin rejected with 403
- Invalid JSON login rejected with 400
- Incorrect login rejected with 401
- Health/readiness returns 200

Boundary: this is a focused negative smoke test without actual sessions and does not replace S1–S22, API ACL matrices, cross-user isolation or security penetration testing.

## Build and run scripts (commit 892afbc)

- `scripts/build.sh [--with-tests]`: web build (npm ci / vite build) first —
the dev server serves `web/dist` from disk, so the Go binaries can never embed
a stale bundle — then `go build` for server and worker, `go vet`, the
architecture gate, and with `--with-tests` the full `go test ./...` suite plus
`migrate -check` checksum re-verification. Verified on target: BUILD_OK
(server 37M, worker 14M, 11 migrations verified).
- `scripts/run-dev.sh [start|stop|status]`: starts/stops the isolated dev API
and CAD worker from the root-only `.secrets/server.env` (never printed),
verifies `/health/ready`, and normalises to exactly one process of each kind —
removing the duplicate-process footgun of ad-hoc restarts. 8091 stays reserved
(BLK-05).

## Development systemd manifests

- `deploy/filesmanage-v21-dev.service`
- `deploy/filesmanage-v21-worker.service`

These are **dev-only** units. `systemd-analyze verify` passes for both (exit 0;
the only warning is an unrelated pre-existing unit on the host). Unit
verification validates syntax; it does not establish that the services have
been installed/started.

Target preflight for adoption:

```sh
cd /srv/filesmanage
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

## Snapshot-derived Blob manifest correction (new revision, verification pending)

Prior approach queried the **live** `blobs` table after `pg_dump` and could
choose a different media generation if an upload committed between those steps.

The restore drill now:
1. Produces a PostgreSQL custom-format snapshot.
2. Restores that snapshot into an isolated verification database.
3. Queries the **restored** database for its ready Blob manifest.
4. Validates every immutable content-addressed media key against its SHA-256.
5. Archives only snapshot-referenced media and verifies the extracted archive.

The source implementation currently only deletes staging files; ready Blobs are
immutable and not garbage-collected. That retention invariant is an explicit
assumption for backups running concurrently with uploads. If ready-media garbage
collection is added, it must coordinate with backup pinning before production.

Added `scripts/test_backup_manifest.py` with twelve credential-free negative/
positive cases. **The post-change restore drill and unit tests still require
fresh successful execution evidence**; execution protection blocked the attempted
re-run. The earlier PASS proves only the original script, not the corrected
snapshot generation logic. G-DEPLOY remains NO-GO.

## systemd 单元加固（2026-10-09，未安装，BLK-05 授权后可用）

`deploy/` 下的两个单元原已具备基础加固（`ProtectSystem=strict`、
`NoNewPrivileges`、`PrivateTmp`、`ReadWritePaths`、`UMask=0077`）。用
`systemd-analyze security --offline=yes` 量化后暴露面为 **7.9 EXPOSED**，主要
来自以 root 运行且保留全部能力。现已补齐：

- `CapabilityBoundingSet=` / `AmbientCapabilities=`（空）——服务不依赖任何能力；
- `PrivateDevices=true`、`ProtectClock=true`、`ProtectKernelLogs=true`、
  `ProtectHostname=true`、`ProtectProc=invisible`；
- `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`、
  `SystemCallArchitectures=native`、`RestrictNamespaces=true`、
  `RestrictRealtime=true`、`LockPersonality=true`；
- worker 单元补上缺失的 `LimitNOFILE=65536`。

结果：两个单元均降至 **3.3 OK**（`systemd-analyze verify` 无告警）。

**加固经过实证而非假定**（" hardened but broken " 比不加固更糟）：

- 服务端在 `setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all`
  下实跑：`/health/ready` 200、admin 登录 200、目录树 200（数据库读）、
  blob 下载 200（`.blobs` 文件读）——零能力不影响任何一条请求路径；
- CAD worker 同样在零能力下实跑，并完成一次真实转换：gmsh 生成的 torus
  STEP 上传后由该 worker 转换为 12,750 字节网格并经
  `/derivative/bytes` 200 提供（exec 子进程与 `RLIMIT_AS` 均不需能力）。

安装动作本身仍等待 BLK-05 明确授权；授权后 `systemctl enable --now` 即可。
