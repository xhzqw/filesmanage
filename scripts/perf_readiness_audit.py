#!/usr/bin/env python3
"""Fail-closed, READ-ONLY SPEC §24.2 performance fixture gate.

Run only on target 192.168.1.22 as root; targets dedicated filesmanage_perf.
Never applies schema/data changes or touches the running business database.
"""
from pathlib import Path
import os
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_GATES = {
    "ACLs",
    "favorites",
    "files",
    "folder_max_depth",
    "folders",
    "max_files_in_one_hot_folder",
    "max_versions_on_one_file",
    "ordinary_folders_45_to_55_files",
    "shares",
    "text_indexed_files",
    "users",
    "versions",
}


def main():
    if os.geteuid() != 0:
        raise RuntimeError("must run as root on target host to use local PostgreSQL peer auth")
    sql = (ROOT / "scripts" / "perf_readiness_audit.sql").read_text(encoding="utf8")
    proc = subprocess.run(
        ["runuser", "-u", "postgres", "--", "psql", "-X", "-A", "-t",
         "-F", "|", "-d", "filesmanage_perf", "-v", "ON_ERROR_STOP=1"],
        input=sql, capture_output=True, text=True, timeout=90,
    )
    if proc.returncode:
        raise RuntimeError("read-only dataset query failed: " + proc.stderr.strip()[-350:])
    results = {}
    for raw in proc.stdout.splitlines():
        parts = raw.strip().split("|")
        if len(parts) != 4:
            continue
        metric, actual, threshold, outcome = parts
        metric, actual, threshold, outcome = (
            metric.strip(), actual.strip(), threshold.strip(), outcome.strip()
        )
        if metric not in EXPECTED_GATES or metric in results:
            raise RuntimeError("unexpected or repeated audit gate")
        value, minimum = int(actual), int(threshold)
        expected = "PASS" if value >= minimum else "FAIL"
        if outcome != expected:
            raise RuntimeError("gate result differs from numeric criterion")
        results[metric] = (value, minimum, outcome)
    if set(results) != EXPECTED_GATES:
        raise RuntimeError(f"missing audit metrics: {sorted(EXPECTED_GATES - set(results))}")
    for metric, (value, minimum, outcome) in sorted(results.items()):
        print(f"{outcome:4}  {metric:35} actual={value:>9} minimum={minimum}", flush=True)
    failed = [metric for metric, item in results.items() if item[2] == "FAIL"]
    print(f"SPEC_DATASET_GATE: {len(results) - len(failed)}/{len(results)} PASS", flush=True)
    if failed:
        print("DATASET_NOT_READY: " + ", ".join(sorted(failed)), file=sys.stderr)
        return 1
    print("DATASET_READY_FOR_BASELINE", flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"PERF_AUDIT_ERROR: {exc}", file=sys.stderr)
        sys.exit(2)
