# DHF V0.8.0 — 正式 Stage Gate 验收申请状态机（第一工程增量）

> document_id: DHF-ENG-STAGE-GATE-INTAKE-20261025-01
> version: v0.8.0-dev-01 · date: 2026-10-25
> status: draft / engineering pilot / corporate SOP NOT_APPROVED
> scope: 已有 G5 输出及 G6 首次转移的密码学签名试点 Gate → 正式验收申请登记
> responsible: engineering maintainer; corporate Gate decision owner UNASSIGNED
> source: `DHF-DESIGN-DEVELOPMENT-DOCUMENT-CRITERIA-v0.1.md` and original nine-stage XMind SHA `c16d3c70a0687d363c0d33322d16900f89b49ae02160afb3b9b7c3457a4b097b`
> implementation: `migrations/0057_dhf_stage_gate_review_intent.sql`,
> `internal/application/dhf_stage_gate_review.go`,
> `internal/adapter/postgres/dhf_stage_gate_review.go`,
> `internal/httpx/dhf_stage_gate_review.go`,
> `web/src/features/workflow/DHFStageGateIntake.tsx`
> test evidence: `internal/adapter/postgres/dhf_pilot_submission_integration_test.go`
> enterprise approval: **NO-GO**; must never infer approval from application tests

## 1. Engineering scope and nonnegotiable fail-closed policy

The nine stages G1–G9 and their original source names are preserved. The
XMind is a **source candidate**, not an authorized dependency DAG. The software
must never synthesize `G1→G2→…→G9` from numerical order.
Stage dependencies come only from the exact published,
SHA-256-verified template that the original submission froze. An explicitly
empty dependency list means **no policy-defined predecessor edge**, not an
implicit preceding stage. This rule does not waive other mandatory evidence,
review or enterprise approval controls.

Version 0057 adds a **strict-mode Stage Gate review intake** after a true
cryptographically signed, frozen G5/G6 Gate candidate. No enterprise
signatory or approved Stage Gate SOP is configured; the intake's only durable
state is `awaiting_enterprise_authority`. It is a record that an assigned
Gate reviewer has requested formal review, **not** a business approval.

| Frozen Stage attempt | Permitted existing activity | V0.8.0 new artifact | Forbidden |
|---|---|---|---|
| `preparing` | Prepare/submit under original evidence ACL | None | Direct Gate approval |
| `submitted` with missing responsibility | Remediation and independent original-reviewer verification | None | Gate request without original responsibility closure |
| `submitted` with signed Gate | Audited review intake, using latest physical Blob/Preview ACL recheck | `awaiting_enterprise_authority` | `accepted`, CDW issue, receipt or transitive conditional bypass |
| `accepted` or `conditionally_released` | **No transitions exist in this increment** | None | SQL or HTTP fabrication of formal states |

The original `dhf_pilot_stage_positions` database CHECK still prevents
`accepted` and `conditionally_released` directly. The original attempt
still stays `submitted` after review-intake commit. A new DB immutable
ledger's CHECK allows only `awaiting_enterprise_authority`. There is **no
authenticated HTTP endpoint, flag, token, client claim or admin bypass**
that can turn this into a formal release.

## 2. Snapshot, signature and immutable audit contract

Gate review source: assigned and still-enabled `__gate__` reviewer, project
membership, original submitter separation, original signed candidate, linked
submission/attempt identity, active project and published frozen template.
Before either read or write, the application reconstructs V2 Ed25519 payload
and verifies the original stored public key, signature, key fingerprint,
frozen manifest and policy digests. A legacy unbound V1 candidate cannot
request formal review.

The app records **every** dependency edge in the published policy:
`id, predecessorStage, guardedAction, observedState`. A missing predecessor
position is `preparing` (not implicitly accepted). Each unaccepted
predecessor produces an explicit `UNACCEPTED_PREDECESSOR:<stage>` reason.
`ENTERPRISE_GATE_AUTHORITY_NOT_APPROVED` is always present. A check
trigger reconstructs the policy edges and current stage positions in the
same database transaction and refuses missing, added or falsified edges.
The JSON dependency snapshot and its SHA-256 are frozen, as are the original
candidate payload SHA, policy SHA and manifest SHA.

Reauthentication uses the current account password and the shared persisted
review-auth denial rate limit. Before committing, the service verifies current
Gate-preview ACL and each exact pinned file version and its **physical**
Blob digest again, not only its file name or metadata. The DB requires all
assigned reviewers' independently signed passing responsibilities and every
applicable remediation's original-reviewer verification closure.

Insertion, precise audit and `dhf.pilot.gate.review_requested` outbox are one
SERIALIZABLE transaction. Enforced candidate uniqueness, per-signer
idempotency key uniqueness, request SHA matching and rejection of UPDATE/DELETE
prevent silent rewriting or duplicate requests. The outbox explicitly carries
`trialOnly:true` and `formalAccepted:false`.

## 3. API and workbench

| API | Scope | Mutation |
|---|---|---|
| `GET /api/workbench/dhf/gates/{submissionId}/readiness` | Original assigned G5/G6 Gate signer only; full source and template cross-check | No; shows observed dependencies and blockers |
| `POST /api/workbench/dhf/gates/{submissionId}/review-request` | Original signer + current password + fully pinned physical evidence | Writes one immutable **strict** intake, not an approval |

Conditional review is rejected by both service and database, even if a
template's `conditional_allowed` policy field is true: the independent,
enterprise-approved conditional-grant issuance and expiry/limited-actions
control does not yet exist. The Workbench inserts this view **within the
existing Gate review panel**, not a duplicate tasks system. It explicitly
shows blockers, the frozen dependency edges and a request ID when filed.

## 4. Planned, not yet authorized Stage Gate transitions

The next implementation increment, after enterprise policy and issuance
authority are specified, must separately define:

1. An immutable corporate `GateDecision` with a real and authorized
   decision-maker, qualified signing identity, trusted timestamp and canonical
   *decision* payload; **do not reuse** the trial-candidate signature as
   authorization.
2. A published per-stage policy dependency DAG with explicit approval of
   every edge, cycle checks and no inherited authorization for unmentioned
   dependencies; G6 and G8 remain distinct.
3. Strict `requested → approved/rejected/returned` transitions with
   compare-and-swap locking against the frozen submission and a unique
   approved decision. Explicit responsibility chain, actual evidence hold
   and verified original reviewer remediation close must be prerequisites.
4. **Conditional authorization** only on separately approved templates and
   noncritical scope, with independent signatory, per-requirement correction
   obligations, expiry, target stage, *only explicitly allowed* prepare/submit
   actions and direct (never transitive) predecessor waiver.
5. Receipt/training/CDW issuance remain independent state machines, not
   side effects of a Stage Gate intent or even a later formal decision.

No document name or numeric stage progression supplies these approvals.
Enterprise CA/HSM, protected key custody, real signature intent, corporate
quality review, concurrent writer stress and browser width/accessibility
acceptance remain separate NO-GO items.

## 5. Verification evidence

Acceptance evidence must cite exact remote commit and database, and be
recorded **only after execution**. The historical integration checks for
unapproved conditional requests, unaudited/fabricated SQL, review idempotency,
unchanged attempt state, signature identity, revoked credentials, physical
evidence and original responsibility chain are extended under the existing
real PostgreSQL test. The first migration attempt exposed PostgreSQL 17
`jsonb`-text volatility in generated columns; the dependency SHA now is
calculated in the trusted insert trigger rather than a generated column.
This failure remains part of the engineering evidence, not a successful run.

**This deliverable is one foundational V0.8.0 increment; it is not the
completion of formal G1–G9 acceptance. Corporate acceptance remains NO-GO.**
