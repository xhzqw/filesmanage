# Release gates

Overall: NO-GO for production (dev-only system on 18091). Milestone gates: M1–M6 GO (dev); M7 evidence collected with the shared-host capacity caveat; M8 dev-level recovery GO, production deployment OPEN.

| Gate | Scope | Status | Evidence |
|---|---|---|---|
| G-M1 | Real login: bootstrap, auth, forced password change, real directory read, browser acceptance, LAN access | **GO (dev)** | IMPLEMENTATION-REPORT.md, TEST-EVIDENCE.md §M1 (re-verified 2026-10-08) |
| G-FS | File/folder vertical slice incl. versions, trash, restore, Range downloads | **GO (dev)** | TEST-EVIDENCE.md §M2, §M7 (PE09 10/10) |
| G-ACL | Org + ACL + cross-user isolation tests | **GO (dev)** | TEST-EVIDENCE.md §M3, §M7 (31/31 security E2E) |
| G-WF | Approvals, locks, conflicts, append-only rollback interplay | **GO (dev)** | TEST-EVIDENCE.md §M4, §M7 (lock race fix) |
| G-DOCX | Real DOCX editing + write-back + idempotent callbacks | **GO (dev)** | TEST-EVIDENCE.md §M5, §M7 (PE10 12/12) |
| G-CAD | Real CAD preview + Worker isolation + format matrix | **GO (dev, DWG blocked** by BLK-03) | TEST-EVIDENCE.md §M5, §M7 (PE11 incl. dedup path) |
| G-BIZ | Sharing, favorites, search, stats, CSV, plain-text fidelity | **GO (dev)** — `/search` page pending | TEST-EVIDENCE.md §M6, §M7 (export 9/9, PE06) |
| G-PERF | 100k files / 400k versions, p95/p99 budgets | **PARTIAL** — budgets met ≤10 users and 10/11 at 30 users on a shared host; 100/200 users pool-bound | docs/M7-PERF-DATASET-GATE.md, `.secrets/perf/*.json` |
| G-SEC | S1–S22 security/ACL/consistency matrix | **GO (dev)** for the executed matrix (folder-filter leaks closed, revocation immediacy, share unification, disable/logout, Range/SSRF-safe editor source) | TEST-EVIDENCE.md §M7, scripts/m7_security_e2e.py |
| G-DEPLOY | Backup/restore drill, systemd, upgrade/rollback, monitoring | **PARTIAL** — dev restore drill PASS; production cutover not authorized (BLK-05) | docs/M8-BACKUP-AND-SERVICE-READINESS.md |

Rules: no gate may be marked GO without the evidence file it names; legacy data
isolation (DEC-15) is checked before every gate; 8091 remains reserved.
G-PERF may only be raised to GO after a run on the SPEC's dedicated reference
environment (PERF-003) or an approved capacity ADR.
