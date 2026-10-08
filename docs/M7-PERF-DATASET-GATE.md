# M7 — SPEC §24.2 Performance Dataset Readiness Audit

Host: 192.168.1.22. Read-only database: filesmanage_perf.
Production port 8091 and business database filesmanage_v21 are out of scope.

## Measurement provenance

Executed on 2026-10-08 via PostgreSQL peer auth, target database
filesmanage_perf. The SQL starts a REPEATABLE READ READ ONLY transaction and
produces 12 gates. Dataset readiness is not API latency or capacity acceptance.

| Dataset gate | Observed | Minimum | Outcome |
| --- | ---: | ---: | --- |
| Folders | 10,000 | 10,000 | PASS |
| Files | 99,990 | 100,000 | FAIL |
| File versions | 399,960 | 400,000 | FAIL |
| Users | 1,001 | 1,000 | PASS |
| ACL entries | 59,994 | 50,000 | PASS |
| Indexed text files | 99,990 | 50,000 | PASS |
| Shares | 0 | 20,000 | FAIL |
| Favorites | 0 | 100,000 | FAIL |
| Max files in a hot folder | 10 | 5,000 | FAIL |
| Folders with 45–55 files | 0 | 1 | FAIL |
| Max folder depth (root counted) | 2 | 21 | FAIL |
| Max file version count | 4 | 1,000 | FAIL |

**Result: 4/12 PASS; 8/12 FAIL. Dataset readiness NO-GO.**

The SQL file is scripts/perf_readiness_audit.sql.
The fail-closed runner is scripts/perf_readiness_audit.py, intended to
return exit code 1 whenever distribution requirements are not met.
The SQL reports row-by-row outcomes without modifying the database.

## Remaining tasks

Seed a realistic and SPEC-accurate distribution, including hot folder >=5k,
50-file folder, depth >=20 edges, high-version files >=1k,
20k shares and 100k favorites. The files scripts/perf_dataset.sql and
scripts/loadtest.py are being edited separately; do not silently overwrite them.

After the dataset passes, continue the PE01–PE18 matrix: user concurrency
1/10/30/100/200, sustained 15/30 minute load, warm/cold response metrics,
p50/p95/p99 with errors, PG pool and query-plan analysis, CSV 100k export,
large file range IO, and DOCX/CAD resource isolation.

Passing this dataset gate is necessary but not sufficient for G-PERF.
