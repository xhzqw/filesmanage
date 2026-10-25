# DHF V0.8.0 — G1–G9 已发布模板依赖图完整性与 Gate 原子冻结（工程增量 2）

> document_id: DHF-ENG-V080-GRAPH-INTEGRITY-20261025-02
> version: v0.8.0-dev-02 · date: 2026-10-25
> status: draft / engineering-pilot only / corporate SOP NOT_APPROVED
> scope: 项目生效基线与 G1–G9 显式依赖；G5/G6 已签试点 Gate 的严格验收申请
> owner: engineering; DHF 项目模板发布责任人与企业质量签署责任人待企业指定
> source: `docs/design/DHF-DESIGN-DEVELOPMENT-DOCUMENT-CRITERIA-v0.1.md`, specified XMind SHA-256 `c16d3c70a0687d363c0d33322d16900f89b49ae02160afb3b9b7c3457a4b097b`
> parent contract: `docs/design/DHF-V080-STAGE-GATE-REVIEW-INTAKE-2026-10-25.md`
> implementation: `migrations/0058_dhf_stage_dependency_graph_guard.sql`; `internal/adapter/postgres/dhf_stage_gate_review.go`; `internal/application/dhf_stage_gate_review.go`; `internal/ports/dhf_stage_gate_review.go`; `web/src/features/workflow/DHFStageGateIntake.tsx`
> test source: `internal/adapter/postgres/dhf_pilot_submission_integration_test.go`
> release: **NO-GO** for formal `accepted` / `conditionally_released` / CDW issuance

## 1. Problem, source contract and decision

The nine original source stage headings identify **nine separate stage identities**.
They do not specify a complete approved DAG. In particular, G6 first transfer
and G8 transfer are different stages; repeated source file codes or stage
numbers confer no automatic dependency.

V0.8.0 intake migration 0057 already froze the *current* signed Gate's own
dependency list. That is insufficient against a separate active published
template that creates a longer circular chain, an unavailable predecessor
baseline, a silently changed SHA, or a limited-grant scope on a forbidden
action. Those are **whole-project** assertions, not facts a browser or a
single Stage template can guarantee.

Migration 0058 adds the database function
`dhf_pilot_verified_project_graph(project_id)`. Under the existing
SERIALIZABLE Gate review transaction, it reads **every active baseline** of
the same project, and its exact bound, separately published template. It
validates before returning any graph:

1. Project must be active. Active baselines require a published, personally
   approved template with SHA-256 equal to the exact stored policy bytes.
2. Each template must declare the matching stage ID, a nonempty requirement
   collection, an explicit dependencies array and explicit conditional flag.
   This is not permission to treat unreviewed XMind candidates as obligations.
3. Every dependency must declare a unique within-stage ID, actual G1–G9
   predecessor, allowed action and explicit conditional allowance. No
   self-dependency, duplicate dependency ID, or unknown action may pass.
4. **The predecessor must have its own active and approved published
   baseline in the SAME project.** Another project's matching stage or a
   retired template is not a substitute.
5. Conditional allowance is only a **published-template eligibility flag**.
   If asserted, the target template must explicitly allow it, and the
   guarded action must be `prepare` or `submit` only. This flag **is not**
   a signed conditional grant, a decision, or a delegated permission.
6. A recursive walk checks for circular paths across all stages; edges with
   the same source and predecessor are deduplicated only for cycle detection
   (not erased from the audit graph). This bounds expensive traversal even
   with many separately named obligations.

The normalized graph remains a list ordered by stage ID, with immutable
`stageId,templateId,policySha,positionState,conditionalTemplateFlag` and
every individually named `dependency`. An absent source baseline or edge
is not automatically fabricated or marked accepted. An explicitly named but
missing predecessor **fails closed** rather than becoming an unguarded step.

## 2. Transacted project graph snapshot

Migration 0058 adds nullable `project_graph_snapshot` and
`project_graph_sha` for backward-compatible reading of 0057 history.
New review intents always receive the complete graph from an independent
BEFORE INSERT trigger, **not from client-provided JSON**. The SHA-256 is
computed from PostgreSQL's normalized JSONB textual representation and
recorded with the original signed candidate, dependency snapshot SHA,
template version and frozen manifest. The deferred constraint trigger
requires the identical graph SHA in both immutable audit and trial-only
outbox, with `formalAccepted:false`.

Every read runs the source-signature/signer ACL boundary **before** accessing
the cross-stage graph. Only the actual assigned final Gate signer may view
this project's source-backed graph through the existing
`/workbench/dhf/gates/{submissionId}/readiness` API. The existing Gate
Workbench shows a compact per-stage dependency tree, conditional policy
flags as **not authorized**, and the frozen graph SHA after filing.
No user-provided dependency list, grant or policy hash is accepted.

## 3. Transaction, locks, threat model

Read readiness and write intake share source and graph validation logic; a
write starts a SERIALIZABLE transaction and locks the original submitted
attempt. Concurrent policy/baseline updates either yield a consistent
snapshot or a serialization/recheck failure. The DB performs an additional
independent graph build on INSERT, so a modified service client cannot
manually discard edges.

This does not turn the stage-position projection into formal `accepted`;
the original SQL constraints from 0043 remain intact. The only new
durable Gate-intake state remains `awaiting_enterprise_authority`.
The domain's separate **conditional grant** predicate (direct target, expiry,
approved actor, limited actions, individual remediation) is not supplied by
the template graph flag. No enterprise authority has been nominated or
issued, so formal/conditional execution remains **NOT_IMPLEMENTED / NO-GO**.

The graph itself can contain up to nine active stages, each with bounded
requirements/dependencies; graph traversal removes duplicate adjacency
before recursive cycle detection, not before frozen evidence capture.
SQLite or mocked policy tests cannot replace the real PostgreSQL trigger
integration tests.

## 4. Engineering test criteria and remaining NO-GO

The real PostgreSQL 17 integration suite MUST check at least:
`G1/G5` without invented numerical edges; G6 and G8 remain distinct;
explicit G8→G6 dependency valid; G7↔G8 cycle denied; predecessor that exists
only in another project denied; conditional scope for `issue_document`
denied; original Gate intake freezes and audits matching project graph SHA;
unaudited INSERT fails; stage state remains `submitted`, never `accepted`;
frozen candidate and original review obligations remain unchanged.

Corporate dependency approvals, an authorized signer and signing
certificate/CA/HSM, trusted timestamps, organization-wide policy version
publication, condition-by-condition corrective plans, valid limited scope,
expiry/revocation and final stage CAS decisions are **not** supplied here.
Live wide/laptop/narrow browser checks and concurrent load testing also
remain separate release gates. Production databases, running services and
port 8091 must not be modified by this pilot.

### Verification record

Tested implementation revision `6853e56`, final nine-stage regression
revision `07a4ba8`, 2026-10-25.
Real remote checkout: `10.144.144.1:/tmp/filesmanage-dhf-v075-99ade80`.
Brand-new isolated PostgreSQL 17 database:
`filesmanage_dhf_v063_integration_v080_graph_07a4ba8`.
No production database, live server or production port 8091 was modified.

| Executed validation | Observed status |
|---|---|
| Entire clean database migration from original schema to 0058 | **PASS — 60 migrations** |
| Separate migration checksum verification of same database | **PASS — 60/60** |
| Real PostgreSQL `TestDHFPilotRealPostgresSubmission` against final fresh database | **PASS — 8.08 seconds** |
| Real original Gate signed-candidate and reviewer ACL regression | **PASS** |
| G1–G9 in one project with only three explicitly authored nonnumeric edges | **PASS — 9 stages, 3 edges** |
| Project G1/G5 no invented numeric edges, distinct G6/G8 valid explicit transfer edge | **PASS** |
| 2-stage and 3-stage actual cyclic graphs: reject specifically for cyclic DAG | **PASS** |
| Missing same-project predecessor, unsigned template SHA, forbidden issuance-scope conditional edge, target template lacks conditional flag | **PASS** with **specific error-reason assertions** |
| 0058 graph snapshot and SHA frozen into one Gate intent, same SHA in audit and trial-only outbox | **PASS** |
| `go test ./internal/... -count=1` plus `go vet ./internal/...` | **PASS** |
| TypeScript check and Vite frontend production build | **PASS**, existing Three.js bundle warnings |
| `python3 scripts/gen_openapi.py --check` | **PASS — 144 paths, 174 operations, 131 schemas** |
| `python3 scripts/gen_acceptance_matrix.py --check` | **PASS — 126 IDs (123 PASS, 3 PARTIAL)** |
| True in-browser wide/laptop/narrow accessibility and concurrent policy publishing stress | **NOT_RUN** |

The first actual G1–G9 DB test on initial `d29d920` failed
with PostgreSQL `SQLSTATE 42702` (ambiguous PL/pgSQL local variable
`predecessor` versus recursive SQL graph column). Code fix `d1ba164`
renamed the PL/pgSQL variable, with a newly created clean database and real
PostgreSQL test passing at 5.90 seconds. Subsequent safety work in
`070b03f` / `6853e56` additionally deduplicated traversal adjacency to
bound recursive expansion, validated G5 specialty policy, constrained
conditional template applicability and asserted exact negative error
categories. The preliminary `6853e56` run passed at 5.80 seconds. The final
`07a4ba8` nine-stage regression passed at 8.08 seconds on a freshly created
60-migration database. The initial failure is not counted as PASS.

**Engineering approval is not corporate Gate authorization.** `accepted`,
`conditionally_released`, CDW release and downstream signing remain NO-GO.
