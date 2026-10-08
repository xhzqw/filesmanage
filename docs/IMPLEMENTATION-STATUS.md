# filesmanage v2.1 — implementation status

Target host: 192.168.1.22 (Debian 13 / Linux), workspace /root/repository77/filesmanage-v21.
Legacy Node/SQLite system and port 8091 remain untouched; DEC-15 data isolation in force.
Implementation started 2026-10-08. Status: Milestones 1–5 COMPLETE and verified on target; Milestones 6–8 open.

## Done and verified on target
- **M1 real login**: bootstrap, bcrypt auth, httpOnly SameSite=Strict sessions, forced first-login password change, LAN access on 0.0.0.0:18091 behind explicit opt-in + fail-closed source-IP allowlist, browser acceptance.
- **M2 file/folder slice**: folders CRUD + recursive delete/restore; streaming upload → content-addressed blob → v1 in one transaction; keyset pagination; preview with byte-fidelity metadata; authoritative download; save with baseSeq CAS; append-only rollback (DEC-13) with idempotent replay; versions; trash (list/restore/purge); grants CRUD; audit everywhere.
- **M3 organization + permissions**: users (create with issued credential, disable/enable with immediate session kill, admin password reset with forced re-change), departments, workgroups + membership; nine-action ACL server-side with query-layer filtering; cross-user isolation and admin separation verified.
- **M4 approvals + locks**: admin approval policies per folder; pending approvals (202) under policy; approve commits a new immutable version attributed to the requester; reject/cancel publish nothing; single-winner concurrency; edit locks (file-level lease, 30 min server TTL, generation guard, auto-release on save, expired-lock takeover, stale tokens cannot free newer locks).
- **M5 DOCX editing + CAD**:
  - ONLYOFFICE Document Server 8.2.2 (open-source AGPL community edition, zero licence cost) self-hosted in Docker on 18080 with JWT enabled; real DOCX editing verified end-to-end: open session → edit in the real editor → save callback → new immutable version whose bytes are a valid DOCX containing the edit; idempotent save-event ledger; edit-lock and approval interplay retained.
  - CAD pipeline: STL/OBJ/GLB render natively in the browser (three.js); STEP/IGES are converted by an isolated worker process (gmsh + OpenCASCADE 7.8) into mesh derivatives with subprocess timeout, concurrency cap and memory limits; real geometry verified (544 triangles from a STEP source).
  - Format matrix published by the API and UI, distinguishing native / server-converted / licence-required (DWG: needs a commercial ODA SDK — recorded as a blocker) / unverified.

## In progress
- Milestone 6: sharing, favorites, search, stats/CSV and the remaining peripheral business features.

## Not done / blockers
- Official Logo binary not yet provided; UI shows explicit "待入库" placeholder (DEC-14: no self-drawn substitute).
- DWG preview requires a commercial SDK (BLK-03); LibreDwg is not packaged for this Debian release and was not installed.
- Sharing, favorites, full-text search, stats/CSV: not built (approval-policy folders already reject direct writes).
- Performance suite (100k files / 400k versions, p95/p99), S1–S22 matrix, backup/restore drill, systemd deployment: not executed. Production 8091 cutover NOT authorized.
- Disabled dev accounts (clerkA/clerkB/editor) retained for audit continuity; no grants, sessions or locks.

## Access (development, LAN-only)
- URL: http://192.168.1.22:18091 (account `admin`; credential at `/root/repository77/filesmanage-v21/.secrets/admin.password`, mode 0600, root-only).
- Processes: `.bin/server` (API) and `.bin/worker` (CAD conversions) run under the workspace; ONLYOFFICE container `filesmanage-office` on 18080.
- Migrations 0001–0009 applied; checksums re-verified by `migrate -check`.
