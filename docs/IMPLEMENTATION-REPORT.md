# Implementation report

Date: 2026-10-08 (Milestones 1 and 2). Host: 192.168.1.22. Workspace: /root/repository77/filesmanage-v21.

---

## Milestone 1 — real login (GO for development)

Report: admin bootstrap on `filesmanage_v21`, real bcrypt auth, httpOnly SameSite=Strict session cookies, forced first-login password change, LAN-bounded dev service on 0.0.0.0:18091, browser acceptance over http://192.168.1.22:18091. Full acceptance matrix (14 checks), FirstSignIn E2E with a disposable account, negative network control. Evidence in TEST-EVIDENCE.md §M1; commit `6266512`.

Defect found and fixed during M1: FolderTree rendered only from `parentId===null`, so a user whose grant starts below an invisible root saw an empty tree. Granted folders whose parent is outside the visible set now render as top level.

---

## Milestone 2 — file/folder vertical slice (verified end-to-end)

### What was built
- Unit-of-work architecture: `ports.UnitOfWork/Tx`; every write use case runs in one transaction (TX-01). Reads use the same contract through a tx handle; blob bytes stage outside transactions and are only referenced inside them (TX-02).
- Blob adapter (`internal/adapter/blob`): content-addressed store (`.blobs/ready/<2hex>/<sha256>`), random staging names, atomic rename publish, digest re-computed from disk, dedup of identical content, traversal-proof key validation.
- Folders: create (upload on parent), rename, move (cycle guard trigger), recursive soft delete collapsing into exactly one top-level trash entry, restore of whole subtree.
- Files: multipart streaming upload (1 GiB cap), upload → blob → file + v1 in one transaction, name-conflict rejection, idempotency-key replay; keyset-paginated list (5 sorts, cursor includes sort key + id, limit clamp 1–200); preview with byte-fidelity metadata (encoding/BOM/EOL/trailing newline, 256 KiB truncation flag); authoritative byte download (SHA-256 header); save with baseSeq CAS; append-only rollback (DEC-13); soft delete; versions history; rename.
- Trash: list (own entries + restorable entries via upload grant on the original parent chain), restore with optional destination/new name (E_PARENT_MISSING / E_NAME_CONFLICT), purge (admin only, marks GC).
- Grants: list/create/revoke, admin-only, subject existence + action whitelist validated, audit on every mutation. Audit events cover upload/save/rollback/delete/restore/purge/folder and ACL operations with request ids.
- Migrations 0004 (files.content_type, folders.created_by) and 0005 (trash purged_at/purge_after) applied; checksums re-verified by `migrate -check`.
- Frontend: FSD-compliant Documents page (FolderTree + NewFolderForm + FolderActions + FileTable), Preview page (content, byte meta, version table, raw-byte download), Trash page (list + restore), shared error-code mapping, shared idempotency-key generator that works on non-secure-context LAN http.

### Verification (executed, all PASS)
- Go: `go build ./...`, `go vet ./...`, `go test ./...` (application use cases incl. DEC-13 append-only rollback, idempotent replay, permission matrix; domain ACL rules; cursor pagination; byte-fidelity analysis; httpx allowlist tests; cmd/server tests) — PASS.
- `scripts/check_architecture.py` — PASS (31 Go files, 24 TS modules, negative self-tests).
- Web: `tsc --noEmit` + `vite build` — PASS.
- API E2E over loopback: create folder → upload (checksum match on download bytes) → preview (meta correct) → save v2 (CAS) → rollback to v1 producing v4 with SHA(v4)=SHA(v1) and v1/v2/v3 intact → idempotent replay of the same rollback key returned the same seq (no duplicate version) → delete → trash → restore → folder subtree delete/restore → grant create/list/revoke. Error paths: 401 unauthenticated, 404 unknown file, 409 stale baseSeq, 400 over-limit, 403 ungranted action.
- Browser E2E over LAN (headless Chromium): login → create folder via form → enter folder → upload via hidden input (row + notice) → preview page with byte fidelity (mixed EOL correctly reported) → delete with confirm → trash page → restore.
- DB assertions after E2E: users=6, folders=15, files=3, versions=6, blobs=3 (all ready, content-addressed on disk), trash=3 all restored, audit_events=22 across 10 event types, idempotency_keys=6, staging directory empty (no orphaned staging files).

### Defects found and fixed during M2
1. File list first page returned empty: an absent cursor was passed as a keyset filter. Cursor is now omitted entirely when empty (regression covered by `TestListFilesAppliesPaginationLimit`).
2. `GET /api/trash` returned 500 because `trash_entries.purged_at` was referenced but not in the schema; migration 0005 adds `purged_at` and the reserved `purge_after`.
3. Trash payloads reported a zero `deleted_at` because the insert result was not reflected back; the use case now stamps the entry with the service clock.
4. Browser upload failed on LAN http because `crypto.randomUUID` requires a secure context; a shared fallback key generator is used.

### Known gaps (deliberate scope)
- Edit locks, approval workflow, sharing, favorites, full-text search, stats/CSV, DOCX/CAD: later milestones. Writes on approval-policy folders are already blocked with `E_APPROVAL_PENDING` so review can never be bypassed.
- Seeded staff accounts still have unusable passwords; user management ships in Milestone 3.
