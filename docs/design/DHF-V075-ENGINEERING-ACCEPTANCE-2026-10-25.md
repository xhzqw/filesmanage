# DHF V0.7.5 — 试点签署凭证工程验收记录

> document_id: DHF-ENG-ACCEPTANCE-V075-20261025
> version: v0.7.5-dev-test · date: 2026-10-25
> status: engineering test report / trial only; corporate SOP NOT_APPROVED
> scope: V0.7.4 regression + V0.7.5 signer-bound credential additions
> responsible: engineering maintainer
> source: original G1–G9 DHF source hash and the V0.7.4/V0.7.5 engineering contracts
> implementation under test: `1de36af` (GitHub `feat/dhf-v06-gate-pilot`)
> approval: technical regression observed; **NOT an enterprise Stage Gate or signature-policy authorization**

## 1. Isolated environment and provenance

- Machine: `10.144.144.1` (`openclaw77`), PostgreSQL 17, Go, Node/Vite.
- Git: fresh clone to `/tmp/filesmanage-dhf-v075-99ade80`; HEAD `1de36af`. Running business checkout `/root/repository77/filesmanage-v21` was not modified or deployed.
- Databases: `filesmanage_dhf_v063_integration_v075_99ade80` (first fixture attempt, failed and abandoned); `filesmanage_dhf_v063_integration_v075_1de36af` (fresh full rerun and PASS). These are isolated from operational `filesmanage_v21`.
- Private credential: an ephemeral Ed25519 key generated in the integration test process, never committed or exported from the machine. The business server's credentials are not used as test signature keys.

## 2. Actual executed verification

| ID | Validation performed | Observed result |
|---|---|---|
| V075-PG-01 | New isolated database, `go run ./cmd/migrate -dir migrations` | **PASS — MIGRATIONS_OK 57** |
| V075-PG-02 | Same DB, `go run ./cmd/migrate -dir migrations -check` | **PASS — MIGRATIONS_OK 57** |
| V075-CRYPTO-01 | `go test ./internal/adapter/postgres -run '^TestDHFPilotRealPostgresSubmission$' -count=1 -v` with only the isolated `DHF_TEST_DATABASE_URL` | **PASS — real PostgreSQL test, 2.26s** |
| V075-CRYPTO-02 | Unregistered global key, forged signature, unauthorized reviewer, missing preview ACL, no-audit candidate, credential identity, idempotent replay, immutable history, event without audit, revoked key, terminal-state reactivation | **PASS — assertions inside V075-CRYPTO-01** |
| V075-GO-01 | `go test ./internal/... -count=1` (without test-DB environment) | **PASS — adapter/application/domain/http packages** |
| V075-GO-02 | `go vet ./internal/...` | **PASS — exit code 0** |
| V075-BUILD-01 | `go build` of server, worker and migrate binaries in isolated `/tmp` outputs | **PASS — exit code 0** |
| V075-CONTRACT-01 | `python3 scripts/gen_openapi.py --check` | **PASS — 139 paths** |
| V075-CONTRACT-02 | `python3 scripts/gen_acceptance_matrix.py --check` | **PASS — 126 IDs (123 PASS, 3 PARTIAL)** |
| V075-WEB-01 | `npm --prefix web ci --no-audit --no-fund`; `npm --prefix web run build` | **PASS — tsc, Vite 697 modules**; existing Three.js import/chunk-size warnings |

## 3. Negative-test failure fixed before acceptance

The first added credential-fixture run failed because the test's newly written `audit_events` INSERT omitted the mandatory `request_id` column. Its transaction remained open after `t.Fatal`, which delayed test shutdown. This result was **FAIL**, not accepted.

Commit `1de36af` added unique audit request IDs and explicit rollback defers. The second fresh database and unmodified, full real PostgreSQL test then **passed**, followed by the normal Go and front-end regressions. No migration or production database was modified to conceal the failure.

## 4. Residual blockers / NO-GO

1. Credential authorization and issuance are **internal test/database-only**; no approved enterprise identity policy, separation-of-duties approval workflow, HSM/CA integration, revocation distribution SLA, or trusted third-party timestamp.
2. Migration 0055 is incremental; it enforces candidate registration at INSERT, but historical V0.7.4 records intentionally remain readable with null `signing_credential_id`. This is backward-compatibility, not an authorization downgrade for new records.
3. No formal `accepted`/conditional Gate state machine or enterprise SOP was activated; no CDW controlled release, departmental receipts or training rules were authorized.
4. Real browser/workbench UX, 18091 runtime deployment, credential interface provisioning and read-only historical verification UX are **NOT_RUN** in this increment. The active business checkout has unrelated worktree changes; it was left untouched.
5. Full lifecycle, expiry, race/rollback stress, enterprise identity/authorization and physical Blob retention/disaster-recovery tests remain required for production-readiness.

**Verdict:** Trial credential signer binding passes the listed engineering checks. V0.7.5 enterprise credential governance is **PARTIAL / NO-GO**, and official Stage Gate acceptance remains blocked.
