# filesmanage v2.1 — implementation status

Target host: 192.168.1.22 (Debian 13 / Linux), workspace /root/repository77/filesmanage-v21.
Legacy Node/SQLite system and port 8091 remain untouched; DEC-15 data isolation in force.
Implementation started 2026-10-08. Status: Milestones 1–3 COMPLETE and verified on target; Milestones 4–8 open.

## Done and verified on target
- **M1 real login**: admin bootstrap on `filesmanage_v21`, bcrypt auth, httpOnly SameSite=Strict sessions, forced first-login password change, DB-level logout revocation, LAN access on 0.0.0.0:18091 behind explicit opt-in + fail-closed source-IP allowlist, browser acceptance.
- **M2 file/folder slice**: folders (create/rename/move/recursive-delete/restore), streaming upload → content-addressed blob → v1 in one transaction, keyset pagination, preview with byte-fidelity metadata, authoritative download, save with baseSeq CAS, append-only rollback (DEC-13) with idempotent replay, versions, soft delete, trash (list/restore/purge), grants CRUD, audit everywhere.
- **M3 organization + ACL closure**:
  - Users: admin create (issued password forces change), list, disable/enable (sessions killed immediately), password reset (sessions killed + forced change again).
  - Departments: list/create. Workgroups: list/create/members add/remove; group grants take effect on the very next request (no caching), removal revokes immediately.
  - Nine-action ACL enforced server-side in the query layer (recursive ancestry + scope_only + expiry + user/group union); every file/folder operation re-authorizes per request.
  - Admin capability separation verified: non-admins get 403 on user/group/grant endpoints and on every ungranted file action.
  - Cross-user isolation verified end-to-end: without a grant a user sees an empty tree, gets 403 on folder lists, and every indirect attempt on another user's file (preview/download/delete/save/rollback/rename/versions) is rejected.
  - Frontend: OrganizationPanel (users/departments/workgroups/members, reset, disable) at /org, folder grant dialog with subject picker and per-action checkboxes.
- Migrations 0001–0005 applied; checksums re-verified by `migrate -check`.
- Tests: `go test ./...` (auth, folder/file use cases, DEC-13, pagination, byte fidelity, ACL rules, organization admin boundary, group-grant immediacy, allowlist), `go vet`, `check_architecture.py` (39 Go files, 28 TS modules), `tsc --noEmit` + `vite build` all PASS.

## In progress
- Milestone 4: approval workflow, edit locks, conflict detection, approval-aware rollback.

## Not done / blockers
- Official Logo binary not yet provided; UI shows explicit "待入库" placeholder (DEC-14).
- DOCX editing (M5) blocked on ONLYOFFICE self-hosting approval (BLK-02); DWG on commercial SDK decision (BLK-03); STEP/IGES converter toolchain approval (BLK-04).
- Sharing, favorites, full-text search, stats/CSV: not built. Writes on approval-policy folders are already blocked with E_APPROVAL_PENDING.
- Performance suite (100k files / 400k versions, p95/p99), S1–S22 matrix, backup/restore drill, systemd deployment: not executed. Production 8091 cutover NOT authorized.
- Two disabled dev test accounts (clerkA/clerkB) remain for audit continuity; they hold no grants and no sessions.

## Access (development, LAN-only)
- URL: http://192.168.1.22:18091 (account `admin`; credential at `/root/repository77/filesmanage-v21/.secrets/admin.password`, mode 0600, root-only).
- Staff demo accounts 1000001–1000005 exist with unusable passwords; admin issues credentials from the 组织管理 page.
