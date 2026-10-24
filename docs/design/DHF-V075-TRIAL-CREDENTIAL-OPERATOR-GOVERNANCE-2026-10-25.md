# DHF V0.7.5 — 试点签署凭证管理与操作员授权治理

> document_id: DHF-ENG-CREDENTIAL-CUSTODY-20261025-01
> version: v0.7.5-dev-03 · date: 2026-10-25
> status: draft / engineering pilot only / enterprise authorization NOT_APPROVED
> scope: G5/G6 trial Gate candidate signer public-key custody and delegated operator lifecycle
> responsible: engineering maintainer; corporate quality owner and signature authority UNASSIGNED
> source: `DHF-V075-TRIAL-CREDENTIAL-TRUST-2026-10-25.md`; previously confirmed sequential review + signer separation
> implementation: `migrations/0056_dhf_pilot_credential_operator_governance.sql`,
> `internal/application/dhf_pilot_credential_governance.go`,
> `internal/adapter/postgres/dhf_pilot_credential_governance.go`,
> `internal/httpx/dhf_pilot_credential_governance.go`,
> `web/src/features/workflow/DHFCredentialManagement.tsx`
> reference tests: `internal/adapter/postgres/dhf_pilot_submission_integration_test.go`
> business approval: **NONE — formal Stage Gate acceptance remains NO-GO**

## Scope and authority separation

The existing 0055 identity binding only guaranteed `registered_by != signer_id`.
That inequality is not issuer authorization. Migration 0056 adds a separate
append-only, **out-of-band approved trial operator grant** with its own approver
(not the operator, not the credential signer), distinct audit event,
`valid_from`, `expires_at`, 30-day maximum mandate and terminal revocation.
An ordinary application admin flag, stage reviewer assignment and membership
do **not** create or renew an operator mandate.

No management API can issue an operator grant or revoke its independent
approval. This requires a separately controlled, audited database-operator
procedure and an independently empowered approving person. **There is no
enterprise signing authority designated yet**: the engineering test mandate is
only a simulated fixture. A database superuser can still bypass the
application's trust boundary; that must be addressed at enterprise adoption.

The DB enforces:

- Credential registration or state-event insertion requires a currently active
  operator grant, with approver separate from the credential signer and
  a live, non-disabled approver and operator.
- Grant, credential and lifecycle history are immutable. Emergency grant
  revocation is an append-only audited event, never a `DELETE` or in-place
  policy rewrite.
- Registered public key must be Ed25519 length 32, fingerprint unique and
  purpose exactly `dhf.pilot.gate.candidate`; new credential validity cannot
  exceed 30 days. Historical 0055 rows are preserved with `NOT VALID` lifetime
  constraint, which still checks every new record.
- Lifecycle state transitions `unactivated -> activate -> suspend` and
  `suspend -> activate` are legal; `revoke` and `replace` are terminal.
  The original signing evidence remains verifiable after revocation.
- API registrations and lifecycle actions are bound to an immutable
  `idempotency_key + request_sha` tuple with per-actor uniqueness. A different
  body reusing a key is a conflict, not a second issuance.

## Interfaces and identity controls

| API | Authorization | Effect |
|---|---|---|
| `GET /api/workbench/dhf/credentials` | Current valid delegated operator, authenticated account | List at most 100 credentials registered by this operator; everyone else receives `canManage=false` and empty list |
| `POST /api/workbench/dhf/credentials` | Independent operator grant, account password reauthentication, active assigned G5/G6 Gate signer, externally pinned Ed25519 public key | Register an **unactivated trial-only** credential and atomic audit, with an exact retry identity |
| `POST /api/workbench/dhf/credentials/{id}/events` | Independent operator grant, current password, target signer distinct from operator/approver, allowed state transition | Append activate/suspend/revoke/replace + audit atomically |

The password is never stored with the credential; unsuccessful
reauthentication emits an audited denial. Credential operations share the
existing persisted 15-minute password-denial limit with DHF review sign-offs.
Each write is a SERIALIZABLE transaction. No private signing key is accepted by
the API or displayed in the browser: only a separately trusted Base64 public
verifier can be registered. Even a registered, active credential must pass the
original assigned-Gate personal signature, frozen evidence, live Preview ACL
and external public trust-anchor checks.

The Workbench adds one `签署凭证` page reusing the existing two-pane RareUI
shell; the list is the primary view. The operator can register an externally
trusted public verifier, see fingerprint and validity, then record explicit
reasoned lifecycle events with fresh password verification. Unapproved actors
see no sensitive credential list. No new approval center, duplicate signer
authority model or private-key browser upload is introduced.

## Acceptance and release gate

Independent real PostgreSQL 17 tests are required to cover fresh schema,
operator grant audit, public registration, incorrect password denial and audit,
same-key replay, mutated request-key conflict, activation, suspension denial,
terminal revocation, original Gate signed candidate, emergency delegation
revocation and post-revocation operator denial.

Critical outstanding items: corporate SOP and approver nomination;
external identity vetting and private-key possession attestation at issuance;
corporate CA/HSM custody, non-repudiation and trusted time service;
trusted operator provisioning UX and emergency revoke workflow;
production migration review, zero-downtime load/performance testing;
live browser width/accessibility validation, and formal Stage Gate
`accepted` + CDW training/issuance policy. **None can be waived by a successful
engineering integration run.**

### Verification evidence

Exact remote test commands, database name, source revision, migrations count,
checksums and pass/fail results are recorded in the implementation PR.
The app's production databases, production port 8091 and running services must
not be altered by this engineering trial. Formal stage approval remains
**NOT_IMPLEMENTED / NO-GO**.
