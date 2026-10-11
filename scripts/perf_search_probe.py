#!/usr/bin/env python3
"""Read-only API search latency probe. Requires isolated filesmanage_perf at 18094.

The first hit for each distinct term avoids the service's repeated-query cache;
repeat hits are separately measured. No records or permissions are modified.
"""
import json
import pathlib
import runpy
import statistics
import sys
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parents[1]
lib = runpy.run_path(str(ROOT / "scripts" / "loadtest.py"))
Client = lib["Client"]
base = "http://127.0.0.1:18094"
if len(sys.argv) > 1:
    raise SystemExit("This fixture probe is fixed to the isolated loopback 18094")
client = Client(base, "perf-admin", lib["DEFAULT_PERF_PASSWORD"])
cases = [
    ("name-rare", "pf_bulk_9627"),
    ("name-rare", "pf_bulk_9626"),
    ("name-rare", "pf_bulk_9625"),
    ("name-common", "文件"),
    ("name-common", "pf_ord"),
    ("fulltext", "导出"),
    ("no-hit", "qq___nonexistent_9876"),
]
for category, query in cases:
    path = "/api/search?" + urllib.parse.urlencode({"q": query, "limit": 50})
    status, ms, payload = client.request("GET", path)
    body = client._decode(payload)
    if status != 200 or not body or not body.get("ok"):
        raise RuntimeError(f"search failed ({category}): {status}, {str(body)[:140]}")
    first = body["data"]
    status2, ms2, _ = client.request("GET", path)
    if status2 != 200:
        raise RuntimeError(f"cached search failed: {status2}")
    print("SEARCH_SAMPLE", json.dumps({"class": category, "q": query, "coldMs": round(ms, 1),
          "warmMs": round(ms2, 1), "items": len(first["items"]), "total": first["total"]},
          ensure_ascii=False), flush=True)
print("SEARCH_PROBE_PASS")
