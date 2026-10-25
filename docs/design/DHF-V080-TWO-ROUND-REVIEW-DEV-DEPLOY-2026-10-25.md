# DHF V0.8.0 — 双轮深度 Review 与隔离开发部署验收

> document_id: DHF-ENG-V080-REVIEW-DEPLOY-20261025-05
> date: 2026-10-25
> scope: `xhzqw/filesmanage`, Draft PR #1, branch `feat/dhf-v06-gate-pilot`
> status: engineering review deployment **GO**; formal enterprise Stage Gate/CDW release **NO-GO**
> developer review owner: project engineering; independent business QA/corporate issuer: NOT_YET_APPOINTED
> original design contracts: `DHF-V080-STAGE-GATE-REVIEW-INTAKE-2026-10-25.md`,
> `DHF-V080-G1-G9-PUBLISHED-GRAPH-INTEGRITY-2026-10-25.md`,
> `DHF-V080-INDEPENDENT-GATE-DECISION-REVIEW-2026-10-25.md`,
> `DHF-V080-CONDITIONAL-REMEDIATION-PROPOSAL-2026-10-25.md`

## Round 1 — security, source, transaction and performance

Reviewed existing migrations 0054–0060; Ed25519 signed trial candidates,
credential custody, graph, reviewer grant/revocation, per-obligation proposal,
append-only audit and outbox contracts, HTTP handlers and caller-scope
enforcement. The original `accepted` and `conditionally_released` Stage
states have no authorized transition or runtime bypass. An independent
recommendation or conditional proposal is **not** a corporate approval.

**Findings and fixes:**

1. Every published stage used to recalculate the entire project's DAG and
   eligible correction-owner list separately. Revision `ac518b0` caches
   verified full-project graph and owner set **only inside the current
   serializable request**; no cross-project or persistent stale cache.
2. The planning catalog advertised an eligible direct edge even after the
   current user had filed the one immutable plan for it. `ac518b0` hides
   already-filed own edges while preserving the immutable history. This
   is a UX projection only: the DB still independently rejects duplicates.
3. The planning catalog also offered edges whose predecessor had already
   been accepted; `ac518b0` now omits them. DB source checks remain
   authoritative even for malicious HTTP clients.
4. The frontend previously permitted invalid/past `datetime-local` values
   to reach `Date.toISOString()` and could throw before its request error
   handler. `ac518b0` now checks finite local timestamps, the 30-day
   maximum, per-obligation owner/requirement identity, correction descriptions
   and individual deadlines before request generation.

**Verified:** fresh PostgreSQL 17 isolated DB
`filesmanage_dhf_v063_integration_review2_ac518b0` migrated
**62/62**, real DB `TestDHFPilotRealPostgresSubmission`
**PASS (13.23 seconds)**, including original signing, audit, independence,
remediation, duplicate plan and revocation negative cases.

## Round 2 — RareUI ownership, responsive behavior and deployment

Reviewed all added DHF panes under the real controlled Workbench shell:
credential management, trial inbox, review attestation, original reviewer
reverification, independent Gate recommendation and conditional proposals.

**Findings and fixes:**

1. Static style governance reported hard-coded corner radii on the DHF panel
   and Finder's adjacent toolbar. Replaced with V3 shared tokens in
   `a021ffd` and `c181da8`.
2. Component ownership governance found list buttons and attestation
   checkboxes that bypassed the shared RareUI primitives. Migrated the six
   workbench panes to `RareButton`/`RareInput` in `a314c0c`; completed
   conditional plan list controls in `e9f5acd`.
3. Planning and independent Gate owner selection now use `RareSelect`,
   not native dropdowns, while preserving keyboard and OS accessibility.
4. Added `scripts/dhf_review_browser_smoke.mjs` in `e67fef1`
   as an explicit **credential-free read-only** live Chromium review check.
   It opens the actual React login, verifies live hashed Vite bundle delivery,
   no horizontal overflow or hidden login field at **1440/1024/760/390 px**,
   no startup exceptions, reduced-motion behavior and real 401 denial on
   all three unauthenticated Gate/conditional endpoints.

**Executed against actual isolated build and running service:** Vite + tsc
**PASS (701 modules)**; style governance **PASS (58 CSS files)**;
component ownership **PASS (110 TSX modules)**; RareUI interaction check
**PASS**; Go internal suite + `go vet` **PASS**;
OpenAPI generator and acceptance-matrix check **PASS**; 62-migration
checksum verification **PASS**.
Chromium live browser smoke **PASS** on both the local loopback candidate
`127.0.0.1:18095` and the final `127.0.0.1:18091`.
The existing Three.js large-bundle warning is not a build error.

### Actual Review deployment

| Field | Verified deployed state |
|---|---|
| Review URL | `http://10.144.144.1:18091` — permitted LAN only |
| Target host | `10.144.144.1` (`openclaw77`) |
| Source checkout | `/tmp/filesmanage-dhf-v075-99ade80`, feature branch |
| Runtime feature build | `e9f5acd` (subsequent `e67fef1` adds browser test only) |
| Filesystem run identity | `fm_dhf_review`, not root |
| DB login | peer-auth `fm_dhf_review`, privileges on isolated DB only |
| DB name | `filesmanage_dhf_v063_integration_review2_ac518b0` |
| Evidence Blob directory | `/tmp/filesmanage-dhf-review-e9f5acd/blobs` |
| Browser entry | `/login`; only synthetic DHF fixture accounts |
| Health | `GET /health/ready` — 200 `{"ok":true}` |
| Auth boundary | unauthenticated conditional plan GET — 401 |
| Audit | synthetic test fixture and append-only historical trials; not corporate approval |
| Production port `8091` | Untouched |
| Original business checkout / `filesmanage_v21` database | Untouched; old dev process stopped for 18091 port switch |
| PR merge | Still Draft, unmerged |

Original live dev checkout
`/root/repository77/filesmanage-v21` had unrelated uncommitted
`CDWWorkbenchHome.tsx`, `DHFHomeProjects.tsx`,
`cdwWorkbench.css` changes. Those were explicitly preserved.
The original `18091` service (PID 1973622) had zero established socket
connections at handoff and was gracefully terminated by **exact executable
identity and listening PID check**. The separate candidate was launched
with a restricted OS/PG role and its own isolated database instead.
No SQL migration, data copy or code deployment was made to the original
business checkout/database.

The demo fixtures use test identities; `admin` from the original
business database does not automatically exist or authenticate in this
isolated Review database. This is intentional isolation, not a password
reset to the existing dev server.

### Rollback contract

The original business checkout, binary, DB and server settings are intact.
If Review is rejected, an operator may stop only the PID recorded in
`/tmp/filesmanage-dhf-review-e9f5acd/review-18091.pid` after verifying
its executable identity, then restart the original dev server using the
existing protected runbook under
`/root/repository77/filesmanage-v21/scripts/run-dev.sh`, and verify
`/health/ready`. Review records remain in the isolated Review DB for
postmortem. No production 8091 cutover is implied.

### Explicitly NOT_RUN

Authenticated end-to-end Chrome interaction through all DHF panels
(including publishing a plan), multi-operator collision testing on the
running review service, ONLYOFFICE authenticated save/callback in the
isolated review DB, real corporate signature authority and CDW
issuance/receipt remain separate gates. Four-width Chromium verification
above was a **real login-screen/browser/unauthorized-endpoint smoke**, not
a claim that all authenticated forms passed visual QA.

## Release determination

**GO for user-operated dev Review at isolated `18091`; NO-GO for
enterprise formal acceptance, `accepted`, `conditionally_released`,
CDW business issuance or production deploy.**
