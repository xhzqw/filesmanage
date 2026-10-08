# filesmanage v2.1 — implementation status

Target host: 192.168.1.22 (Debian 13 / Linux), workspace /root/repository77/filesmanage-v21.
Legacy Node/SQLite system and port 8091 remain untouched; DEC-15 data isolation in force.
Implementation started 2026-10-08. Status: Milestones 1–4 COMPLETE and verified on target; Milestones 5–8 open.

## Done and verified on target
- **M1 real login**: bootstrap, bcrypt auth, httpOnly SameSite=Strict sessions, forced first-login password change, LAN access on 0.0.0.0:18091 behind explicit opt-in + fail-closed source-IP allowlist, browser acceptance.
- **M2 file/folder slice**: folders CRUD + recursive delete/restore; streaming upload → content-addressed blob → v1 in one transaction; keyset pagination; preview with byte-fidelity metadata; authoritative download; save with baseSeq CAS; append-only rollback (DEC-13) with idempotent replay; versions; trash (list/restore/purge); grants CRUD; audit everywhere.
- **M3 organization + permissions**: users (create with issued credential, disable/enable with immediate session kill, admin password reset with forced re-change), departments, workgroups + membership; nine-action ACL server-side with query-layer filtering; cross-user isolation and admin separation verified.
- **M4 approvals + lock closure**:
  - Admin approval policy per folder (approver + enabled); under a policy, save/rollback become pending approvals (202 + approvalId) instead of versions.
  - Approve commits a new immutable version (attributed to the requester), reject/cancel change nothing; double decisions and concurrent approvals are controlled conflicts — exactly one approver wins (verified with 3 parallel approvals).
  - Edit locks: file-level single-writer lease with 30 min server-side TTL; save requires the live token; a successful save releases the lock; expired leases are taken over (old token dies); stale tokens cannot release a newer holder's lock; own-lock re-acquire issues a fresh token.
  - Rejected edits never touch the current version; pending payloads stay invisible to preview/download.
  - Frontend: 审批工作台 (/approvals inbox + my requests), lock-aware text editor (auto lock acquire/release, approval submit when the folder is governed), admin 审批策略 dialog, approval-policy resolution composed at page level (FSD-clean).

## In progress
- Milestone 5: DOCX editing engine PoC + CAD preview.

## Not done / blockers
- Official Logo binary not yet provided; UI shows explicit "待入库" placeholder (DEC-14).
- DOCX editing (M5) blocked on ONLYOFFICE self-hosting approval (BLK-02); DWG on commercial SDK decision (BLK-03); STEP/IGES converter toolchain approval (BLK-04).
- Sharing, favorites, full-text search, stats/CSV: not built.
- Performance suite (100k files / 400k versions, p95/p99), S1–S22 matrix, backup/restore drill, systemd deployment: not executed. Production 8091 cutover NOT authorized.
- Disabled dev accounts (clerkA/clerkB/editor) retained for audit continuity; they hold no grants, sessions or locks.

## Access (development, LAN-only)
- URL: http://192.168.1.22:18091 (account `admin`; credential at `/root/repository77/filesmanage-v21/.secrets/admin.password`, mode 0600, root-only).
- Staff demo accounts 1000001–1000005 exist with unusable passwords; admin issues credentials from the 组织管理 page.
