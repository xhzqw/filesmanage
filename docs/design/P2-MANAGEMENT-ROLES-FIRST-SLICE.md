# P2 first slice: management role delegation

Status: implementation of auditor and one-folder ACL manager only. Department
administrator, organization administrator, role templates and security-policy
editor remain unimplemented and MUST NOT be advertised as available.

## Scope and invariants

- `auditor`: read only `GET /api/permissions/audit`. No user directory,
  file, folder contents, ACL writes or effective-other-user explanation.
  Non-admin audit output is reduced to approved structured attributes.
- `permission_admin`: ACL read/create/revoke only on the **exact one folder**
  `scopeId`. Role defines a ceiling `allowedActions`. Manager-created
  ACLs MUST be `scopeOnly=true` (no descendants), use actions within one
  active binding, and expire no later than their role binding. No grants to
  the acting user or a group containing that user.
- Role assignment and removal are system-admin-only, never delegated. A
  delegated management role does not imply any of nine file action rights.
  System `is_admin` remains authoritative for full administrative actions.
- Expired or revoked role bindings are checked against the live repository
  for every management request. Revocation commits before any ACL cache
  epoch increment. The browser cannot substitute for server checks.
- Binding creation/deletion is audited transactionally as `role.assign` /
  `role.revoke`. Permission denials retain the independent HTTP audit path,
  including server-owned request ID.

## Persistence

`0012_management_role_bindings.sql` introduces a role binding table with
constrained role/scope combinations, optional expiry, actor attribution and
soft revocation. Audit records reuse the existing `audit_events` table.
No existing user is assigned delegated privileges by this migration.

## API and UI

- `GET /api/roles/me`: active own bindings.
- `GET /api/roles/bindings`: system-admin-only bounded binding list.
- `POST /api/roles/bindings`, `DELETE /api/roles/bindings/:id`: admin-only
  delegated role assignment/revocation.
- Admin UI at `/org?tab=roles`; non-admin delegated users get a separate
  limited workspace under `/org`, never an unfiltered organization directory.

## Deliberate follow-ups

- Department administrative scopes require descendant validation and
  modifications to every user/group mutation entry. Do not make them merely
  a UI label.
- Multi-folder scope inheritance, delegation of `manage_share`, group
  management roles, audit-export controls and large directory pagination
  are excluded in this first slice.
- Existing separate user agents edit UX concurrently. Their uncommitted
  changes must be preserved. All runtime testing is remote at dev port 18091;
  no production changes.
