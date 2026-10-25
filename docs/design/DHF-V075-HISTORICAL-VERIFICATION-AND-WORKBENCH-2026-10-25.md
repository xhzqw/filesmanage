# DHF V0.7.5 — 历史独立验签与统一工作台可见性

> document_id: DHF-ENG-GATE-HIST-20261025-01
> version: v0.7.5-dev-02 · date: 2026-10-25
> status: engineering development report / trial only / NOT_APPROVED for enterprise release
> scope: G5/G6 总 Gate 试点候选与签署凭证状态，沿用现有签审工作台
> responsible: engineering maintainer; authorized enterprise signature policy owner UNASSIGNED
> source: original nine-stage DHF source mapping; development documentation standards; DHF V0.7.4–V0.7.5 pilot contracts
> implementation: `internal/application/dhf_pilot_gate_history.go`,
> `internal/adapter/postgres/dhf_pilot_gate_history.go`, `internal/httpx/dhf_pilot_gate_history.go`,
> `web/src/features/workflow/DHFReviewAttestationInbox.tsx`
> tests: `internal/application/dhf_pilot_gate_history_test.go`,
> `internal/adapter/postgres/dhf_pilot_submission_integration_test.go`
> approval: engineering tests only. **No official Stage Gate accepted authority granted.**

## Historical cryptographic verification, not contemporary credential validity

The read-only command reconstructs the original deterministic, domain-separated
Ed25519 signing payload from the **database-persisted frozen candidate** and verifies
both the SHA-256 public-key fingerprint, SHA-256 payload digest and original
64-byte Ed25519 signature against the original 32-byte public key. It does not
accept a public verifier, candidate identity or verdict from the request.

- Migration 0054 candidates have no credential ID and use canonical **V1**.
  Such a record remains independently verifiable but is displayed as
  `legacy_unbound`, never as an enterprise-authorized signature.
- Migration 0055 candidates use canonical **V2**, including
  `credentialId` and `trustedKeySha`. Attempting to change the credential,
  review signer, submission or frozen policy/manifest changes the reconstructed
  message or its digest and fails verification.
- The current credential status (`activate`, `suspend`, `revoke`,
  `replace`, `expired`, `not_yet_valid`) is displayed independently.
  Revocation blocks future signatures but does not turn a mathematically
  correct historic signature into an invalid one.
- Signature validity is a cryptographic fact, not proof of enterprise
  certification, corporate approval or trusted timestamp provenance.
  `trialOnly:true` and `formalAccepted:false` are explicit invariants.

## Read interface and authorization

`GET /api/workbench/dhf/gates/{submissionId}/verification`

1. Requires an authenticated, enabled user still explicitly assigned as the
   `__gate__` reviewer for the identified frozen submission.
2. Requires current project membership and rejection of the original submitter.
   Admin UI or API flags cannot substitute for these conditions.
3. Reads under a snapshot transaction, without changing signatures, Gate states,
   credential lifecycle, audit events or outbox.
4. Returns `candidateStatus`, `cryptographicValid`, `signatureDomain`,
   `signatureReason`, the historical credential ID, public-key fingerprint,
   signing payload digest, current credential status, and any prerequisite codes.
5. An unissued candidate returns `not_issued` and explicit missing preconditions
   (missing/unsigned obligations, unverified corrections, inactive credentials).
   It **does not** synthesize a passed Stage Gate.
6. `Cache-Control: private, no-store`; requester cannot choose a different
   signature key or use this read endpoint to sign/approve an artifact.

The UI is integrated into the existing `DHFReviewAttestationInbox` Gate detail
panel, not a new task center. It keeps the existing RareUI compact two-pane layout
and displays historical signature status separately from current credential
lifecycle and password reauthentication.

## Verification evidence and limitations

Target machine: `10.144.144.1`; isolated checkout at
`/tmp/filesmanage-dhf-v075-99ade80` based on implementation
`5e56849`; dedicated PostgreSQL 17 database
`filesmanage_dhf_v063_integration_v075_history_5e56849`.

| Check | Observed |
|---|---|
| Complete isolated migration from an empty database | **PASS — 57 migrations** |
| Independent checksum validation | **PASS — 57/57** |
| Real PostgreSQL Gate candidate and credential-history integration | **PASS — 2.57 seconds** |
| Non-Gate reviewer and anonymous subject history denial | **PASS — assertions in real DB test** |
| V1/V2 signature, substituted manifest/credential, forged signature and wrong key | **PASS — Go unit tests** |
| Post-revocation historical Ed25519 verification with current `revoke` state | **PASS — real DB test** |
| `go test ./internal/... -count=1` | **PASS** |
| `go vet ./internal/...` | **PASS** |
| TypeScript and Vite production build | **PASS — 697 modules**, existing Three.js bundling warnings |
| OpenAPI regeneration, schema check | **PASS — 140 paths, 169 operations** |
| Acceptance-matrix consistency check | **PASS — 126 IDs (123 PASS, 3 PARTIAL)** |
| Production deployment / 18091 live workbench / three-size browser visual test | **NOT_RUN** |

The original business checkout, business database, production port 8091 and
existing CDW distribution records were not changed.

## Remaining blocking items

Corporate certificate issuance and genuine independent authorization, secure
private-key handling (CA/HSM), trusted timestamps, revocation propagation,
formal signatory policy, audited credential management UI, full evidence-history
chain checks outside cryptographic signature bytes, browser accessibility and
multi-size UX, concurrent-issuance stress, and physical Blob disaster recovery
remain unqualified. These are not waived by an engineering test passing.

**Verdict: historical pilot signing evidence readable and verifiable by the
scoped Gate reviewer; formal corporate Stage Gate acceptance remains NO-GO.**
