# Release gates

Overall: NO-GO for production (dev-only system on 18091). Milestone 1 gate: GO for continued development.

| Gate | Scope | Status | Evidence |
|---|---|---|---|
| G-M1 | Real login: bootstrap, auth, forced password change, real directory read, browser acceptance, LAN access | **GO (dev)** | docs/IMPLEMENTATION-REPORT.md, docs/TEST-EVIDENCE.md |
| G-FS | File/folder vertical slice incl. versions, trash, restore | OPEN | Milestone 2 |
| G-ACL | Org + ACL + cross-user isolation tests | OPEN | Milestone 3 |
| G-WF | Approvals, locks, conflicts, append-only rollback | OPEN | Milestone 4 |
| G-DOCX | Real DOCX editing + write-back + idempotent callbacks | OPEN (blocked: BLK-02) | Milestone 5 |
| G-CAD | Real CAD preview + Worker isolation + format matrix | OPEN (blocked: BLK-03/04) | Milestone 5 |
| G-BIZ | Sharing, favorites, search, stats, CSV, plain-text fidelity | OPEN | Milestone 6 |
| G-PERF | 100k files / 400k versions, p95/p99 budgets | OPEN | Milestone 7 |
| G-SEC | S1–S22 security/ACL/consistency matrix | OPEN | Milestone 7 |
| G-DEPLOY | Backup/restore drill, systemd, upgrade/rollback, monitoring | OPEN (8091 not authorized) | Milestone 8 |

Rules: no gate may be marked GO without the evidence file it names; legacy data isolation (DEC-15) is checked before every gate; 8091 remains reserved.
