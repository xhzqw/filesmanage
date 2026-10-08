# filesmanage v2.1 — implementation status

Target host: 192.168.1.22 (Debian 13 / Linux), workspace /root/repository77/filesmanage-v21.
Legacy Node/SQLite system and port 8091 remain untouched; DEC-15 data isolation in force.
Implementation started 2026-10-08. Status: Milestones 1–6 COMPLETE and verified on target; Milestone 7 acceptance evidence collected (performance capacity partially met on the shared host); Milestone 8 dev-level recovery PASS, production cutover NOT authorized.

## Done and verified on target
- **M1 real login**: bootstrap, bcrypt auth, httpOnly SameSite=Strict sessions, forced first-login password change, LAN access on 0.0.0.0:18091 behind explicit opt-in + fail-closed source-IP allowlist, browser acceptance (re-verified 2026-10-08 evening: health, wrong-password 401, real login, unauth 401, tree data, logout invalidation).
- **M2 file/folder slice**: folders CRUD + recursive delete/restore; streaming upload → content-addressed blob → v1 in one transaction; keyset pagination; preview with byte-fidelity metadata; authoritative download (now Range-capable via http.ServeContent); save with baseSeq CAS; append-only rollback (DEC-13) with idempotent replay; versions; trash (list/restore/purge); grants CRUD; audit everywhere.
- **M3 organization + permissions**: users (create with issued credential, disable/enable with immediate session kill, admin password reset with forced re-change), departments, workgroups + membership; nine-action ACL server-side with query-layer filtering; cross-user isolation and admin separation verified.
- **M4 approvals + locks**: admin approval policies per folder; pending approvals (202) under policy; approve commits a new immutable version attributed to the requester; reject/cancel publish nothing; single-winner concurrency; edit locks (file-level lease, 30 min server TTL, generation guard, row-lock serialised acquire, auto-release on save, expired-lock takeover, stale tokens cannot free newer locks).
- **M5 DOCX editing + CAD**: ONLYOFFICE Document Server 8.2.2 (AGPL, zero licence cost) self-hosted in Docker on 18080 with JWT; real DOCX editing verified end-to-end with idempotent save-event ledger; CAD pipeline converts STEP/IGES to mesh derivatives in an isolated worker (gmsh + OpenCASCADE 7.8) with subprocess timeout, concurrency cap and memory limits; native STL/OBJ/GLB in three.js; honest format matrix (native / converted / licence-required / unverified).
- **M6 collaboration**: shares (file/folder, user/group, passive actions, expiry, descendants), favorites (idempotent), search + stats + CSV export over one visibility scope, plain-text byte fidelity (12 samples), brand shell (DEC-14) with the explicit logo placeholder.
- **Search UI**: `/search` workbench (query + uploader/type/sort filters, result table, safe `<mark>` snippets, "1000+" capped total) verified in the browser; the tsvector index backfills existing files via `cmd/reindex`.
- **M7 security + performance acceptance**: dataset gate 12/12; security E2E 31/31; streaming CSV export 9/9; 10×100MB uploads; MP4 Range 10/10; Office sessions 12/12; CAD conversion verified incl. the dedup path; backup restore drill PASS; Go tests, vet, architecture check green. Capacity: budgets met at ≤10 users, 10/11 at 30 users on the shared host (see M7-PERF-DATASET-GATE.md).
- **M8 (dev level)**: backup/restore drill PASS (snapshot-derived media manifest, 26 tables, 41 blobs, scratch DB removed); 12/12 manifest unit tests; dev systemd units written and syntax-verified (not installed).

## In progress
- PE15/PE16 browser-harness measurements (WebGL leak run; 1366/1440/1920 first-interactive timings).

## Not done / blockers
- Official Logo binary not yet provided; UI shows explicit "待入库" placeholder (DEC-14: no self-drawn substitute). (BLK-01)
- DWG preview requires a commercial SDK (BLK-03); LibreDwg is not packaged for this Debian release.
- Performance budgets at 100/200 users are not met on this shared host: the PostgreSQL instance is shared with other projects (max_connections=100) and the box runs unrelated services (load 6–7). The SPEC's dedicated reference environment (PERF-003) is the remedy. (BLK-07)
- 2026-10-08 evening: the host became unreachable on 192.168.1.22 (100% packet loss, no ARP entry) for ~40 minutes; work continued over 10.144.144.1. No data or service was lost; the incident is recorded as BLK-06.
- Production 8091 cutover NOT authorized (BLK-05); dev-only on 18091, perf-only on 18092.

## Access (development, LAN-only)
- URL: http://192.168.1.22:18091 (account `admin`; credential at `/root/repository77/filesmanage-v21/.secrets/admin.password`, mode 0600, root-only).
- Processes: `.bin/server` (API) and `.bin/worker` (CAD conversions) under the workspace; ONLYOFFICE container `filesmanage-office` on 18080.
- Perf instance: 127.0.0.1:18092 → `filesmanage_perf` (loopback-only, `FILESMANAGE_DB_MAX_CONNS=25`).
- Migrations 0001–0011 applied to both databases; checksums re-verified by `migrate -check`.
- Operator scripts: `scripts/build.sh [--with-tests]` (reproducible build:
  web → go → vet → architecture → tests → migration checksums) and
  `scripts/run-dev.sh [start|stop|status]` (single-instance dev services with
  health verification).
