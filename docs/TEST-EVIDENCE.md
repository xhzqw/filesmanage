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
