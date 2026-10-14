# Permissions P0/P1 — Deep Security Review

Date: 2026-10-10. Scope: existing Organization ACL workspace and effective-permission explanation/audit, plus their direct dependencies in shares, sessions and organization mutation flows. This is a **source/code-level review**; it is not a claim that the complete product has undergone a penetration test.

## Authorization invariants (SPEC-v2.1 §§2.2–2.6)

1. Nine file actions are **not** management capabilities. ACL write/read of other subjects requires admin until delegated roles are implemented.
2. Share creation requires admin or resource ownership (future: explicit `manage_share` delegation); an ordinary owner may only grant the passive actions they already hold. Mere list/preview access must **not** imply resharing.
3. Descendant shares by non-admin owners are denied until delegation scope and descendant proof are defined. A parent-folder grant alone is insufficient to assert rights in every child.
4. Effective explanations come from the server's authorization resolver, never a client-side recomputation. Disabled/first-sign-in users have no *currently exercisable* file actions.
5. After a successful DB commit affecting access, next requests cannot see stale permission/session cache entries. A failed commit must not trigger optimistic invalidation.
6. Admin-only audit queries are bounded keyset pages; no credentials/file body in audit records.

## Confirmed findings and code remediation

| ID | Severity | Root cause and impact | Remediation / regression |
|---|---|---|---|
| PS-01 | **High** | `CreateShare` only checked `list` on folders / `preview` on files. An ACL viewer could reshare another owner's resource and grant `download` without holding it, violating SPEC §2.4. | Check owner/admin status, validate each requested passive action against actual permission, disallow non-admin descendant sharing pending scoped delegation. `TestShareRequiresResourceOwnershipAndNoPrivilegeAmplification`. |
| PS-02 | Medium | `RevokeShare` bumped ACL cache epoch **before** the transaction committed. A competing read could cache old access after the bump. | Commit first, then bump. Existing share revocation tests and complete Go suite. |
| PS-03 | Medium | `SetUserDisabled` dropped cached sessions and bumped epoch **before** commit. | Commit first, then bump and evict cached sessions. |
| PS-04 | **High** | `ResetUserPassword` deleted persistent sessions but did not invalidate the in-process session cache. Previously authenticated tokens could temporarily remain usable. | Post-commit epoch bump + per-user cache eviction. Cache entries now carry the epoch captured **before** the DB read, blocking stale concurrent cache reinsertions. `TestCachedSessionInvalidatedAfterCredentialResetAndSuspension` and remote `go test -race`. |
| PS-05 | Low | Sorting explanation sources could mutate repository-backed `Share.Actions` slices in tests/other readers. | Copy share action slices before sorting. |
| PS-06 | Low | Permission-change audit did not include account creation/password reset. | Add `user.create`, `user.password_reset` to both PostgreSQL and test adapters and to UI labels. |
| PS-07 | Low | Effective-permission view could retain stale results after a successful ACL edit; password-change-required accounts could be displayed with hypothetical rights. | Invalidate/re-query explanation when grant list refreshes, model `subjectRequiresPasswordChange` in API and OpenAPI. Guard audit pagination from out-of-order refresh results. |

## Security and regression verification

- Mandatory: remote-only `scripts/build.sh --with-tests` (front-end/Go compilation, vet, architecture, OpenAPI drift, migration checks and full Go tests).
- Focused: `go test -race ./internal/application ./internal/httpx`; `go test ./internal/application -run 'TestShareRequiresResourceOwnershipAndNoPrivilegeAmplification|TestCachedSessionInvalidatedAfterCredentialResetAndSuspension|TestPermissionExplanationUsesAuthorizationSources'`.
- Live read-only: `node scripts/permissions_p1_check.mjs` and `node scripts/permissions_p1_browser_check.mjs` on remote dev target with admin secret **kept on the server**.
- Negative paths must show *no share records and no successful audit events* on denied delegation attempts. Do not run ad-hoc destructive tests against the user dataset.

## Unresolved scope / explicit nonclaims

- The broader management-capability roles (`permission_admin`, departmental admin, auditor, role delegation) are still **P2** and are NOT implemented. Admin-only ACL read/write remains the gate.
- The audit dashboard is an **access-change event reader**, not a full investigation-grade ledger. Denied attempts, before/after state, IP hashing, actor/request correlation, retention controls and export policy require an independent design and tests.
- File-level shares are not represented in the **folder-level** effective-explanation endpoint; no assertion of complete per-file effective rights is made.
- Very large audit datasets may need measured query-plan investigation of the event-type filter and a targeted index; none has been added without benchmark evidence.
- A complete multi-client concurrent transaction security test and production penetration testing remain outstanding. Normal build/browser success does not establish those properties.
- Remote dev is port 18091. Production port 8091 is out of scope and must never be restarted by this work.
