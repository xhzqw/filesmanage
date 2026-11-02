# Workbench V13 — dev integration, two-round review

## Baseline and scope

- Base: the existing server repository `origin/main` at `4d877b85`.
- Feature reviewed: `feat/workbench-v13-reviewed`, ending in `5b7d550d`.
- Merge: `a268b7ed` into the local `dev` integration branch, with two parents.
- No change to the production service (`:8091`) or Finder, login and brand
  resources. No database migration or backfill.

## Review round 1 — integration and architecture

Resolved three true merge conflicts while preserving the newer server-side
workbench fixes: browser test port allowlist (retains isolated `:18092`),
the remediation inbox's injected file metadata reader, and workbench canvas
CSS with the `.cdw-workspace` scope.

The server main already had a source-aware queue reader at
`web/src/pages/workbenchActionSources.ts`. Git rename-aware merging retained
that single reader and extended it with three source-qualified action links,
instead of duplicating a second read pipeline. Actual workflow decisions
remain controlled by their original backend.

## Review round 2 — deep-link safety

A stale or unauthorized DHF task link must **not** substitute another task
from the current actor's list. Each target queue now:

1. Initializes selected identity from the URL on the first render.
2. Selects only a matching item from the server-authorized list.
3. Displays an explicit unavailable notice when no match exists.
4. Does not infer any permissions from the URL.

Browser regression and static contract checks cover the stale-link handling.

## Verification and limitations

- Integrated Vite production build, TypeScript and loading contract: passed
  in an isolated remote worktree on `10.144.144.1`.
- Workbench scope and RareUI interaction contracts: passed.
- Project domain Go tests and server compilation: passed.
- A separate integrated browser canary could not be started because the
  process launch command was blocked by safety checks.
- The mutating Chrome acceptance suite was also blocked by safety checks.
  **These tests are not recorded as passed.**
- Deployment of the integrated candidate to the shared dev endpoint is
  therefore not covered by this review. The existing server was restored
  on `:18091`, with the original executable.

## Follow-up release gate

Before replacing the shared development service, run authenticated Chrome
read/write tests using the isolated database, including page autosave,
history back navigation, conflict resolution and a valid/invalid DHF
source-qualified deep-link test. Re-check Finder and original brand assets,
then verify exact runtime executable and rollback before promotion.
