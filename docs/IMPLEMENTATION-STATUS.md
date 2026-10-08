# filesmanage v2.1 — implementation status

Target host: 192.168.1.22 (Debian 13 / Linux), workspace /root/repository77/filesmanage-v21.
Legacy Node/SQLite system and port 8091 remain untouched; DEC-15 data isolation in force.
Implementation started 2026-10-08; full-gate re-run completed 2026-10-09 (commit 1b91ba7). Status: Milestones 1–6 COMPLETE and verified on target; Milestone 7 acceptance evidence collected and re-verified end-to-end (performance capacity met at ≤10 users; 100/200-user budgets blocked by shared-host capacity, BLK-07); Milestone 8 dev-level recovery PASS, production cutover NOT authorized.

## Done and verified on target
- **M1 real login**: bootstrap, bcrypt auth, httpOnly SameSite=Strict sessions, forced first-login password change, LAN access on 0.0.0.0:18091 behind explicit opt-in + fail-closed source-IP allowlist, browser acceptance (re-verified 2026-10-08 evening: health, wrong-password 401, real login, unauth 401, tree data, logout invalidation). The full core journey is now a repeatable gate: `scripts/browser_journey_check.mjs` (19/19, run 3x on 2026-10-09) walks login → wrong-password refusal → real login → tree → create folder → upload → preview → download → delete → trash → restore → logout through the real UI.
- **M2 file/folder slice**: folders CRUD + recursive delete/restore; streaming upload → content-addressed blob → v1 in one transaction; keyset pagination; preview with byte-fidelity metadata; authoritative download (now Range-capable via http.ServeContent); save with baseSeq CAS; append-only rollback (DEC-13) with idempotent replay; versions; trash (list/restore/purge); grants CRUD; audit everywhere.
- **M3 organization + permissions**: users (create with issued credential, disable/enable with immediate session kill, admin password reset with forced re-change), departments, workgroups + membership; nine-action ACL server-side with query-layer filtering; cross-user isolation and admin separation verified.
- **M4 approvals + locks**: admin approval policies per folder; pending approvals (202) under policy; approve commits a new immutable version attributed to the requester; reject/cancel publish nothing; single-winner concurrency; edit locks (file-level lease, 30 min server TTL, generation guard, row-lock serialised acquire, auto-release on save, expired-lock takeover, stale tokens cannot free newer locks).
- **M5 DOCX editing + CAD**: ONLYOFFICE Document Server 8.2.2 (AGPL, zero licence cost) self-hosted in Docker on 18080 with JWT; real DOCX editing verified end-to-end with idempotent save-event ledger; CAD pipeline converts STEP/IGES to mesh derivatives in an isolated worker (gmsh + OpenCASCADE 7.8) with subprocess timeout, concurrency cap and memory limits; IGES verified with the OCCT-shipped bearing/hammer samples (2,148-facet and 144,873-byte meshes); native STL/OBJ/GLB in three.js; honest format matrix (native / converted / licence-required / unverified).
- **M6 collaboration**: shares (file/folder, user/group, passive actions, expiry, descendants), favorites (idempotent), search + stats + CSV export over one visibility scope, plain-text byte fidelity (12 samples), brand shell (DEC-14) with the explicit logo placeholder. The business surfaces are browser-verified by `scripts/browser_business_check.mjs` (12/12, run 2x): search returns real rows with safe `<mark>` snippets, stats render real aggregates, the org form creates and disables a user, and the approval inbox commits a genuinely pending change through the UI.
- **Search UI**: `/search` workbench (query + uploader/type/sort filters, result table, safe `<mark>` snippets, "1000+" capped total) verified in the browser; the tsvector index backfills existing files via `cmd/reindex`.
- **PE15 WebGL/heap leak measurement (2026-10-09)**: CDP-driven 20-cycle load/teardown measurement of the real model page — 544 triangles rendered every cycle, late-window teardown slope 0.13–0.19 MB/cycle against a 0.5 budget, heap returns to the same 8.6 MB floor after warmup, doc-only control run flat (0.000 MB/cycle late slope); `scripts/pe15_heap_growth.mjs`, reports in `.secrets/perf/pe15-*.json`.
- **M7 security + performance acceptance (final re-run 2026-10-09, commit 1b91ba7)**: dataset gate 12/12; security E2E 31/31; S matrix 32/32; rollback 27/27; PT fidelity 112/112; CAD matrix 57/57; DO05 15/15; streaming CSV export 9/9 (100,433 rows); 10×100MB uploads 10/10; MP4 Range 10/10; Office sessions 12/12; PE12 worker isolation 7/7 (x0.93–x1.14, clean environment); backup restore drill PASS (26 tables, 222 blobs) + manifest 12/12; migration contract verified; Go tests, vet, architecture check green; loadtest 11/11 at 10 users. Capacity: budgets met at ≤10 users on the shared host; 100/200 users pool-bound (see M7-PERF-DATASET-GATE.md and BLK-07).
- **M8 (dev level)**: backup/restore drill PASS (snapshot-derived media manifest, 26 tables, 41 blobs, scratch DB removed); 12/12 manifest unit tests; dev systemd units written and syntax-verified (not installed).

## Delivered in the final gate pass (2026-10-09)
- **OpenAPI contract**: `docs/openapi-implemented.yaml` now covers all 66
  implemented endpoints (50 paths / 46 schemas), generated by
  `scripts/gen_openapi.py` with a `--check` drift guard; SPEC 5.3 error
  envelope on every >=400 response. Previously only 7 routes were documented.

## Acceptance matrix (generated, machine-checked)

`docs/ACCEPTANCE-MATRIX.md` (generated by `scripts/gen_acceptance_matrix.py`)
maps every one of the 126 acceptance ids declared in SPEC v2.1 to concrete
evidence: **123 PASS / 2 PARTIAL / 1 EXTERNAL**. Every PARTIAL id is a real
capability gap; none remains — the two PARTIAL ids are customer-input items (S12's systemd auto-start in BLK-05, S20 official Logo in BLK-01); S12's other two parts (LAN reachability, upgrade/rollback drill 12/12) are evidenced
(S12 folded into BLK-05, S20 into BLK-01); the gate fails the build if an id
has no curated row, if the matrix drifts, or if a PARTIAL id is unregistered.
Partial areas: none — every implementable SPEC gap is closed. The two
remaining PARTIAL ids need customer input (S12 → BLK-05 production cutover,
S20 → BLK-01 official Logo asset). Closed since the matrix landed: BLK-14 (viewer control surface —
CDP-verified 10/10), BLK-16 (CAD negative paths — 78/78, which exposed and
fixed a worker defect: gmsh exits 0 on unreadable geometry and writes an
empty STL, so the worker now refuses to publish an empty mesh) and BLK-12
(multi-resource models — OBJ+MTL+texture, glTF+.bin+texture and two-part 3MF
now render through sibling resolution, 15/15; that work also exposed a
pagination boundary bug where the documented limit=200 answered 400) and
BLK-13 (metadata panel — format/version/source SHA/dimensions/component
count/derivative SHA/warnings, 未知单位 instead of assumed millimetres,
and every dimension labelled 近似（三角化网格）; 30/30 verified against the
API).

## In progress
- (none — every in-flight acceptance item now has a real measurement)

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
- **Operator runbook**: `docs/OPERATOR-RUNBOOK.md` — access & credentials, service
  lifecycle, the full gate table with commands and expected results, backup/restore,
  upgrade/rollback, troubleshooting (incl. the pitfalls hit during implementation)
  and the prohibited actions.
- Operator scripts: `scripts/build.sh [--with-tests]` (reproducible build:
  web → go → vet → architecture → tests → migration checksums) and
  `scripts/run-dev.sh [start|stop|status]` (single-instance dev services with
  health verification).
