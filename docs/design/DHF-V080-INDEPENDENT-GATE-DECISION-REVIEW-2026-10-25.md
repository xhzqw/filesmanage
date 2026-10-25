# DHF V0.8.0 — 独立 Gate 决策复核与不可变责任链（工程增量 3）

> document_id: DHF-ENG-V080-INDEPENDENT-DECISION-20261025-03
> version: v0.8.0-dev-03 · written: 2026-10-25
> status: draft / engineering-pilot only; corporate Stage Gate approval NO-GO
> scope: G5/G6 signed trial candidate → strict Gate review intake → separated independent review recommendation
> engineering owner: filesmanage project maintainers; quality authority and regulated signature owner NOT_DESIGNATED
> sources: `DHF-V080-STAGE-GATE-REVIEW-INTAKE-2026-10-25.md`,
> `DHF-V080-G1-G9-PUBLISHED-GRAPH-INTEGRITY-2026-10-25.md`,
> original XMind SHA-256 `c16d3c70a0687d363c0d33322d16900f89b49ae02160afb3b9b7c3457a4b097b`
> implementation: `migrations/0059_dhf_gate_independent_decision_review.sql`,
> `internal/adapter/postgres/dhf_gate_decision_review.go`,
> `internal/application/dhf_gate_decision_review.go`,
> `internal/httpx/dhf_gate_decision_review.go`,
> `web/src/features/workflow/DHFGateDecisionReviewInbox.tsx`
> tests: `internal/adapter/postgres/dhf_pilot_submission_integration_test.go`
> signature authority: **NONE**; this stage does not approve, conditionally release or distribute any DHF/CDW document

## 1. Responsibility separation and bounded delegation

One signed Gate candidate is filed by its actual `__gate__` signer as a
strict, immutable review intake. A separate *trial recommendation reviewer*
may inspect that intake only when an explicitly **independently granted**
project+stage mandate is currently active. The independent approver, reviewer,
original Gate signer and original submission author must be appropriately
separated. A general administrator role, project ownership, task delegation
or original Gate signature does not imply independent decision-review rights.

The new trial reviewer mandate is **not a corporate electronic signature
certificate** and cannot be issued through the API. It requires an
independent `approved_by`, external authorization reference, append-only
same-transaction audit, at most 30-day validity, a living reviewer and
approver, and current project membership. Emergency revocation is an
append-only event performed by the original mandate approver with exact audit.
Expired/revoked mandates immediately stop new opinions and visibility.
History itself is retained and is never reinterpreted as authorized
corporate acceptance.

## 2. Only two permissible recorded opinions

The independent person may file **one** original-traceable
`recommend_return` or `recommend_reject` suggestion per Gate review
intake, after current password reauthentication and the existing persisted
5-failures-per-window rate limit. The immutable opinion binds the original
frozen project graph SHA-256, signed candidate payload SHA-256, mandate,
reviewer, precise reason, idempotency key and canonical request digest.
An exact replay reuses the prior opinion ID; a changed review/opinion, key
or reason cannot silently overwrite or supplement the first opinion.

The underlying ledger's only state is `recommendation_only`, always
`trial_only=true`. A PostgreSQL trigger independently verifies the original
intake, all identities, stage/project scope, active mandate and source graph.
A deferred constraint trigger requires the exact corresponding audit event
and trial-only outbox, both explicitly `formalAccepted=false`, in the same
transaction. No UPDATE/DELETE is permitted on grants, revocations or opinions.

There is **no** path for `approved`, `accepted`,
`conditionally_released`, delegated release, file issuance, or downstream
predecessor acceptance. Even a successful return recommendation does **not**
change the original submitted attempt or automatically open a correction
case. Real corrections continue through the preexisting original-reviewer
`return -> remediation -> resubmission -> reverification` chain from 0050–0053.
No second correction state machine is created.

## 3. API and RareUI workbench

| Method | Path | Effect |
|---|---|---|
| GET | `/api/workbench/dhf/gate-decision-reviews` | Up to 100 currently delegated reviewer-scoped original intakes, otherwise empty. Show source graph fingerprint, original signer and any immutable opinion. |
| POST | `/api/workbench/dhf/gate-decision-reviews/{reviewId}/recommendation` | Current-password reauthentication, only recommend return/reject, scope lock, atomic signed-in recommendation/audit/outbox. |

The existing unified Workbench now contains **独立 Gate 复核** as an
additional section. It follows the same compact Finder/RareUI two-pane
design as reviewer attestations, shows original source identities and
frozen SHA-256, and provides only the two recommendation actions with
required reason and current password. It never claims to be the formal
enterprise approval system or shows a fake approved button.

## 4. Engineering safety / release blockers

Further work still required: independently enterprise-approved role and
signing SOP; real qualified corporate signatory and trust anchor / HSM /
certificates; official accept/return/reject decision CAS state machine;
per-requirement conditional grant with **actual** separately signed
authority, due date, limited direct `prepare/submit` scope, revocation and
verified closure; full G1–G9 authorized template lifecycle; CDW issuance,
training and department receipt. Browser visual/accessibility E2E and
concurrent mandate revocation pressure tests remain NO-GO.

No production business database, running service or port 8091 is modified
by this engineering-pilot development.

### Actual verification evidence

Record the *final* code revision, freshly migrated PostgreSQL 17 DB name,
migration count and checksum, actual integration result, Go/frontend builds,
API generation and discrepancies only after their execution. Failed
intermediate test runs must be disclosed, not counted as PASS.
