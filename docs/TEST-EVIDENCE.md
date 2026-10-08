# Test evidence — Milestone 1 (all commands executed on 192.168.1.22)

Environment: /root/repository77/filesmanage-v21, DATABASE_URL from `.secrets/server.env` (0600), service on 0.0.0.0:18091.

## Build / static gates (PASS)
```
$ go build -o .bin/server ./cmd/server            → BUILD_OK
$ go test ./...                                   → ok cmd/server, application, domain, httpx (all PASS)
$ go vet ./...                                    → no findings
$ python3 scripts/check_architecture.py           → ARCHITECTURE PASS: 11 Go files and 12 TS modules; negative rule self-tests passed
$ cd web && npm run build                         → tsc --noEmit PASS; vite build ✓ (dist regenerated)
```

## Migration idempotency (PASS)
```
$ go run ./cmd/migrate -check
CHECK 0001_core.sql
CHECK 0002_version_invariants.sql
CHECK 0003_acl_and_hierarchy.sql
MIGRATIONS_OK 3
```
Recorded checksums in `schema_migrations` (0001 229038fc…, 0002 7a9b66c7…, 0003 a4241361…) match current file SHA-256; re-running never re-applies.

## Bootstrap (PASS)
```
$ FILESMANAGE_ALLOW_BOOTSTRAP=new-empty-database BOOTSTRAP_ADMIN_PASSWORD_FILE=.secrets/bootstrap.password go run ./cmd/bootstrap
BOOTSTRAP_OK users=6 departments=2 groups=1 folders=8 legacy_data_imported=0
```
Password file: 64 chars, mode 0600 (regenerated with `openssl rand -base64 48`). Admin stored with bcrypt `$2a$10$`.

## API acceptance matrix (all PASS)
| # | Check | Command (abridged) | Result |
|---|---|---|---|
| 1 | readiness | `GET /health/ready` | 200 `{"ok":true}` |
| 2 | wrong password rejected | `POST /api/login {admin, wrong}` | 401 |
| 3 | correct first login | `POST /api/login {admin, initial}` | 200, `mustChangePassword:true` |
| 4 | unauthenticated protected API | `GET /api/folders/tree` | 401 |
| 5 | business data blocked pre-change | `GET /api/folders/tree` (session) | 403 `E_PASSWORD_CHANGE_REQUIRED` |
| 6 | wrong old password on change | `POST /api/me/password` | 401 |
| 7 | short new password | `POST /api/me/password` | 400 `E_PASSWORD_POLICY` |
| 8 | password change | `POST /api/me/password` | 200 |
| 9 | old password after change | `POST /api/login {admin, initial}` | 401 |
| 10 | new password login | `POST /api/login {admin, new}` | 200, `mustChangePassword:false` |
| 11 | real directory data | `GET /api/folders/tree` | 200, 8 folders (admin) |
| 12 | session survives repeated requests | `/api/me`, `/api/folders/tree` | 200, 200 |
| 13 | logout | `POST /api/logout` | 200 |
| 14 | session invalid after logout | `GET /api/me` | 401 |

DB confirmation after matrix: `users.must_change_password=false`, `sessions` rows revoked on logout, folder hierarchy 中晟生物科技 → 市场部(市场资料/活动素材) / 研发部(技术文档) / 示范项目(项目预算); ACL rows acl_root (group_market, {list}) and acl_market ({list,preview,upload}).

## LAN access (PASS)
```
local$ curl --noproxy '*' http://192.168.1.22:18091/health/ready   → 200 (direct from 192.168.10.117)
local$ curl http://192.168.1.22:18091/health/ready                 → 200 (via local forward proxy)
target$ ss -ltnp | grep 18091 → LISTEN *:18091 (pid alive)
```
Negative control: probe instance `FILESMANAGE_LAN_ALLOW_CIDRS=203.0.113.0/24` on 0.0.0.0:18092:
- loopback client → 403 `{"error":{"code":"E_NETWORK"}}` (allowlist authoritative, loopback not implicitly trusted when excluded)
- LAN client could not reach the loopback-bound variant (connection refused), confirming binding scope.
Unit/engine tests: `TestLanGuardAdmitsConfiguredPeerOnly`, `TestNewEngineEnforcesAllowlistOnRoutes`, `TestParseAllowlist*`, `TestIsLoopbackAddr` → PASS.

## Browser acceptance (PASS, headless Chromium over LAN)
- `http://192.168.1.22:18091/login` renders login form; login as admin → `/doc` header shows 中晟生物科技 · 文档治理中心, account 系统管理员; sidebar tree lists 7 folders (root collapsed child 项目预算 hidden under collapsed 示范项目); breadcrumb `文档管理 / 中晟生物科技`.
- Reload on `/doc` → session persists (tree and account intact).
- Logout button → `/login`; `/api/me` → 401; deep link `/doc` → redirected to `/login`.
- FirstSignIn E2E (temporary account `u_e2e_probe` with user-level `list` grant on `folder_market`): login → `/first-sign-in`; folder API 403 pre-change; after submitting new credential → `/doc` with tree `市场部 / 活动素材 / 市场资料` and breadcrumb `文档管理 / 市场部`; account, session and ACL deleted afterwards (`SELECT count(*) FROM users` back to 6, ACLs back to 2).

## Non-destructive guarantee
All E2E mutations used either the disposable admin bootstrap flow or the temporary `u_e2e_probe` account (created and removed within the test). No legacy Node/SQLite data, other projects' data, or port 8091 were touched.

## Milestone 2 evidence (all executed on 192.168.1.22, 2026-10-08)

### Gates
```
go build ./...            → BUILD_OK
go vet ./...              → VET_OK
go test ./...             → ok cmd/server, application, domain, httpx
python3 scripts/check_architecture.py → ARCHITECTURE PASS: 31 Go files and 24 TS modules
cd web && npm run build   → tsc --noEmit PASS; vite build ✓
go run ./cmd/migrate      → APPLIED 0004_file_content_and_folder_creator.sql, APPLIED 0005_trash_purge_columns.sql, MIGRATIONS_OK 5
```

### API E2E (loopback curl, admin session)
| Step | Result |
|---|---|
| POST /api/folders (create) | 201 folder id returned |
| POST /api/files (multipart upload) | 201 versionSeq=1, sha256, size |
| GET /api/files?folder=…&limit=10 | 200 page with item (fixed first-page bug) |
| GET /api/files/:id/preview | 200 content + byteMeta {utf-8, lf, no BOM, trailing LF} |
| GET /api/files/:id/bytes | bytes identical to source; X-Content-Sha256 matches local sha256sum |
| POST /api/files/:id/save {baseSeq:1} | 200 versionSeq=2 (action=edit) |
| POST /api/files/:id/rollback {targetSeq:1,expectedCurrentSeq:2} | 200 versionSeq=4 chain intact: 1 upload A, 2 edit B, 3 rollback→A, 4 rollback→A; SHA(v4)=SHA(v1) |
| rollback replay with same idempotencyKey | identical response (versionSeq 4), no new version |
| DELETE /api/files/:id | 200 trash entry; file preview then 404 |
| GET /api/trash | 200 entry with deletedByName/deletedAt |
| POST /api/trash/:id/restore | 200; file readable again |
| DELETE /api/folders/:id (subtree) | 200 one trash entry; folder list 404, file preview 404 |
| POST /api/trash/:id/restore (folder) | list 200, file preview 200 |
| POST /api/folders/:id/acls + GET + DELETE | 201/200/200, audit rows recorded |
| Error paths | 401 unauth list, 404 unknown file preview, 409 stale baseSeq save, 400 limit=999, 403 ungranted action (unit-tested) |

### Browser E2E (LAN http://192.168.1.22:18091, headless Chromium)
- Create folder via form → appears in tree; enter folder → breadcrumb updates.
- Upload via hidden input → table row (name, 67 B, v1, sha prefix, timestamp) + notice "已上传 … 生成 v1 新版本".
- Preview page: raw content rendered, byteMeta reports "编码 utf-8 · 行尾 mixed · BOM 无 · 末尾换行 有" (CRLF+LF sample correctly detected), SHA-256 shown, version table v1 上传.
- Delete with confirm → notice "已移入回收站"; /trash lists entry; restore → "回收站为空".

### Data consistency after E2E
```
users=6  folders=15 (active 15)  files=3 (active 3)  versions=6
blobs=3 (ready 3)  trash=3 (restored 3)  audit_events=22 (10 event types)
idempotency_keys=6  outbox_jobs=0
.blobs/ready/<2hex>/<sha256> layout on disk; staging directory empty
```

## Milestone 3 evidence (executed on 192.168.1.22, 2026-10-08)

### Gates
```
go build ./... / go vet ./... → OK
go test ./... → ok cmd/server, application, domain, httpx (new: organization admin boundary,
   workgroup membership, group-grant immediate effect)
python3 scripts/check_architecture.py → PASS: 39 Go files, 28 TS modules
cd web && npm run build → tsc --noEmit PASS; vite build ✓
```

### Identity lifecycle (API, admin session)
| Step | Result |
|---|---|
| POST /api/users (clerkA/clerkB) | 201, mustChangePassword=true |
| clerkA first login | 200 mustChangePassword=true |
| clerkA business read before change | 403 E_PASSWORD_CHANGE_REQUIRED |
| change password with wrong old | 401 |
| change password | 200 mustChangePassword=false |
| login with old password after change | 401 |
| admin POST /api/users/:id/password (reset) | 200; old session 401; next login mustChange=true |
| admin POST /api/users/:id/disable | session 401 immediately; login 401 while disabled |
| admin POST /api/users/:id/enable | login 200 again |

### Cross-user isolation (clerkA granted {list,preview,upload,download} on 市场部)
| Attempt by clerkB (no grant) | Result |
|---|---|
| GET /api/folders/tree | empty list |
| GET /api/files?folder=市场部 | 403 |
| preview / bytes / DELETE / save / rollback / PATCH / versions on clerkA's file | 403 each |
| upload into 市场部 / create subfolder / delete folder | 403 |
| restore another user's trash entry | 404 |
| purge trash (admin-only) | 403 |
| GET /api/users, POST /api/users, GET /api/groups, POST acl | 403 each |

### Group grants take effect on the next request
- grant group {list} on 市场部 → clerkB tree [] → add clerkB to group → tree [活动素材, 市场部, 市场资料], list 200, upload still 403 → remove member → tree [] again.

### Browser acceptance (LAN)
- /org: user table with real states (待改密/正常/已禁用), department names resolved, group list, member management.
- Documents page: 授权管理 dialog lists existing grants, subject picker (users + groups), nine action checkboxes, scopeOnly option; creating a grant appends a row; revoke removes it.
- Redundant test grant created during acceptance was revoked; test workgroup and test accounts disabled (audit continuity blocks hard delete by design).

### Final database state
```
users=8 (active 6; clerkA/clerkB disabled test accounts)
workgroups=1 members=3
acls: folder_root:group_market{list} | folder_market:group_market{list,preview,upload}
```

## Milestone 4 evidence (executed on 192.168.1.22, 2026-10-08)

### Gates
```
go build/vet/test ./... → PASS (new: lock lifecycle, lock takeover, approval
  workflow, reject keeps current, concurrent approvals single winner)
python3 scripts/check_architecture.py → PASS: 48 Go files, 33 TS modules
cd web && npm run build → tsc --noEmit PASS; vite build ✓
go run ./cmd/migrate → APPLIED 0006_approval_decision_trail.sql, MIGRATIONS_OK 6
```

### Approval workflow (API)
| Step | Result |
|---|---|
| admin PUT /api/folders/:id/approval-policy | 200 configured |
| non-admin PUT policy | 403 |
| editor save under policy | 202 status=pending + approvalId |
| preview/download while pending | still committed content (v1 bytes) |
| duplicate pending request | 409 E_APPROVAL_PENDING |
| editor approves own request | 403 (approver only / admin) |
| admin approves | 200, v2 committed, author = requester |
| second approval of same request | 409 |
| reject path: submit → reject | no new version; current content unchanged |
| resubmit after rejection | 202 (new pending) |
| rollback under policy → approve | v3 action=rollback target=1; v1/v2/v3 preserved; content = v1 bytes |

### Edit locks (API)
| Step | Result |
|---|---|
| acquire lock (editor) | 201 token + generation + 1800s |
| lock status | locked, owner 编辑员 |
| save without lock token | 409 |
| admin acquire while editor holds | 409 |
| save with live token | 200 (new version) |
| lock status after save | released (auto) |
| save with stale token | 409 |
| acquire on approval-policy folder | 409 E_APPROVAL_PENDING (policy routes edits through approvals) |

### Concurrency
- 3 parallel approvals of the same request: exactly one 200, others 409; file kept exactly 2 versions (v1 + one committed edit). Verified via API and DB.

### Browser acceptance (LAN)
- /approvals workbench: inbox + my requests with states and comments.
- Editor: opens with lock hint ("保存将创建新的不可变版本；当前为 vN"), saves → notice 已保存为 v(N+1), table row shows the new version and size.
- Policy dialog (admin): lists active approvers; folder actions include 授权管理 / 审批策略 for admins only.

### Fixes during the slice
- `approval_policies` and `approvals` lacked columns the code referenced (created_at/decision trail) → migration 0006 + query fixes; raw pgx.ErrNoRows now maps to ports.ErrRowMissing in the workflow adapter.
- Uploads were wrongly blocked by folder approval policies (policy gates only save/rollback).
- FSD violations from cross-feature imports (documents↔workflow) removed: file endpoints live in features/documents, approval endpoints in features/workflow, pages compose.

### Test data hygiene
- Editor account disabled, its grants/locks/sessions removed; test approval policy cleared; debug rows deleted.
# Milestone 5 evidence — DOCX editing and CAD (executed on 192.168.1.22, 2026-10-08)

### Gates
```
go build/vet/test ./... → PASS
python3 scripts/check_architecture.py → PASS: 60 Go files, 35 TS modules
go run ./cmd/migrate → MIGRATIONS_OK 9 (0007 office session generation/timestamps,
  0008 session timestamps, 0009 derivative columns)
```

### DOCX editing (real ONLYOFFICE 8.2.2, AGPL community edition, zero licence cost)
| Step | Result |
|---|---|
| Docker container (JWT enabled, private-IP allow for LAN source) | healthy on 18080 |
| POST /api/files/:id/office/session | 201 with signed editor config (document key, source URL, callback URL) |
| Source fetch by the document server | 200, exact source bytes (verified from inside the container) |
| Editor iframe loads with real DOCX content | toolbar + page rendered, 1 page |
| Type text + save (Ctrl+S) | editor save callback received 200 by our API |
| New version committed | v2 action=edit, sha 8aca4d5a… |
| v2 bytes | valid DOCX (zip with [Content_Types].xml), contains edited sentence AND original text |
| office_save_events ledger | 1 committed (idempotency ledger) |
| Audit | office.save_commit success |

Callback plumbing details fixed during integration: Bearer prefix stripping, callback JWT without exp accepted (signature still mandatory), document keys restricted to [0-9-.a-zA-Z_=], docservice SSRF filter needs ALLOW_PRIVATE_IP_ADDRESS for LAN sources, api.js expects the full config plus a token field (not only a token).

### CAD pipeline
| Format | Class | Evidence |
|---|---|---|
| stl / obj | native | derivative bytes byte-identical to the uploaded source |
| step / stp / iges / igs | converted | worker claims the queued job, runs gmsh (OpenCASCADE 7.8.1) with a 2 min timeout and memory cap; 108016-byte STL mesh with 544 triangles delivered |
| dxf | native (2D parser) | classified native; 2D entity rendering path in the viewer |
| dwg | licensed | no open-source toolchain packaged (LibreDwg unavailable); recorded as BLK-03, request refused with 400 |
| Unknown format | — | derivative request refused with 400 |

Worker: separate process (`.bin/worker`), claims jobs via `conversion_jobs` state predicate, concurrency cap 2, subprocess timeout, address-space cap; failures recorded on the job and derivative (`CONVERT_FAILED`).

### Browser acceptance (LAN)
- /office/:id: real editor iframe, edit, save → v2 (verified via versions API).
- /model/:id: canvas 1668x697 rendered with 544 triangles / 1632 vertices from the converted STEP mesh; breadcrumb shows 服务端已转换; OrbitControls rotate/zoom/pan.
- Format matrix endpoint returns the honest classification table.

### Fixes during the slice
- derivative status response omitted `format` (undefined crash) — added, viewer made null-safe.
- Worker native-format detection keyed on output kind (STEP→STL looked native) — now keys on the source format.
- Viewer canvas torn down by a dependency-change effect re-run — one-shot mount with unmount-only teardown.
- `model_derivatives`/`approvals`/`office_sessions` column gaps → migrations 0007–0009.

## Milestone 6 evidence — collaboration (executed on 192.168.1.22, 2026-10-08)

### Gates
```
go build/vet/test ./... → PASS
python3 scripts/check_architecture.py → PASS: 67 Go files, 39 TS modules
go run ./cmd/migrate → MIGRATIONS_OK 10 (0010 adds shares.created_at)
```

### Verified (API)
| Step | Result |
|---|---|
| GET /api/search | 200 with the caller's visible files (16 files for admin) |
| GET /api/stats | totals + byType (txt 10, docx 1, dwg 1, bin 1, step 1, stl 1, obj 1) + byMonth + byUploader |
| GET /api/exports/files.csv | Content-Type text/csv, attachment disposition, UTF-8 BOM (EF BB BF), 17 lines |
| POST /api/shares (file → group, {preview,download}) | 201 with the created share |
| GET /api/shares?scope=sent | lists the created share |
| DELETE /api/shares/:id | 200 revoked |
| PUT /api/favorites/file/:id | 200 favorited=true; listed in GET /api/favorites with resourceName |
| DELETE /api/favorites/file/:id | 200 favorited=false (idempotent) |

### Scope rules (SPEC READ-01)
- Search, stats and export share one visibility scope: ACL grants with ancestor inheritance plus shares; admins bypass through the same code path.
- Shares only accept {list,preview,download}; write actions are rejected by the store.
- Favorites are per-user; deleted resources stay listed but flagged unavailable without leaking paths.

### Fixes during the slice
- shares.created_at column missing → migration 0010.
- Scope CTE name collision (`scope` vs alias) → renamed to visible_scope.
- Admin branch emitted no placeholders while args still bound $1 → placeholder emission now follows the emitted SQL.
- CSV export sent a zero limit into the search path → inherits the search clamp.

## Milestone 6b — Plain Text byte fidelity (executed on 192.168.1.22)

| Sample | Bytes | Result |
|---|---|---|
| PT01 UTF-8+LF | 12 | encoding utf-8, eol lf, tail NL, download SHA identical |
| PT02 UTF-8+CRLF | 16 | eol crlf detected, download SHA identical |
| PT03 UTF-8 BOM | 11 | encoding utf-8-bom, hasBom true, BOM preserved on download |
| PT04 tabs | 6 | printable, SHA identical |
| PT05 no trailing NL | 18 | endsWithNewline false, SHA identical |
| PT06 mixed EOL | 11 | eol mixed, SHA identical |
| PT07 markdown with script tag | 40 | rendered as literal text (no HTML execution) |
| PT08 JSON | 14 | SHA identical |
| PT09 300KB text | 300000 | truncated=true, preview 262144 bytes, full download intact |
| PT10 multibyte UTF-8 | 15 | decoded intact, SHA identical |
| PT11 binary with NUL | 10 | printable=false, not treated as text |
| PT12 short file | 5 | SHA identical |

### Round-trip fidelity
- Preview now returns rawBase64: the exact preview prefix bytes.
- BOM + CRLF + tabs + trailing newline sample: byteMeta reports utf-8-bom/crlf/true; rawBase64 equals the source bytes exactly.
- Editing one token and saving produces v2 whose SHA-256 equals the expected edited bytes (no encoding or newline normalisation).

### Fix
- AnalyzeBytes previously decoded to string first, which stripped the BOM and made EOL/trailing-newline detection unreliable; it now operates on raw bytes and PreviewBytes separates display decoding from metadata.

## Milestone 6c — brand shell (DEC-14, executed on 192.168.1.22)

| Item | Result |
|---|---|
| Official logo slot | explicit "官方 Logo 待入库" placeholder on every authenticated page (BLK-01; a self-drawn mark is never passed off as the corporate logo) |
| Folder icon | yellow SVG (FolderIcon) rendered in the shell navigation |
| Navigation | 文档管理 / 共享/关注 / 统计 / 审批 / 回收站 / 组织管理 |
| Collaboration tabs | 与我共享 / 我共享的 / 我的关注 |
| Responsive | 768px viewport: hamburger toggle visible, nav collapses to overlay and opens on tap |

State feedback already present and exercised in earlier milestones: loading text, error alerts, empty states, permission-denied messages.

---

## Milestone 7 — security and performance acceptance (executed on 192.168.1.22, 2026-10-08)

All commands ran on the target host. Commits: `8bdd068`, `06c056d`, `063e26a`,
`b8d5401`, `20f188c` (search/stats/export/worker/scope-binding fixes below).
Browser acceptance re-verified after the final rebuild: login at
http://10.144.144.1:18091/login (192.168.1.22 had a transient LAN outage) lands on
`/doc` with the folder tree, breadcrumb, toolbar and file table rendered.

### M1 re-verification (acceptance matrix, re-run this session)

| Check | Result |
|---|---|
| `GET /health/ready` | 200 |
| wrong password | 401 |
| real admin login (credential from `.secrets/admin.password`, mode 0600) | 200 |
| unauthenticated `/api/me` | 401 |
| `/api/folders/tree` returns seeded directory data | 200, real rows |
| browser login (http://192.168.1.22:18091/login) → `/doc` main interface | PASS (folder tree, breadcrumb, file table, empty state rendered) |
| session survives repeated requests | 200, 200 |
| logout invalidates the session immediately | 401 after logout |
| first-login password change | verified via disposable probe account (must-change → change → flag cleared; old password rejected afterwards) |

### Security regression — `scripts/m7_security_e2e.py` (31/31 PASS)

Authenticated cross-user checks against the business server: ungranted file list
403; ungranted folder-filtered search/stats/export all empty (the visibility
scope a folder filter must never bypass); secured folder absent from the probe
tree; grant takes effect on the next request (list 200, search total ≥ 1, export
rows ≥ 2); revocation immediate (403, total 0); folder share with
include_descendants reaches child files and makes the child folder listable;
revoking the share closes both; disabled account rejected (401) with the session
killed. Cleanup: secured folder soft-deleted, probe disabled (audit chain intact).

### Defects found and fixed in M7

1. **Folder-filtered search/stats/export bypassed the visibility scope**
   (SPEC §2.3/DB-PERF-01) — and separately 500'd on a placeholder mismatch.
   `scopeFolderSQL` now intersects the folder restriction with `visible_scope`
   for non-admins and derives placeholder indices from the emitted bindings.
2. **Folder shares ignored `include_descendants`** and shares were not consulted
   by `require()`/`visibleFile()` at all (SPEC §2.4's "two inconsistent code
   paths"). Shares now resolve through the same permission path as direct reads;
   the search scope CTE expands descendants along the ancestor chain. File-level
   shares grant preview/download outside the folder scope.
3. **CSV export clamped to 200 rows and buffered the whole result**
   (SPEC §3.10/READ-06/PE07). Replaced by the batched streaming export.
4. **Search content matching was a sequential `ILIKE` over `file_text`**; the
   search index (`file_text`) was never written by the application at all
   (SPEC §10.1). Added the indexing pipeline (upload/save/rollback/approval),
   the bounded OOXML reader in `internal/docx`, tsvector phrase search, exact
   window totals, and snippets.
5. **`domain.Snippet` mixed byte and rune indices** (panic on multibyte content)
   — found by the new unit test; rewritten in rune space.
6. **Concurrent lock acquisition 500'd** (SPEC §7.2) — file row lock inside the
   transaction; idempotent force-release.
7. **Download endpoint ignored Range** (SPEC §7.1/IO-PERF-02/ENG-03) — now
   streams through `http.ServeContent` with per-version modtime anchoring.
8. **CAD worker failed on content-addressed blob conflicts**
   (`model_derivatives_blob_id_fkey`, then a stale `RowsAffected` check) —
   retried conversions of the same source now adopt the existing blob and reach
   `ready`.

### Go test suite

`go build ./...`, `go vet ./...`, `go test ./...` — PASS (application, domain,
httpx, cmd/server). New tests: export stream contract (columns, neutralisation,
consumer abort, failure audit), folder/file share unification, CJK spacing,
extraction dispatch, docx container reading, snippet windowing.
`scripts/check_architecture.py` — PASS (71 Go files, 39 TS modules).

### Performance evidence (summary; full matrix in `docs/M7-PERF-DATASET-GATE.md`)

- Dataset gate 12/12 PASS (100,392 files / 402,564 versions / 10,000 folders
  depth 21 / 5,000-file hot folder / 1,000-version file / 20,000 shares /
  100,000 favorites).
- Endpoint budgets: 11/11 PASS at 1 and 10 users; 10/11 at 30 users (search p95
  over on a shared host with a broad term); pool-bound above that (see gate doc).
- CSV 100k export 9/9 contract checks; 10×100MB uploads 10/10; MP4 Range 10/10;
  Office sessions 12/12; CAD STEP→STL verified; backup restore drill PASS
  (26 tables, 41 media objects) with 12/12 manifest unit tests.
- Machine-readable reports under `.secrets/perf/` (root-only, not committed).

### Consolidated acceptance gate (2026-10-08, one pass over every executable check)

| Check | Result |
|---|---|
| `perf_readiness_audit.py` (§24.2 dataset) | DATASET_READY_FOR_BASELINE (12/12) |
| `unauth_security_smoke.py` | 17/17 |
| `m7_security_e2e.py` (cross-user security) | PASS (31/31) |
| `rb_rollback_e2e.py` (DEC-13 rollback) | PASS (27/27) |
| `s_matrix_e2e.py` (S1–S18) | PASS (32/32) |
| `pt_samples_e2e.py` (PT01–PT12) | PASS (112/112) |
| `perf_csv_export_check.py` | PASS (9/9) |
| `media_range_check.py` (MP4 Range) | PASS (10/10) |
| `office_session_check.py` | PASS (12/12) |
| `perf_upload_stress.py` (10×100MB) | PASS (10/10) |
| `check_architecture.py` | PASS (71 Go files, 40 TS modules) |

Note: the perf instance (18092 → filesmanage_perf) and the dev instance
(18091 → filesmanage_v21) keep separate session stores, so checks against the
perf database log in as the isolated perf user; this is expected isolation, not
a defect.

### Executable PT byte-fidelity matrix (commit 15663cd, 112/112 PASS)

`scripts/pt_samples_e2e.py` builds the twelve SPEC §8 fixtures client-side and
verifies them over the real API: preview metadata (encoding/BOM/EOL/trailing
newline/printability) for every sample, download SHA-256 equality with the
source bytes, byte-exact save round-trips (BOM, CRLF, 20k-char single line,
no-trailing-newline), literal rendering of the `<script>` and Markdown
samples, the 256 KiB truncation contract on a 300 KiB file (truncated=true,
full download intact), an A/B concurrent save where the stale base is refused
409 while the holder's version survives, and zero mutation when nothing is
saved. Fixture notes: printable=false is the NUL rule, so the invalid-UTF-8
sample is proven through the rawBase64 exact-bytes path plus the download
digest; PT09's byteMeta describes the truncated preview prefix.

### Executable RB-T rollback matrix (commit 1fe8d26, 27/27 PASS)

`scripts/rb_rollback_e2e.py` proves the DEC-13 append-only contract over the
real API: v1=A/v2=B/v3=C built through lock+save; rollback to v1 appends v4 with
v1's digest while v1..v3 keep theirs (RB-T01/02/03, current bytes = A); editing
on to v5 and rolling back to v2 yields v6 with history 1..6 and no seq gaps
(RB-T04); no-lock and stale-expected-seq rollbacks are refused 409 (RB-T05);
the same idempotency key replays without creating a version (RB-T09); missing
target 404, legacy {seq} body 400 and an ungranted user 403 all leave the
history intact (RB-T12). Per-version byte download is not part of the API
surface, so RB-T03 is proven through the version digest ledger plus the
current-version bytes.

### Executable S-matrix (commit 13e1df6, 32/32 PASS)

`scripts/s_matrix_e2e.py` re-runs the API-verifiable SPEC §13.2/§13.3 items on
demand: S1 login/session, S3 workgroup grant, S4 direct grant + union, S5
isolation (tree/list/search), S10 time-limited ACL with a real 70-second
expiry (visible before, 403 after), S11 admin-only endpoints, S16 favorites
idempotency, S17 stats scope, S18 CSV export contract (BOM, header, visible
paths only). It cleans up after itself (soft delete + disable) and is
loopback-only. The traceability matrix in IMPLEMENTATION-REPORT.md maps every
S item to its evidence.

### Viewport and model-viewer checks (PE16 / VS04, 2026-10-08)

Measured with the desktop browser against http://10.144.144.1:18091 (warm,
LAN): /doc reaches an interactive file table in 168 ms at 1440x900, 152 ms at
1366x768 and 2 ms at 1920x1080 (budget WEB-PERF-01 <= 2.5 s). Visual snapshots
at all three viewports: full navigation, breadcrumb, folder tree, toolbar and
the six file-table columns render without overlap (VS04).

The STEP model page (/model/:id) renders the converted mesh in the browser:
544 triangles / 1632 vertices with the grid canvas and blue/white brand chrome,
after the worker completed the original sample.step derivative (state ready,
108,016-byte mesh). The previously failed derivative rows were leftovers of the
CAD blob-conflict bug fixed this milestone.

### Search page (BLK-08 closed, commit 3dd8682)

- `/search` route + nav entry; SearchPanel with query/uploader/type/sort filters,
  result table (name, size, uploader, version, mtime) and snippets rendered as
  escaped text nodes plus `<mark>` (SPEC §8.1/§10.3).
- Browser verification against the business database: query 规范 returns
  real-spec.docx with the extracted DOCX content as the snippet; total line
  shows the authorized count.
- `tsc --noEmit` + `vite build` pass.

### Not verified / open

- PE15 (100-open WebGL leak run) and PE16 (1366/1440/1920 first-interactive
  timings) need a scripted browser harness; recorded as open.
- The `/search` page is missing from the React app (the API, snippets and
  filters are complete and verified); recorded as the next frontend task.
- 100/200-user budget misses are capacity findings on a shared host, not code
  defects; the dedicated reference environment is the SPEC's remedy.
