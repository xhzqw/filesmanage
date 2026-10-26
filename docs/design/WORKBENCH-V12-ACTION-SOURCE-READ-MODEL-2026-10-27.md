# Workbench V12 — Source-aware action overview

## Implemented scope

The workbench homepage reads four additional existing, ACL-scoped work sources
without introducing any new write path or approval authority.

| Source | Existing read endpoint | Eligibility |
| --- | --- | --- |
| File revision approvals | GET /api/approvals?scope=inbox&limit=1 | Server-reported pendingCount |
| DHF pilot review | GET /api/workbench/dhf/tasks | Assigned status=pending |
| DHF pilot verification | GET /api/workbench/dhf/verifications | readyToVerify, not verified |
| DHF pilot returns | GET /api/workbench/dhf/returns | canPrepare, no remediation or verification |

The CDW work list remains separately sourced from the existing CDW inbox.
Each source links back to its authoritative work view. This is a **source-aware
overview**, not yet a merged inbox or task-level unified index.

## Invariants

- Existing service endpoints enforce access rights; no new write endpoint.
- Read failures are shown as unavailable, never silently as zero.
- DHF trial review tasks are not represented as formal Gate approvals.
- At-limit DHF review counts show a lower bound, not an exact total.
- Cross-source duplicates cannot yet be excluded without qualified object IDs,
  so the UI does not present a misleading combined total.
- Actions remain in the original workflow, with its audit and responsibility chain.
- Home refresh uses the existing workbench invalidation cycle.

## Pending incremental work

1. Formalize source-qualified object identity, responsibility and deep links.
2. Cover remaining CDW/QMS/DHF work types with proper pagination semantics.
3. Build a permission-scoped server-side read model with normalized status,
   deadline, deduplication and sorting fields.
4. Validate source counts against their authoritative queues using the isolated
   browser test environment, then exercise actual approve/return/verify paths.
5. Do not promote to shared development without the write-flow browser gate.
