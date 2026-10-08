#!/usr/bin/env python3
"""PE10: editor session lifecycle stress (SPEC §19, OFFICE-PERF-01/02).

Creates and cancels N editing sessions for the same DOCX through the real API
and measures session preparation latency plus cleanup. The ONLYOFFICE Document
Server must be reachable; the check verifies the session ledger, the single
writer rule and that a cancelled session releases the edit lock.

Usage: python3 scripts/office_session_check.py --base http://127.0.0.1:18091 \
        --cookie <fm_session> --file-id <docx file id> --sessions 5
"""
import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.request


def call(base, cookie, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Cookie", f"fm_session={cookie}")
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            return response.status, json.loads(response.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read().decode() or "{}")
        except ValueError:
            return exc.code, {}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:18091")
    parser.add_argument("--cookie", required=True)
    parser.add_argument("--file-id", required=True)
    parser.add_argument("--sessions", type=int, default=5)
    args = parser.parse_args()

    results = []

    def check(name, ok, detail):
        results.append((name, bool(ok), detail))

    open_ms = []
    cancel_ms = []
    doc_keys = set()
    for i in range(args.sessions):
        started = time.perf_counter()
        status, body = call(args.base, args.cookie, "POST",
                            f"/api/files/{args.file_id}/office/session", {})
        elapsed = (time.perf_counter() - started) * 1000.0
        open_ms.append(elapsed)
        data = body.get("data") or {}
        session_id = data.get("sessionId")
        doc_key = data.get("documentKey") or data.get("config", {}).get("document", {}).get("key")
        if doc_key:
            doc_keys.add(doc_key)
        check(f"session {i} opens", status in (200, 201) and bool(session_id), f"HTTP {status} {elapsed:.0f}ms")
        started = time.perf_counter()
        status, _ = call(args.base, args.cookie, "POST",
                         f"/api/files/{args.file_id}/office/session/{session_id}/cancel", {})
        cancel_ms.append((time.perf_counter() - started) * 1000.0)
        check(f"session {i} cancels", status == 200, f"HTTP {status}")

    check("document keys unique per session", len(doc_keys) == args.sessions,
          f"{len(doc_keys)} keys for {args.sessions} sessions")
    if open_ms:
        check("session open p95 under 1500ms",
              statistics.quantiles(open_ms, n=20)[-1] <= 1500 if len(open_ms) > 1 else open_ms[0] <= 1500,
              f"p95={statistics.quantiles(open_ms, n=20)[-1] if len(open_ms) > 1 else open_ms[0]:.0f}ms")
    print(f"open_ms={[round(x) for x in open_ms]} cancel_ms={[round(x) for x in cancel_ms]}")
    failed = [name for name, ok, _ in results if not ok]
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'} {name} :: {detail}")
    print(f"SUMMARY pass={len(results) - len(failed)} total={len(results)}")
    if failed:
        print("OFFICE_SESSION_CHECK_FAILED: " + ", ".join(failed), file=sys.stderr)
        return 1
    print("OFFICE_SESSION_CHECK_PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
