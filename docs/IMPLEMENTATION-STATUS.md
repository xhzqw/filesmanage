# filesmanage v2.1 — implementation status

Target host: 192.168.1.22 (Debian 13 / Linux), workspace /root/repository77/filesmanage-v21.
Legacy Node/SQLite system and port 8091 remain untouched; DEC-15 data isolation in force (no old data imported, verified `legacy_data_imported=0`).
Implementation started 2026-10-08. Status: Milestone 1 COMPLETE (real login, LAN-accessible), Milestones 2–8 open.

## Done and verified on target (Milestone 1)
- Fresh PostgreSQL database `filesmanage_v21` (PG 17.9) with least-privilege role; migrations 0001/0002/0003 applied, checksums recorded in `schema_migrations`, re-run `-check` passes.
- Bootstrap executed: admin account `admin` created with strong random initial credential (64-char, stored target-local `0600`); 5 seeded staff accounts with unusable passwords, 2 departments, 1 workgroup, 8 real folders, 2 ACL rows. Bootstrap refuses non-empty `users` table.
- Real authentication stack: bcrypt password hashing (`$2a$10$`), 24h opaque session tokens stored only as SHA-256 hashes, httpOnly SameSite=Strict cookies, DB-level logout revocation, disabled-user and expiry checks.
- Forced initial password change: `/api/folders/tree` returns 403 `E_PASSWORD_CHANGE_REQUIRED` while `must_change_password` is set; `POST /api/me/password` enforces old-password verification, >=16-char policy, difference from old, and revokes other sessions.
- Browser-verified end-to-end (headless Chromium over LAN): login, forced first-sign-in flow, real folder tree, refresh persistence, logout invalidation, deep-link redirect.
- LAN access: server binds 0.0.0.0:18091 behind an explicit opt-in (`FILESMANAGE_ALLOW_LAN_HTTP=true`) plus a fail-closed source-IP allowlist (loopback + RFC1918 by config); non-loopback default remains blocked at startup.
- Go toolchain on target: build, `go test ./...`, `go vet ./...`, `scripts/check_architecture.py` all PASS. Web: `tsc --noEmit` + `vite build` PASS.
- Fixed defect found during E2E: granted folders whose parent is outside a user's visible set now render as tree top level (FolderTree promotion + Documents fallback selection).

## In progress
- Milestone 2: folder/file vertical slice (create → authorize → upload → list → preview → download → modify → new version → delete → trash → restore) with real blob storage.

## Not done / blockers
- Official Logo binary not yet provided by the customer; UI shows explicit "待入库" notice and must not be replaced by a self-drawn fake.
- File upload/download, versions, approvals, sharing, favorites, trash, full-text search, stats, CSV, DOCX online editing, CAD preview, worker isolation: not built.
- Performance suite (100k files / 400k versions, p95/p99), S1–S22/DO/MC/AG/PE acceptance matrix, backup/restore drill, systemd production deployment: not executed.
- Production 8091 cutover: NOT authorized; dev service stays on 18091.

## Access (development, LAN-only)
- URL: http://192.168.1.22:18091  (account `admin`; credential at `/root/repository77/filesmanage-v21/.secrets/admin.password`, mode 0600, root-only).
- Health: `GET /health/ready` → `{"ok":true}`.
