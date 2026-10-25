# DHF V0.6.4 — 提交原子性、并发与受控 Blob 数据库防护验收记录

> Document ID: DHF-ENG-SUBMISSION-20261024-02  
> Version: v0.6.4-draft · Date: 2026-10-24  
> Status: DEVELOPMENT BRANCH VERIFIED IN ISOLATED DATABASE; **NOT A RELEASE AUTHORIZATION**  
> Branch: `feat/dhf-v06-gate-pilot` · PR: https://github.com/xhzqw/filesmanage/pull/1  
> Source baseline: `DHF-DESIGN-DEVELOPMENT-DOCUMENT-CRITERIA-v0.1.md`; original XMind source SHA-256 `c16d3c70a0687d363c0d33322d16900f89b49ae02160afb3b9b7c3457a4b097b`.

## 1. Scope and test boundary

- Continued after V0.6.3 real PostgreSQL trial submit/pin/audit/idempotency passed.
- V0.6.4 migration `0045_dhf_pilot_submission_blob_hold.sql` **does not** add real Gate approval, signing, file issuance, UI or public API routes.
- The isolated test targets PostgreSQL 17.9 on `root@10.144.144.1` (`openclaw77`) using a new disposable database name permitted by the integration test; the real project DB and running `main` worktree were not changed.
- The isolated fixture has synthetic `users/folders/files/file_versions/blobs` rows and a fake test-policy `G1`. It is not an approved corporate DHF project requirement.

## 2. Added database invariants

| Contract ID | Enforced behavior | Test |
|---|---|---|
| V064-DB-01 | An attempt with `state=submitted` must reference an immutable submission journal in the same transaction | Direct state update without journal must roll back |
| V064-DB-02 | A submission must refer to the exact original template/stage/project/manifest digest and template policy digest | A forged policy digest must fail on COMMIT; attempt and journal roll back |
| V064-DB-03 | A referenced `blobs` row cannot transition to `gc_pending` or be deleted | UPDATE/DELETE both refused |
| V064-DB-04 | Review/approval/conditional release remain disabled in the pilot database | `state=reviewing` refused |
| V064-DB-05 | Journal, pinned evidence tuple and audit remain one serializable transaction | First submit creates one each; retry does not duplicate |
| V064-DB-06 | Concurrent requests for one attempt cannot both commit separate submissions | Six contenders -> one actual writer, one journal, one success audit and one evidence pin |

Important nuance: a SQL trigger and foreign keys **cannot protect physical BlobStore files if an external GC process deletes objects without consulting PostgreSQL state or retention holdings**. Physical object retention, GC lock/protocol, backup consistency and restore validation are independent P0 blockers.

## 3. Actual remote validation evidence

| Validation | Command / observation | Result |
|---|---|---|
| V0.6.3 existing full Go internal regression | `go test ./internal/... -count=1`; plus `go vet`, Go builds | PASS at commit `e9af181` |
| V0.6.3 migration command | `cmd/migrate` on temporary PostgreSQL DB, followed by `-check` | PASS, 46 migrations |
| V0.6.4 raw migration and integrated Go test | Fresh isolated DB; all `migrations/*.sql`, then opt-in compiled Go integration binary under PostgreSQL OS user | PASS, 47 migrations |
| V064-DB-01..04 | Negative cases inside `TestDHFPilotRealPostgresSubmission` | PASS |
| V064-DB-05..06 | Commit + identical idempotency retry + six concurrent contenders | PASS at commit `6fc1b68` |
| Real browser workflow | No HTTP route or UI exists | NOT RUN / NOT APPLICABLE |
| Real signature and authorized business approval | Not implemented | BLOCKED |
| Physical BlobStore retention and GC | Not implemented for DHF | BLOCKED |

The test harness creates and removes disposable DBs. Each actual test run prints `DHF_V064_DB_INTEGRATION_PASS` and exits 0. Do not misrepresent Go package compilation or an isolated DB test as production compliance acceptance.

## 4. Authorization and history principles

- Existing `file_versions(file_id,seq)` is the file content authority. Pinned evidence includes exact file ID, version sequence, Blob ID and SHA-256; no live-latest alias is accepted as evidence.
- `dhf_pilot_submissions` and `dhf_pilot_submission_evidence` remain append-only. Fixing a submitted package must create a new attempt, not replace an accepted historic snapshot.
- Returned `TrialOnly=true` is a pilot result, **not** a digital signature, formal Stage Gate decision or release authority.
- Repeat requests are idempotent for the exact actor, attempt, key and frozen hashes; different keys cannot create another submission on the same attempt.
- Concurrency losers may receive an explicit serialization/conflict result and retry with the same key; a separately tested eventual retry returns the committed submission ID.

## 5. Next implementation blockers

1. **Physical Blob retention:** ensure all Blob GC paths consult the durable evidence holds before deciding to delete bytes. Include fault injection, concurrency with GC, crash recovery and restore.
2. **Approved template publication and baseline:** real governed and signed publication, no administrative SQL shortcut, immutable published policy snapshot/content hash.
3. **Workbench review aggregate:** project/stage/attempt identity, G5 specialty decisions with frozen manifest hash, default stepwise reviewer chain and authorized skip without removing intermediate responsibility.
4. **Stage decision append-only journal:** return/revise/approve actions, separation of duties, idempotency, CAS and outbox transaction.
5. **Project applicability and original XMind governance:** no automatic promotion of all visible source leaves to mandatory requirements. G6 first transfer and G8 transfer remain separate.
6. **Final testing:** repeat full Go regression at final branch HEAD, validate migrations with `cmd/migrate -check`, performance/concurrent/recovery tests and authorized DEV UI once routes exist.

**NO-GO:** Do not merge into production, deploy or allow real DHF approvals merely because this isolated submission pilot has passed.
