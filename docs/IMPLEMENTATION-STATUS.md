# filesmanage v2.1 — target-machine implementation evidence

Target host: 192.168.1.22 (Debian 13 / Linux), workspace /root/repository77/filesmanage-v21.
Legacy Node/SQLite and port 8091 remain untouched; no old data imported.
Implementation started 2026-10-08. Status: B0 complete, B1 in progress, B2 UI scaffold only.

## Implemented on target
- New isolated Git repository with authoritative SPEC v2.1 and audit evidence.
- Go modular boundaries domain/ports/application/adapters/httpx; authenticated session API and authorized folder tree.
- Fresh PostgreSQL DDL migration file and a transaction-aware migration executable.
- New-environment bootstrap executable with safe empty-database precondition.
- Password-change API with must-change guard for initial accounts.
- React 18 + TypeScript + Vite isolated login and document shell; app/pages/features/entities/shared split.
- Target-host Go tests, go vet, Go build, TypeScript checker, Vite bundle build.
- Static architecture and DDL preflight checks.

## Verified
- go test ./... PASSED after latest Go changes (domain and application tests).
- go vet ./... PASSED after latest Go changes.
- python3 scripts/check_architecture.py PASSED (initial rule coverage only).
- python3 scripts/verify_migration.py PASSED (static strings, not SQL execution).
- npm run build PASSED after React layering refactor.
- Port 8091 has not been claimed by this project.

## Not done / hard blockers
- New dedicated PostgreSQL database/role was NOT provisioned because the automated provisioning action was blocked by execution safeguards. No credentials were created. DDL has not actually run against PostgreSQL.
- Bootstrap not executed; HTTP login and folder endpoints not end-to-end tested against a real database.
- Frontend forced-initial-password-change form not yet implemented; backend guard exists.
- Official logo binary not yet transferred into target assets. UI displays explicit temporary asset notice.
- Upload/download/version rollback, ACL mutation, sharing, trash, favorites, stats, search, DOCX engine and CAD worker not built.
- p95/p99, 100k-file load, S1-S22/DO/MC/AG/PE validations and deployment not executed.

## Next ordered tasks
1. Approved secure provisioning of the fresh filesmanage_v21 PostgreSQL DB and least-privilege role.
2. Execute real migrations and safe bootstrap on the target; run PostgreSQL integration and API tests.
3. Build mandatory initial-password-change form; complete API authorization and file-list vertical slice.
4. Import verified official Logo binary; run Office/CAD PoCs in resource-isolated target containers.
5. Keep all work on 192.168.1.22. Never modify legacy Node code/data or install service on 8091 before release gate.
