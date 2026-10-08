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
