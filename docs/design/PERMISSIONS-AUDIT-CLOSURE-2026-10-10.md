# P1.5 — Permissions security audit trail

Date: 2026-10-10. Scope: the **access-changing** ACL, internal share,
account and workgroup-member operations on filesmanage v2.1, not every
business-domain event in the product.

## Persisted event contract

- Permission mutations write their audit event in the **same PostgreSQL
  transaction** as the mutation. Audit persistence failure aborts the
  business transaction. Do not put these sensitive writes behind the older
  best-effort `audit(...)` helper.
- Mutation details include `before` and `after`, with only a reviewed
  allowlist of grant/share/membership/account-security attributes:
  target IDs, recipient IDs, file actions, scopes, expiry, disabled flag,
  password-change-required flag and session-revocation state.
  Never store passwords or hashes, session/cookie values, file content,
  document names or raw request JSON in these snapshots.
- Authenticated **403** responses on specifically allowlisted
  authorization-management routes persist a separate `denied` audit event
  outside the rolled-back mutation transaction. The record includes
  actor ID, route-defined event type, bounded route target, opaque request
  ID and `reason=forbidden`. It does not include the supplied payload.
- An opaque, cryptographically generated request ID is created on the
  server for every `/api` request. It is exposed to the client as
  `X-Request-ID` and reused by audit events generated in that request.
  Inbound `X-Request-ID` values are **never trusted**.
- `GET /api/permissions/audit` remains admin-only, keyset paged,
  read-only and filtered by the audited operation allowlist. Its entries
  now expose `requestId` to correlate feedback with the stored record.

## Correctness and fault model

- A denied operation must not commit any mutation. Its independent
  audit transaction must not be rolled back with the denied work.
- A storage outage while recording a successful security-sensitive write
  causes the business operation to fail, avoiding an unlogged success.
  The in-memory unit tests assert error propagation and that `Commit`
  is not called; actual transactional atomicity is a PostgreSQL contract.
- An outage while recording a **denied** attempt is reported to the
  server log without disclosing request contents, but does not change the
  already-denied HTTP response. It must not grant access.
- Successful audit records are not individually tamper-evident. Database
  superusers can still modify records, so archive/immutability, retention,
  export access policies and external verification remain future work.

## Known limits

- This change deliberately audits authorization-management refusals, not
  every failed read or all authentication failures. Login rate limiting,
  expired sessions, invalid origin, unknown IDs and raw field validation
  are separate telemetry/audit categories.
- Existing non-permission business actions still use the legacy
  best-effort helper. The present fail-closed guarantee applies only to
  the listed authorization-changing use cases.
- Distinct PostgreSQL concurrent-write rollback tests, audit tampering
  prevention, hashed client-origin attribution and incident export
  workflows remain outside P1.5. They must not be claimed as completed.
- Preserve concurrent Agent edits and develop/test only on
  `10.144.144.1:18091`, never production port `8091`.
