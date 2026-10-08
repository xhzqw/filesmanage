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

---

## Milestone 3 — organization and permission closure (verified end-to-end)

### What was built
- Organization use cases and stores: users (create with issued credential, list, disable/enable with immediate session kill, admin password reset with forced re-change), departments (list/create), workgroups (list/create, member add/remove). Every entry point is admin-only and audited; non-admin callers get 403.
- Grant management surfaced through the existing admin-only ACL endpoints plus a browser dialog (subject picker across users and groups, nine action checkboxes, scope_only, expiry).
- OrganizationPanel at /org with live user states, department name resolution, group membership management.

### Verification (executed, all PASS)
- Issued credentials force a change on first login (business reads 403 until changed); wrong old password 401; old password dead after change.
- Password reset kills every session of the account and forces a change again; disable kills sessions immediately and blocks login; enable restores access.
- Cross-user isolation: an ungranted user sees an empty tree, gets 403 on the granted folder, and every indirect attempt on another user's file (preview/download/delete/save/rollback/rename/versions) is rejected; restore of another user's trash entry is 404; admin-only endpoints 403 for non-admins.
- Group grants apply on the next request: member added → folder visible, list 200, ungranted action still 403; member removed → invisible again.
- Browser: /org renders real states and department names; grant dialog lists/creates/revokes grants.
- Fixes during the slice: `workgroups` has no `created_at` column (500 on list), empty department string hit the FK (500 on user create), and use cases mapped real query failures to 404 — now only missing rows map to 404.

---

## Milestone 4 — approvals, locks and version closure (verified end-to-end)

### What was built
- Approval policies (admin-only): one approver per folder with an enabled flag; while enabled, save and rollback create pending approvals (202 + approvalId) instead of versions, and the committed content stays authoritative for preview/download.
- Approval decisions: approve commits the pending payload as a new immutable version attributed to the requester; reject and cancel publish nothing; the state predicate on the UPDATE is the concurrency gate, so concurrent deciders produce exactly one winner and losers get a controlled 409 (conflicted requests are auto-marked).
- Edit locks: file-level single-writer lease (30 min server-side TTL, generation counter). Direct saves require the live token; a successful save releases the lock; expired leases are taken over (old token dies); stale tokens cannot release a newer holder's lock; own-lock re-acquire issues a fresh token so a stale tab cannot free the new lock. Admin-only paths are still role-checked.
- Migration 0006 adds the approval decision trail (reason, decision_comment, decided_at).
- Frontend: /approvals workbench (inbox + my requests, approve/reject/cancel), lock-aware plain-text editor (acquire on open, save with token, auto-release, approval submit under policy), admin approval-policy dialog. Feature modules stay FSD-clean: file endpoints in features/documents, approval endpoints in features/workflow, pages compose.

### Verification (executed, all PASS)
- Full matrix in TEST-EVIDENCE.md §M4: policy set/non-admin deny, 202 submission, no leak while pending, duplicate 409, approver-only 403, approve commits v2 with requester authorship, double-approve 409, reject keeps current version, rollback approval appends v3 with target=1.
- Lock lifecycle: acquire/status/foreign-holder 409/save-without-token 409/save-with-token 200/auto-release/stale-token 409; acquire under an approval folder is 409 E_APPROVAL_PENDING.
- Concurrency: 3 parallel approvals -> exactly one 200, file ends with exactly 2 versions.
- Browser: workbench, editor (v3 -> v4 with notice), policy dialog with active approvers.
- Unit tests cover lock lifecycle, takeover, submit/approve/reject, and the single-winner race.

---

## Milestone 5 — real DOCX editing and CAD preview (verified end-to-end)

### What was built
- Document editor integration (SPEC §19): ONLYOFFICE Document Server 8.2.2 (AGPL community edition, no licence cost) self-hosted in Docker with JWT; session open/close, short-lived signed source tokens, callback endpoint with SSRF-pinned downloads (only the configured editor host, no redirects, single resolved IP), OOXML structural validation, idempotent save-event ledger, version attribution to the requester, edit-lock and approval interplay.
- CAD pipeline (SPEC §20): separate worker process claiming `conversion_jobs` with concurrency cap, subprocess timeout and memory limit; gmsh + OpenCASCADE converts STEP/IGES to mesh derivatives; native STL/OBJ/GLB stream directly; three.js viewer with OrbitControls; honest format matrix (native / converted / licensed / unverified).
- Migrations 0007–0009 for office session state, approval decision trail and derivative columns.

### Verification (executed, all PASS)
- DOCX: real editor in the browser, edit + save → v2 with valid DOCX bytes containing the edit and the original text; save-event ledger exactly 1 committed; audit recorded.
- CAD: 108016-byte converted mesh with 544 triangles from a real STEP source; STL/OBJ derivative bytes byte-identical to source; DWG refused as licence-blocked; viewer canvas renders the geometry.

---

## Milestone 6 — collaboration (shares, favorites, search, stats, CSV)

### What was built
- Shares: create (file or folder, user or group, passive actions only, optional expiry and descendant inheritance), list received/sent, revoke. The recipient's visibility resolves through the shared scope CTE.
- Favorites: idempotent add/remove, per-user listing with unavailable flags for deleted resources.
- Search/stats/export: one shared visibility scope (READ-01) with folder scope (current/descendants/all), query, uploader, type and time filters; CSV with UTF-8 BOM, attachment disposition and formula-injection neutralisation.
- Web: /workspace (sharing + favorites tabs) and /stats (aggregates + CSV export) pages.

### Verification (executed, all PASS)
- Search returns the caller's visible files; stats aggregate totals, by type, by month and by uploader; CSV downloads with a BOM and 17 rows.
- Share create → list → revoke verified; favorites add → list → remove verified idempotent.

### Plain Text fidelity (SPEC §8)
- Preview metadata (encoding, BOM, EOL, trailing newline, truncation) is computed from raw bytes; rawBase64 carries the exact prefix so editors round-trip without normalisation. 12 byte samples verified plus a 300KB truncation case and a byte-exact save round-trip.

### Test data hygiene
- The redundant full-permission grant created during browser acceptance was revoked; the test workgroup was removed; clerkA/clerkB were disabled. Hard deletion of principals with audit history is blocked by foreign keys by design, so the audit chain stays intact.

### Known gaps (deliberate scope)
- Edit locks, approval workflow, sharing, favorites, full-text search, stats/CSV, DOCX/CAD: later milestones. Writes on approval-policy folders are already blocked with `E_APPROVAL_PENDING` so review can never be bypassed.
- Seeded staff accounts still have unusable passwords; user management ships in Milestone 3.
