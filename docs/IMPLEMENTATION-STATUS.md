# filesmanage v2.1 — implementation status

Target host: 192.168.1.22 (Debian 13 / Linux), workspace /root/repository77/filesmanage-v21.
Legacy Node/SQLite system and port 8091 remain untouched; DEC-15 data isolation in force (no old data imported, verified `legacy_data_imported=0`).
Implementation started 2026-10-08. Status: Milestone 1 COMPLETE (real login, LAN-accessible), Milestone 2 COMPLETE (file/folder vertical slice, verified end-to-end), Milestones 3–8 open.

## Done and verified on target
- Fresh PostgreSQL database `filesmanage_v21` (PG 17.9); migrations 0001–0005 applied, checksums recorded, re-run `-check` passes.
- Milestone 1: real admin login (bcrypt, httpOnly SameSite=Strict sessions, forced first-login password change, DB-level logout revocation), LAN access on 0.0.0.0:18091 behind explicit opt-in + fail-closed source-IP allowlist, browser acceptance.
- Milestone 2: folder create/rename/move/recursive-delete/restore; multipart streaming upload → content-addressed blob staging → file + v1 in one transaction; keyset-paginated list (5 sorts); preview with byte-fidelity metadata; authoritative byte download; save with baseSeq CAS; append-only rollback (DEC-13) with idempotent replay; versions history; soft delete; trash list/restore/purge(admin); grant create/list/revoke (admin); audit on every mutation.
- Architecture: UnitOfWork + transaction-owned writes; blob bytes staged outside transactions; Go/React layering enforced by `scripts/check_architecture.py` (31 Go files, 24 TS modules) and by tests.
- Tests: `go test ./...` (use cases, DEC-13, pagination, byte fidelity, ACL rules, allowlist), `go vet`, `npm run build` (tsc + vite) all PASS.

## In progress
- Milestone 3: user/department/workgroup management UI + full ACL verification matrix (cross-user isolation, indirect escalation, cross-folder operations).

## Not done / blockers
- Official Logo binary not yet provided by the customer; UI shows explicit "待入库" placeholder (DEC-14: no self-drawn substitute).
- DOCX online editing (Milestone 5) blocked on ONLYOFFICE self-hosting approval (BLK-02); DWG blocked on commercial SDK decision (BLK-03); STEP/IGES converter toolchain install approval (BLK-04).
- Edit locks, approval workflow, sharing, favorites, full-text search, stats/CSV: not built (approval-policy folders already reject writes with E_APPROVAL_PENDING).
- Performance suite (100k files / 400k versions, p95/p99), S1–S22 acceptance matrix, backup/restore drill, systemd deployment: not executed.
- Production 8091 cutover: NOT authorized; dev service stays on 18091.

## Access (development, LAN-only)
- URL: http://192.168.1.22:18091 (account `admin`; credential at `/root/repository77/filesmanage-v21/.secrets/admin.password`, mode 0600, root-only).
- Health: `GET /health/ready` → `{"ok":true}`.
