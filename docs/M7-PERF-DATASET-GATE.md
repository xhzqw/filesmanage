# M7 — SPEC §24.2 Performance Dataset Readiness + PE01–PE18 evidence

Host: 192.168.1.22 (reachable via 10.144.144.1 during a LAN outage on 2026-10-08
evening; see OPEN-BLOCKERS BLK-06). Read-only audit database: `filesmanage_perf`.
Production port 8091 and business database `filesmanage_v21` are out of scope for
the load runs; upload/range checks that touch real media use isolated rows in the
perf database only.

## Measurement provenance

Executed on 2026-10-08 via PostgreSQL peer auth against `filesmanage_perf`,
seeded by `scripts/perf_dataset.sql` (fail-closed: it refuses to run unless
`current_database() = 'filesmanage_perf'` and the schema is empty). The readiness
audit (`scripts/perf_readiness_audit.py` + `.sql`) starts a REPEATABLE READ READ
ONLY transaction and reports 12 gates row by row without modifying data.

## Dataset gate (PE01)

| Dataset gate | Observed | Minimum | Outcome |
| --- | ---: | ---: | --- |
| Folders | 10,000 | 10,000 | PASS |
| Files | 100,402 | 100,000 | PASS |
| File versions | 402,564 | 400,000 | PASS |
| Users | 1,001 | 1,000 | PASS |
| ACL entries | 50,305 | 50,000 | PASS |
| Indexed text files | 100,402 | 50,000 | PASS |
| Shares | 20,000 | 20,000 | PASS |
| Favorites | 100,000 | 100,000 | PASS |
| Max files in a hot folder | 5,000 | 5,000 | PASS |
| Folders with 45–55 files | 350 | 1 | PASS |
| Max folder depth (root counted) | 21 | 21 | PASS |
| Max file version count | 1,000 | 1,000 | PASS |

**Result: 12/12 PASS — DATASET_READY_FOR_BASELINE** (was 4/12 before the
generator was completed). The distribution also carries the SPEC §24.2/PERF-DATA-02
shapes the audit does not count: expired and scope_only ACLs, revoked/expired
shares, include_descendants folder shares, per-user unique favorites across two
workgroups, CJK-spaced text corpora of two selectivities (预算 ≈ 80%,
设备验收 ≈ 20%), and SPEC §12.2 export edge-case file names (formula-leading,
comma, quote, tab, emoji).

## Endpoint budgets under load (PE02/PE03, §24.3 mix, warm)

Reference: 8 vCPU / 16 GiB is the SPEC's recommended dedicated environment. This
host is **shared** with unrelated services (load average 6–7 before the tests),
so absolute numbers carry that caveat; the shape of the curve and the bottleneck
analysis are the transferable results. p95 budgets from §24.3.

| Users | RPS | Server RSS max | Verdict |
|---:|---:|---:|---|
| 1 | 8.5 | 37.5 MB | 11/11 PASS |
| 10 | 57–69 | 44.4 MB | 11/11 PASS |
| 30 | 62–69 | 47.3 MB | 10/11 PASS (search p95 over budget, see below) |
| 100 | 60–76 | 43.9 MB | over budget on latency endpoints (pool-bound, see below) |
| 200 | 55 | 46.9 MB | over budget; one 503 observed at pool exhaustion |

Machine-readable reports: `.secrets/perf/pe03-ladder*.json`, `.secrets/perf/pe02-sustained30.json`.

### PE02 sustained run (30 users × 15 min, §24.3 mix)

`users=30 duration=900.6s rps=111.0 rss_max=41884kB conns=28` — 11/11 endpoint
classes measured, 72,680 requests, zero 5xx, server RSS flat across the window.

| Endpoint | p50 | p95 | p99 | p95 budget | Verdict |
|---|---:|---:|---:|---:|---|
| /api/files | 53.3 | 272.6 | 404.0 | 800 | PASS |
| /api/folders/tree | 149.8 | 298.5 | 394.4 | 1200 | PASS |
| /api/search | 760.8 | 1796.6 | 2279.6 | 1500 | OVER |
| /api/stats | 1386.4 | 2142.5 | 2616.0 | 2500 | PASS |
| /api/exports/files.csv (TTFB) | 17.4 | 78.1 | 118.4 | 2000 | PASS |
| /api/shares | 64.4 | 144.8 | 208.3 | 800 | PASS |
| /api/favorites | 95.2 | 193.8 | 259.4 | 800 | PASS |
| /api/me | 17.5 | 81.6 | 124.4 | 350 | PASS |
| /api/files/{id} | 41.8 | 121.6 | 170.7 | 800 | PASS |
| /api/files/{id}/versions | 41.5 | 123.0 | 181.5 | 800 | PASS |
| /api/files/{id}/lock | 48.8 | 130.3 | 186.6 | 900 | PASS |

### Bottleneck analysis and what was done

1. **Database pool (10 connections) was the first wall.** Throughput plateaued at
   ~55 RPS from 10 users upward and `/api/me` (a trivial session query) showed
   p50 814 ms at 100 users — pure queueing. `FILESMANAGE_DB_MAX_CONNS` now tunes
   the pool (default 10, perf instance ran 25); at 25 connections the plateau
   moved to ~68–76 RPS. PostgreSQL `max_connections=100` is shared with other
   projects on this instance, so the perf pool was deliberately not raised
   further; a dedicated reference environment is the SPEC's answer (PERF-003).
2. **Search was a sequential ILIKE scan over `file_text`** (p95 1.9 s at 8
   users). Rebuilt as: tsvector GIN match with the CJK-spaced phrase
   (`phraseto_tsquery('simple', SpaceCJK(q))`), an EXISTS form that lets the
   planner drive from the export order index with early termination, a narrow
   two-phase page query, and a hard-capped exact total (SPEC §10.2 permits a
   capped total; the API returns at most 1001 meaning "1000+"). Worst-case broad
   term: ~0.5 s single-request, page SQL 162 ms (EXPLAIN, PE14).
3. **Stats ran seven scans of the 100k-row file table** (p50 1.37 s). Collapsed
   into one FILTER summary scan plus one GROUPING SETS breakdown scan: p50
   0.45–0.55 s single-request. Budget p95 2500 ms holds at 30 users.
4. **CSV export materialised the whole result** (200-row clamp, full buffer).
   Now a batched stream: ordered ids with filters only (index-served), the
   visible folder path map resolved once, 500-row batches by primary key.
   100,402-row export: first byte 1.1–1.6 s warm (budget 2000 ms), full transfer
   ~6.2 s, flat RSS. 9/9 contract checks PASS (`scripts/perf_csv_export_check.py`).
5. **Concurrent lock acquisition raced** (16 parallel acquires produced 500s).
   `AcquireLock` now takes the file row lock inside its transaction (SPEC §7.2)
   and `ForceReleaseLock` treats a missing row as an idempotent no-op; 16/16
   parallel acquires now return 201.

Remaining known gap: search p95 exceeds the 1500 ms budget at 30 sustained users
(1796.6 ms; ~3350 ms in the ladder runs, which competed with other commands).
The page SQL itself is 162 ms; the remainder is the capped count plus CPU
contention with unrelated services on this shared host. Closing it needs the
SPEC's dedicated reference environment (PERF-003) or a materialised count.

## Other PE checks

| Check | Result | Evidence |
|---|---|---|
| PE04 revocation immediacy | PASS | `scripts/m7_security_e2e.py` (grant + share revoke visible on the next request) |
| PE05 N+1 | PASS | all list/search/stats/export paths are single-statement or 1 + N/500 (EXPLAIN, PE14); 50-row page = 0.85 ms with index scans |
| PE06 Chinese search | PASS | tsvector phrase queries match 100,392 rows for 预算, 19,979 for 设备验收; snippets returned; totals exact/capped |
| PE07 CSV 100k export | PASS 9/9 | TTFB 1.1–1.6 s, BOM, header, quoting, formula neutralisation, no storage-path leakage |
| PE08 10×100MB uploads | PASS | 10/10 committed, downloads checksum-verified, 23.5 s wall, no 5xx, RSS flat |
| PE09 MP4 Range | PASS 10/10 | 206 for ranges, 416 unsatisfiable, suffix/single-byte ranges, sha header, preview reachable (fix: `http.ServeContent`) |
| PE10 Office sessions | PASS 12/12 | 5 sequential sessions open 7–43 ms, unique document keys, clean cancel |
| PE11 CAD conversion | PASS | STEP → STL 108,016 bytes / 544 triangles; IGES bearing → 555,896 bytes / 2,148 facets, hammer → 144,873 bytes; blob-conflict path fixed |
| PE12 CAD worker saturation vs login/list p95 | MEASURED | two runs: ratios x0.76-x1.31, absolute p95 < 11ms (73x inside budget); the ratio gate is noise-sensitive at these absolute values on a shared host |
| PE13 pool behaviour | measured | pool wait dominates at ≥100 users (see analysis); no unbounded waits, controlled 503 under exhaustion |
| PE14 query plans | collected | `EXPLAIN (ANALYZE, BUFFERS)` for list/hot-folder list/search/export/stats saved in TEST-EVIDENCE.md §M7 |
| PE15 WebGL leak | PASS | CDP-measured 20-cycle load/teardown: 544 triangles every cycle, late-window teardown slope 0.13-0.19 MB/cycle (budget 0.5), heap returns to the 8.6 MB floor after warmup; doc-only control 0.000 MB/cycle late slope (`scripts/pe15_heap_growth.mjs`) |
| PE16 three viewports | PASS | /doc interactive 168/152/2 ms at 1440x900/1366x768/1920x1080 (budget 2.5 s); no overlap in any viewport (VS04); STEP model page renders 544 triangles |
| PE17 dependency injection | PASS (scoped) | unreachable editor: session open stays non-blocking, preview/download of the DOCX both 200, `/health/ready` 200; PostgreSQL restart deliberately not injected (shared instance) |
| PE18 machine-readable reports | PASS | every loadtest run wrote JSON to `.secrets/perf/` with per-endpoint p50/p95/p99, RPS, RSS, connections and error classes |
