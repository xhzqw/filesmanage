# Release gates

Overall: NO-GO for production (dev-only system on 18091). Milestone gates: M1–M6 GO (dev); M7 GO (dev) — budgets met at 10 and 100 users after the 2026-10-09 caching optimisation, 10/11 at 200 on the shared host; M8 dev-level GO (backup/restore, crash recovery, upgrade/rollback and from-scratch build all evidenced), production deployment OPEN pending BLK-05.

| Gate | Scope | Status | Evidence |
|---|---|---|---|
| G-M1 | Real login: bootstrap, auth, forced password change, real directory read, browser acceptance, LAN access | **GO (dev)** | IMPLEMENTATION-REPORT.md, TEST-EVIDENCE.md §M1 (re-verified 2026-10-08) |
| G-FS | File/folder vertical slice incl. versions, trash, restore, Range downloads | **GO (dev)** | TEST-EVIDENCE.md §M2, §M7 (PE09 10/10) |
| G-ACL | Org + ACL + cross-user isolation tests | **GO (dev)** | TEST-EVIDENCE.md §M3, §M7 (31/31 security E2E) |
| G-WF | Approvals, locks, conflicts, append-only rollback interplay | **GO (dev)** | TEST-EVIDENCE.md §M4, §M7 (lock race fix) |
| G-DOCX | Real DOCX editing + write-back + idempotent callbacks | **GO (dev)** | TEST-EVIDENCE.md §M5, §M7 (PE10 12/12) |
| G-CAD | Real CAD preview + Worker isolation + format matrix | **GO (dev, DWG blocked** by BLK-03) | TEST-EVIDENCE.md §M5, §M7 (MC 78/78 incl. IGES + assembly tree 8/8; PE12 7/7) |
| G-BIZ | Sharing, favorites, search, stats, CSV, plain-text fidelity | **GO (dev)** | TEST-EVIDENCE.md §M6, §M7 (export 9/9, PE06) |
| G-PERF | 100k files / 400k versions, p95/p99 budgets | **GO (dev) at ≤100 users** — after the 2026-10-09 caching optimisation 11/11 endpoints pass at 10 and at 100 users (was 7/11); at 200 users 10/11, the only miss being `/api/me` queueing (its own warm-cache cost is 1.4 ms) on the shared host | docs/M7-PERF-DATASET-GATE.md §optimisation, `.secrets/perf/blk07-final.json` / `blk07-200-final.json` |
| G-SEC | S1–S22 security/ACL/consistency matrix | **GO (dev)** for the executed matrix (folder-filter leaks closed, revocation immediacy, share unification, disable/logout, Range/SSRF-safe editor source) | TEST-EVIDENCE.md §M7, scripts/m7_security_e2e.py |
| G-DEPLOY | Backup/restore drill, systemd, upgrade/rollback, monitoring | **PARTIAL (dev-level GO)** — restore drill PASS (26 tables, 384 blobs); AG09 crash-recovery drill 4/4; upgrade/rollback drill 12/12 incl. a cross-format rollback; from-scratch build verified in a clean clone; systemd units written and syntax-verified but **not installed** and the production cutover is not authorized (BLK-05) | docs/M8-BACKUP-AND-SERVICE-READINESS.md, docs/OPERATOR-RUNBOOK.md, TEST-EVIDENCE.md final-gate sections |
| G-API | OpenAPI implementation contract | **GO (dev)** | docs/openapi-implemented.yaml (50 paths / 66 operations / 46 schemas), scripts/gen_openapi.py --check drift guard |
| G-MATRIX | Per-id acceptance traceability (126 ids) | **GO (dev)** | docs/ACCEPTANCE-MATRIX.md (123 PASS / 2 PARTIAL / 1 EXTERNAL), scripts/gen_acceptance_matrix.py --check; the 2 PARTIAL ids (S12, S20) are customer-input items under BLK-05/BLK-01 and no implementable gap remains |

Rules: no gate may be marked GO without the evidence file it names; legacy data
isolation (DEC-15) is checked before every gate; 8091 remains reserved.
G-PERF may only be raised to GO after a run on the SPEC's dedicated reference
environment (PERF-003) or an approved capacity ADR.
