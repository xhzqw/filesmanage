# DHF V0.8.0 — 条件整改预案与直接依赖的受控时限账本（工程增量 4）

> document_id: DHF-ENG-V080-CONDITIONAL-PLAN-20261025-04
> version: v0.8.0-dev-04 · date: 2026-10-25
> status: engineering-pilot / DRAFT / corporate Stage Gate authorization **NO-GO**
> applies to: source-verified G1–G9 published project baselines, direct dependency edges
> dependencies: `DHF-V080-G1-G9-PUBLISHED-GRAPH-INTEGRITY-2026-10-25.md`,
> `DHF-V080-INDEPENDENT-GATE-DECISION-REVIEW-2026-10-25.md`
> original source outline SHA-256: `c16d3c70a0687d363c0d33322d16900f89b49ae02160afb3b9b7c3457a4b097b`
> engineering owner: filesmanage maintainers
> corporate process owner / qualified issuer: NOT_DESIGNATED
> implementation: `migrations/0060_dhf_conditional_remediation_proposals.sql`,
> `internal/application/dhf_conditional_proposals.go`,
> `internal/adapter/postgres/dhf_conditional_proposals.go`,
> `internal/httpx/dhf_conditional_proposals.go`,
> `web/src/features/workflow/DHFConditionalRemediationPlans.tsx`
> integration tests: `internal/adapter/postgres/dhf_pilot_submission_integration_test.go`

## 1. Purpose and explicit nonpermission

This increment captures **proposed** per-requirement corrective actions and
owners *before* an enterprise-authorized conditional Stage Gate decision
exists. A proposal is NOT a conditional grant, does not bypass a predecessor,
and does not permit `prepare`, `submit`, `finalize`, `issue_document` or
controlled distribution. The Stage projection's `accepted` and
`conditionally_released` states remain blocked by migration 0043.

The preparer can propose a limited exception **only** on a currently active,
approved and hash-verified published template with an explicit
`conditional_allowed=true` policy, an individually named **direct**
dependency with `AllowConditional=true` and `GuardedAction=prepare/submit`,
and a nonaccepted predecessor in the **same** project. Numeric stage order,
transitive upstream dependencies and arbitrary client-supplied scope cannot
become an exception. G6 initial transfer and G8 later transfer remain
distinct stage identifiers.

## 2. One-to-one immutable plan contract

Migration 0060 adds `dhf_pilot_conditional_remediation_proposals`. One
immutable plan can exist for each
`project_id + stage_id + active template_id + direct dependency_id`.
Its frozen attributes include the requester, policy SHA, full independently
rebuilt project graph and graph SHA, dependency, original predecessor,
limited *proposed* action, reason, request digest and idempotency key,
`expires_at`, and a bounded array of corrective obligations.

Every obligation contains `requirementId`, `ownerId`,
`correctiveAction`, and `dueAt`. Requirements must be individually
named in the exact published target template, **Mandatory**, **noncritical**
and `ConditionEligible`. The proposer cannot invent requirement identifiers
or include any critical requirement, including G5 critical professional
evidence. The corrective owner must be an enabled project member with
prepare/submit responsibility; the same requirement cannot be listed twice.
The plan must contain 1–32 obligations; the plan lifetime is at most
30 days and each individual due date must lie in the future and no later
than the plan's expiry. The actual corporate authorization duration may
eventually be **stricter** than this planning maximum; no approval is
inferred from the clock.

The applicant needs current project `can_prepare`, must reauthenticate
with the current password and is subject to the existing persisted
auth-failure rate limit. SQL independently checks actor, template bytes,
project graph, direct dependency, every corrective item and every deadline
again inside one SERIALIZABLE transaction. Client does not provide
template hash, authority or project graph. The original template and plan
remain immutable. A deferred trigger requires exact matching
`dhf.pilot.conditional_proposal_filed` audit and trial-only outbox in the
same transaction, both with `formalAccepted:false`.

## 3. Withdrawal, expiry, immutable history

An original applicant may append a single withdrawal reason after password
reauthentication. The withdrawal is itself immutable, requires matching
audit and outbox, and retains the original obligations/graph. No permission
can be created or restored by undoing a withdrawal.

Runtime state is derived by the database on every read:
`awaiting_enterprise_authority`, `expired` if the DB clock reaches the
deadline, and `withdrawn` if the append-only withdrawal exists (wins
over expiry). Neither endpoint nor ordinary application administrators can
mutate a stored plan to `approved`, `accepted`, or
`conditionally_released`. An exact retry returns the original plan ID;
a new request key or changed content cannot overwrite an immutable plan.

The existing Workbench gets **条件整改预案**, an embedded two-pane RareUI
experience. Applicants select *only available published policy edges*,
then actual eligible requirement identifiers and live selectable project
responsibility owners, before supplying distinct deadlines, corrective
details, reason and password. Existing plans show their real-time computed
status and original graph fingerprint with the withdrawal action.

## 4. API (trial-only)

| Method | Path | Guaranteed consequence |
|---|---|---|
| GET | `/api/workbench/dhf/conditional-plans` | Scoped applicant opportunities and immutable own plans; never permission |
| POST | `/api/workbench/dhf/conditional-plans` | Original conditional plan + per-item corrections, same-transaction audit and outbox; only waiting for enterprise authority |
| POST | `/api/workbench/dhf/conditional-plans/{id}/withdraw` | Original author appends auditable withdrawal; cannot delete records or grant conditional actions |

## 5. Corporate acceptance NO-GO and future work

Still NOT implemented: official corporate role/signing mandate,
independent electronically signed condition decision, actual bounded
authorized direct-edge grant with scope/expiry/revocation enforced on
**every** downstream application command, status compare-and-swap,
per-requirement approval of evidence/closure by the original reviewers,
and CDW distribution/receipt/training. Existing return–remediation–
resubmission–original-reviewer reverification must not be bypassed or
recreated. This planning ledger is intentionally not referenced as an
authorization source by `dhfPilotEvaluateTx` or any CDW handler.

The production database, running business services and port 8091 are
outside the isolated engineering scope.

### Verification evidence

Record only actual remote source revision, clean PostgreSQL 17 database,
full migration count/checksum, real positive/negative integration tests,
Go/TypeScript builds, OpenAPI and acceptance-matrix results **after**
execution. Unverified or failing gates remain NO-GO.
