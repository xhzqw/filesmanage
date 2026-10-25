# DHF V0.6 — controlled Stage Gate policy pilot

Status: DRAFT / NOT PRODUCTION ENABLED, 2026-10-24.

## Documentation criteria (must-read first)

- [Engineering documentation standard](../DEVELOPMENT-DOCUMENTATION-STANDARD.md): identity, status, evidence, change control and release claims.
- [DHF development document criteria](DHF-DESIGN-DEVELOPMENT-DOCUMENT-CRITERIA-v0.1.md): exact G1–G9 titles/lines, G5 specialties, G6/G8 distinction, form-code collisions, document evidence and review gates.
- **Review warning (2026-10-24):** the V0.6 Go evaluator is a *partial policy prototype*, **not** a complete fail-closed authorization mechanism. A code review found P0 gaps for omitted requirement/dependency completeness, action/state validity, remediation linkage and specialty-submission identity. Never wire its `Allow` into a production approval, file-issuance or project gate endpoint until those gaps, trusted snapshot construction and integration tests are closed.
- Both standards are currently drafts on the development branch; their checklists do not constitute approval of any original business SOP.

## 1. Source and exact scope

- Source: `产品设计开发DHF_1-9阶段_XMind大纲.txt`, SHA-256 `c16d3c70a0687d363c0d33322d16900f89b49ae02160afb3b9b7c3457a4b097b`.
- V0.5 reference: `DHF_V0.5_Go服务端合同与状态机设计.md` (working artifact, not a published SOP).
- G5 software candidate nodes: source L39–63, 25 visible leaf candidates; includes repeated PEMS self-check entry at L61/L63.
- G5 process/manufacturing candidates: source L74–91, 17 visible leaf candidates; L76 ("总装") must not be assumed a formal deliverable.
- G6 first transfer: source L115–129, 10 visible leaf candidates; distinguish from G8 (L160–164).
- **All mandatory/conditional/applicability/role values remain proposals** until approved by a governance actor. There is no authorized production DHF template in this branch.

## 2. What this PR DOES

- Adds a standalone, pure Go fail-closed Stage Gate evaluator at `internal/domain/dhf`.
- Rejects unknown actions, unpublished template versions, inactive project baselines, missing actor grants, and invalid decision-stage combinations.
- Checks requirement applicability separately from mandatory evidence presence and pinned evidence verification.
- Checks configured G5 specialty reviews *only at final decision time*, not on initial submission.
- Requires signed, recorded authorization for an `not_applicable` specialty decision; missing/returned specialties prevent final acceptance.
- Allows a conditional decision only for template-eligible, noncritical unmet requirements with corresponding remediation IDs, current authorization, a future expiry and an explicitly safe scope.
- Prohibits implied/transitive scope and expired predecessor conditional grants. Document issuance always requires independently approved file release policy and accepted stage.
- Adds unit tests for those boundaries, including the G5 initial-submission trap.

## 3. What this PR does NOT do

- Does NOT implement PostgreSQL migration, actual template publishing, source-node import, files/Blob holds or production permissions.
- Does NOT introduce an HTTP handler, scheduler, UI, working approval button, signed electronic record, nor change existing `/approvals`.
- Does NOT establish actual admissibility of any named G5/G6 deliverable.
- Does NOT deploy to dev or production. No claim of Go test execution in the designated remote environment.

## 4. Application boundary (P0 before enabling commands)

The future Go application service must construct `dhf.GateInput` ONLY from a consistent server-side transaction snapshot (never from request flags):

1. Verify actor session and project-specific business capability.
2. Resolve a published immutable template, its actual published hash and active project baseline.
3. Read requirement/evidence identities via composite template/baseline constraints; verify pinned `(file_id,seq,sha256)` against `file_versions`.
4. Resolve effective file ACL for ordinary reads or narrowly scoped evidence authorization for assigned review tasks.
5. Evaluate segregation-of-duties against frozen requester/contributor/reviewer identities.
6. Lock resources in documented global order, inspect active Evidence Hold + Blob readiness.
7. Resolve all applicable upstream rules and conditional authorizations; ensure each direct grant has an unexpired scope.
8. Compute G5 specialty *expected* set from signed template, and decisions from same immutable submission attempt.
9. Run `Evaluate` inside the write transaction, then append decisions, stage projection changes, audit, idempotency result and outbox atomically.
10. Perform notification *after commit*; on a retry resolve the same result with matching payload hash.

The booleans inside `GateInput` are trusted *internal facts*. Merely calling `Evaluate` with booleans provided by a client would be a severe authorization defect.

## 5. Pilot test strategy

Remote-only as required by `AGENTS.md`. On the authorized remote dev host:

```sh
go test ./internal/domain/dhf -count=1
go test ./internal/domain/... -count=1
bash scripts/build.sh --with-tests
```

Additional repository-level acceptance gates before any schema or route integration:

| ID | Test | Expected |
|---|---|---|
| V06-01 | Attempt G5 submission before specialty reviews exist | May proceed if evidence/template/policy pass; does not require decision |
| V06-02 | G5 finalization with a missing specialty | Denied |
| V06-03 | G5 'not applicable' without authorized determination | Denied |
| V06-04 | G5 'returned' specialty | Denied |
| V06-05 | G5 conditional acceptance on critical missing evidence | Denied |
| V06-06 | Conditional release after expiry | Denied |
| V06-07 | Conditional release granting issue_document | Denied |
| V06-08 | G6 predecessor conditional grant not directly scoped to G7 action | Denied |
| V06-09 | G6 predecessor conditional grant expired | Denied |
| V06-10 | Conditional stage attempting formal issue_document | Denied |
| V06-11 | Unpublished template / inactive baseline / unapproved actor | Denied |
| V06-12 | Edit ordinary draft while upstream Gate incomplete | Permitted only with separate project/file permissions |
| V06-13 | Missing, unverifiable or wrong-template pinned evidence | Submission denied at integration boundary |
| V06-14 | Concurrent reviewers / idempotent retry | At most one final decision, repeat returns same result |
| V06-15 | Evidence Hold vs Blob GC contention | No committed evidence loses retained bytes |
| V06-16 | Real-time invalidation with revoked resource permission | No unauthorized metadata leaked |

Only tests V06-01..12 are within the current pure-domain pilot. Integration tests V06-13..16 are planned and not implemented by this PR.

## 6. Remaining release blockers

1. Formal authorization of G5 software/manufacturing and G6 requirement applicability, mandatory fields and permitted evidence.
2. Approval of real predecessor dependency graph (14 proposal edges are NOT authorized rules).
3. Template publishing review, duty separation policy, and approval-chain snapshot definitions.
4. DB schema migration built from V0.4+V0.5 draft after composite FK, baseline-identity and immutable evidence review.
5. Blobs hold/GC protocol and transactional safety, subject to file lifecycle and retention policies.
6. Remote dev tests, front-end workflow review, performance review, and authorized acceptance.
7. Production rollout remains blocked until governance approval.

## 7. Decision log

- A+B: Finder remains file authority; knowledge page and folder trees remain independent with explicit bidirectional links.
- Folder knowledge homepage: manual by default, project template may provision automatically.
- Stage acceptance: strictly pass/return by default; conditional only by published authorized template and instance-specific decision.
- Historical submitted artifacts and decisions are immutable; revisions create new attempts.
- G6 and G8 are different Stage IDs, never merged by similar names.
