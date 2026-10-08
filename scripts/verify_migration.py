#!/usr/bin/env python3
# Static-only preflight; real PostgreSQL execution is mandatory before DB gate passes.
from pathlib import Path
source=(Path(__file__).resolve().parents[1]/"migrations/0001_core.sql").read_text()
checks={
 "append-only-version-number":"UNIQUE(file_id,seq)" in source,
 "rollback-attribution":"rollback_target_seq" in source and "rollback_from_seq" in source,
 "pending-uniqueness":"uq_pending_approval" in source,
 "active-sibling-uniqueness":"uq_folder_active_name" in source,
 "raw-storage-separated":"CREATE TABLE blobs" in source,
 "read-fts":"to_tsvector('simple',spaced)" in source,
 "privacy-personalized":"CREATE TABLE favorites" in source,
 "shares":"CREATE TABLE shares" in source,
 "model-derivatives":"CREATE TABLE model_derivatives" in source,
 "office-save-events":"CREATE TABLE office_save_events" in source,
 "recovery-queue":"CREATE TABLE outbox_jobs" in source,
}
for key,good in checks.items():print(("PASS" if good else "FAIL"),key)
if not all(checks.values()):raise SystemExit(1)
print("STATIC DDL CONTRACT PASS; actual PostgreSQL migration NOT YET EXECUTED")
