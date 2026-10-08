#!/usr/bin/env python3
"""Non-mutating unauthenticated security smoke tests against the dev HTTP server.

Only permitted on loopback; does not use, read or guess real credentials.
This is *not* the S1–S22 / DO / MC security acceptance matrix.
"""
import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

ROUTES = [
    "/api/me",
    "/api/folders/tree",
    "/api/files",
    "/api/users",
    "/api/departments",
    "/api/groups",
    "/api/approvals",
    "/api/shares",
    "/api/favorites",
    "/api/search",
    "/api/stats",
    "/api/exports/files.csv",
    "/api/trash",
]


def request(url, method="GET", body=None, origin=None):
    data = (body if isinstance(body, bytes) else json.dumps(body).encode()) if body is not None else None
    req = urllib.request.Request(url, method=method, data=data)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if origin is not None:
        req.add_header("Origin", origin)
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, response.headers.get("Content-Type", ""), response.read(8192)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.headers.get("Content-Type", ""), exc.read(8192)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:18091")
    args = parser.parse_args()
    parsed = urllib.parse.urlsplit(args.base)
    if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
        raise RuntimeError("this smoke test must target localhost only")
    base = args.base.rstrip("/")
    results = []
    for path in ROUTES:
        status, content_type, body = request(base + path)
        # Requests must not return an authenticated response without a session.
        good = status == 401 and "application/json" in content_type
        results.append((path, status, good))
    origin_status, _, origin_body = request(base + "/api/login", "POST",
                                           {"login": "invalid-probe-user", "password": "invalid-probe-value"},
                                           "https://external.invalid")
    results.append(("foreign Origin rejected", origin_status, origin_status == 403))
    malformed_status, _, _ = request(base + "/api/login", "POST", b"{invalid-json")
    results.append(("malformed login rejected", malformed_status, malformed_status == 400))
    bad_status, _, _ = request(base + "/api/login", "POST",
                               {"login": "invalid-probe-user", "password": "invalid-probe-value"})
    results.append(("invalid login rejected", bad_status, bad_status == 401))
    health_status, _, _ = request(base + "/health/ready")
    results.append(("readiness without session", health_status, health_status == 200))
    for item, status, good in results:
        print(f"{'PASS' if good else 'FAIL'} {item} HTTP {status}")
    print(f"SUMMARY pass={sum(r[2] for r in results)} total={len(results)}")
    if not all(r[2] for r in results):
        sys.exit(1)


if __name__ == "__main__":
    main()
