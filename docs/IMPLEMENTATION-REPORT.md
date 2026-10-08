# Implementation report — Milestone 1: real login

Date: 2026-10-08. Host: 192.168.1.22 (openclaw77, Debian 13, Go 1.26.4, PostgreSQL 17.9).
Workspace: /root/repository77/filesmanage-v21. Commit: see "Git" below.

## What was done
1. State audit: existing v2.1 workspace contained Go layered scaffold (domain/ports/application/adapters/httpx), 3 SQL migrations, React shell; `filesmanage_v21` database existed with all 3 migrations applied but zero business rows (no admin user). Legacy Node/SQLite project and port 8091 untouched.
2. Migration verification: `go run ./cmd/migrate -check` → `CHECK 0001_core.sql`, `CHECK 0002_version_invariants.sql`, `CHECK 0003_acl_and_hierarchy.sql`, `MIGRATIONS_OK 3` (recorded SHA-256 checksums match files; re-runs never re-apply).
3. Secure bootstrap: initial admin credential regenerated with `openssl rand -base64 48` (64 chars), written to `.secrets/bootstrap.password` (umask 077 → 0600); `go run ./cmd/bootstrap` with `FILESMANAGE_ALLOW_BOOTSTRAP=new-empty-database` → `BOOTSTRAP_OK users=6 departments=2 groups=1 folders=8 legacy_data_imported=0`. Bootstrap holds a transaction advisory lock and refuses to run when `users` is non-empty.
4. LAN access support (user-requested): `cmd/server/main.go` accepts non-loopback binding only with explicit `FILESMANAGE_ALLOW_LAN_HTTP=true`; `internal/httpx` gained a fail-closed source-IP allowlist middleware (`FILESMANAGE_LAN_ALLOW_CIDRS`, default `127.0.0.1/32,::1/128,192.168.1.0/24`, runtime config `127.0.0.1/32,::1/128,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12`). Allowlist reads the kernel socket peer (RemoteAddr), never forwarded headers; a malformed/empty allowlist panics at startup instead of opening the service.
5. Build & start: `go build -o .bin/server ./cmd/server`; `npm run build` (tsc --noEmit + vite build) both PASS; service started via setsid on `0.0.0.0:18091` (process verified alive, socket `*:18091`).
6. Acceptance matrix executed (14 checks, all PASS) — see TEST-EVIDENCE.md.
7. Browser acceptance (headless Chromium): login page → login → `/doc` with real folder tree (7 visible nodes under root incl. 市场部/研发部 branches) → reload keeps session → logout returns to `/login`, `/api/me` → 401, deep link `/doc` redirects to `/login`.
8. FirstSignIn E2E with a temporary account (`u_e2e_probe`, user-level `list` grant on `folder_market`): login redirected to `/first-sign-in`; folder API answered 403 before the change; completing the form landed on `/doc` showing exactly the granted subtree; account and ACL deleted afterwards (verified back to 6 users / 2 ACLs).
9. Defect fixed during E2E: FolderTree rendered only from `parentId===null`, so any user whose grant starts below the invisible root saw an empty tree. Now folders whose parent is outside the visible set render as top level; Documents anchors the breadcrumb to the first visible root when the requested/default folder is not visible.

## Files changed (main)
- `cmd/server/main.go` (loopback guard + LAN opt-in), `internal/httpx/router.go` (allowlist middleware), `internal/httpx/router_test.go` (new), `cmd/server/main_test.go` (new)
- `web/src/features/folders/FolderTree.tsx`, `web/src/pages/Documents.tsx`
- `docs/*` status/report/evidence/blockers/gates (this set)

## Git
Commit after Milestone 1 verification (single commit for the M1 slice, secrets excluded via .gitignore).

## Evidence
- Service: PID + `ss -ltnp` show `*:18091`; `GET /health/ready` → 200 `{"ok":true}` from loopback, LAN client and direct (no-proxy) path.
- DB rows: admin `must_change_password=false` after change, `$2a$10$` bcrypt prefix; sessions revoked on logout; 8 folders; 2 ACLs; audit `bootstrap/new-install/success`.
- Negative network check: probe instance with allowlist `203.0.113.0/24` rejected loopback with 403 `E_NETWORK`, proving source-IP enforcement.

## Known issues / next
- Seeded staff accounts have unusable passwords by design; user management (credential issue, disable) is Milestone 3.
- Milestone 2 (file/folder vertical slice with real blobs) starts next.
