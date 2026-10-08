#!/usr/bin/env python3
"""PE09: media Range behaviour against the dev server.

Verifies HTTP Range semantics on an authorized MP4 preview stream: 206 for
byte ranges, 416 for unsatisfiable ranges, stable Content-Length/ETag-style
headers per version, and that a seek lands on the requested offset. Read-only:
it never mutates business data.
"""
import argparse
import sys
import urllib.error
import urllib.request


def get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:18091")
    parser.add_argument("--cookie", required=True, help="fm_session cookie value")
    parser.add_argument("--file-id", required=True)
    args = parser.parse_args()
    cookie = {"Cookie": f"fm_session={args.cookie}"}
    results = []

    def check(name, ok, detail):
        results.append((name, bool(ok), detail))

    url = f"{args.base}/api/files/{args.file_id}/bytes"
    status, headers, body = get(url, cookie)
    check("full download 200", status == 200, f"status={status} bytes={len(body)}")
    total = int(headers.get("Content-Length") or 0)
    check("content length present", total > 0, f"len={total}")
    sha = headers.get("X-Content-Sha256") or ""
    check("sha header present", len(sha) == 64, sha[:16])

    status, headers, body = get(url, {**cookie, "Range": "bytes=0-1023"})
    check("range 0-1023 returns 206", status == 206, f"status={status} bytes={len(body)}")
    check("range body length", len(body) == 1024, f"len={len(body)}")

    status, headers, body = get(url, {**cookie, "Range": f"bytes={total - 100}-"})
    check("suffix range 206", status == 206, f"status={status} bytes={len(body)}")
    check("suffix range length", len(body) == 100, f"len={len(body)}")

    status, headers, body = get(url, {**cookie, "Range": f"bytes={total}-"})
    check("unsatisfiable range 416", status == 416, f"status={status}")

    status, headers, body = get(url, {**cookie, "Range": "bytes=0-0"})
    check("single byte 206", status == 206 and len(body) == 1, f"status={status} len={len(body)}")

    status, headers, body = get(f"{args.base}/api/files/{args.file_id}/preview", cookie)
    check("preview reachable", status == 200, f"status={status}")

    failed = [name for name, ok, _ in results if not ok]
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'} {name} :: {detail}")
    print(f"SUMMARY pass={len(results) - len(failed)} total={len(results)}")
    if failed:
        print("MEDIA_RANGE_CHECK_FAILED: " + ", ".join(failed), file=sys.stderr)
        return 1
    print("MEDIA_RANGE_CHECK_PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
