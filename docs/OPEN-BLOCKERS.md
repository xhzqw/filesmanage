# Open blockers

Status date: 2026-10-08 (Milestone 7 acceptance evidence collected).

| ID | Blocker | Impact | Needed from customer / next probe |
|---|---|---|---|
| BLK-01 | Official 中晟生物科技 Logo binary not yet supplied | Brand page shows explicit "标志待入库" placeholder per DEC-14; must not fake an official logo | Customer delivers verified logo asset (vector/raster) for import |
| BLK-02 | ~~DOCX editor engine~~ RESOLVED | — | ONLYOFFICE 8.2.2 (AGPL) self-hosted in Docker on 18080 with JWT; DO01–DO14-style E2E verified in M5 |
| BLK-03 | DWG preview requires a commercial SDK/license (ODA Teigha or similar) | DWG support stays licence-blocked; DXF (native 2D) is delivered | Customer decision: license purchase or accept DWG = documented unsupported |
| BLK-04 | ~~STEP/IGES converter toolchain~~ RESOLVED | — | gmsh + OpenCASCADE 7.8 installed in the worker; real geometry verified (544 triangles) |
| BLK-05 | Production port 8091 / systemd cutover not authorized | Delivery stays on dev port 18091; production switch requires explicit approval + backup/rollback drill | Explicit go-live authorization after acceptance gates |
| BLK-06 | 2026-10-08 ~22:00: host unreachable on 192.168.1.22 (100% packet loss, no ARP entry) for ~40 min | Implementation paused; resumed over 10.144.144.1 with no data or service loss | Customer to confirm the network path; add a second management route if this recurs |
| BLK-07 | Shared-host capacity: PostgreSQL instance (max_connections=100) and CPU shared with unrelated services (load 6–7) | §24.3 budgets met at ≤10 users, 10/11 at 30 users; 100/200 users pool-bound | Dedicated reference environment per SPEC PERF-003, or an approved capacity ADR |
| ~~BLK-08~~ | `/search` page was missing from the React app | RESOLVED | SearchPanel shipped (commit `3dd8682`): filters, result table, safe `<mark>` snippets, "1000+" capped total; browser-verified |

| BLK-09 | DO05 (DOCX header/footer/pagination compatibility report) has no sample to run | One §19 sub-item is unverified; the report itself exists in code | Customer supplies a DOCX with headers/footers, or the item is formally waived |
| ~~BLK-10~~ | AG12 CAD-saturation isolation | RESOLVED | `scripts/pe12_cad_saturation.py` measured twice (ratios x0.76-x1.31, absolute p95 < 11ms); the ratio gate is noise-sensitive at these absolute values |

Resolved this milestone:
- ~~Folder-filtered search/stats/export could bypass the visibility scope~~ → scope intersection + placeholder fix, 31/31 E2E.
- ~~Shares ignored include_descendants and were absent from direct permission checks~~ → unified share resolution.
- ~~CSV export clamped at 200 rows and fully buffered~~ → batched streaming export, 9/9 checks.
- ~~Search index never written; content search was a sequential ILIKE scan~~ → indexing pipeline + tsvector GIN search.
- ~~Concurrent lock acquisition 500'd~~ → file row lock serialisation.
- ~~Download ignored Range (no video seeking)~~ → http.ServeContent.
- ~~CAD worker failed on content-addressed blob conflicts~~ → adopt existing blob; stale tag check fixed.
- ~~M8 restore drill needed fresh evidence~~ → drill PASS (26 tables, 41 blobs) + 12/12 manifest unit tests.
