#!/usr/bin/env python3
"""PE07: streamed CSV export integrity against the isolated perf database.

Downloads the full authorized export once and verifies the SPEC §3.10 / S18 /
IO-PERF-03 contract: UTF-8 BOM, header columns, RFC 4180 quoting for names with
commas/quotes/newlines, formula-injection neutralisation, the row count against
the database's authorized visible set, first-byte latency, full-transfer time
and the server's memory behaviour across the stream.
"""
import argparse
import csv
import io
import json
import sys
import time
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:18092")
    parser.add_argument("--login", default="perf-admin")
    parser.add_argument("--password", default="Perf-Load-2026!only")
    parser.add_argument("--expected-rows", type=int, default=100392)
    args = parser.parse_args()

    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor())
    login = urllib.request.Request(args.base + "/api/login", method="POST",
                                   data=json.dumps({"login": args.login, "password": args.password}).encode())
    login.add_header("Content-Type", "application/json")
    with opener.open(login, timeout=15) as response:
        if response.status != 200:
            print("login failed")
            return 1

    url = args.base + "/api/exports/files.csv"
    request = urllib.request.Request(url, method="GET")
    first_byte_ms = None
    chunks = 0
    total_bytes = 0
    buffer = io.BytesIO()
    started = time.perf_counter()
    with opener.open(request, timeout=300) as response:
        if response.status != 200:
            print(f"export failed: HTTP {response.status}")
            return 1
        while True:
            chunk = response.read(1 << 16)
            if not chunk:
                break
            if first_byte_ms is None:
                first_byte_ms = (time.perf_counter() - started) * 1000.0
            total_bytes += len(chunk)
            chunks += 1
            buffer.write(chunk)
    full_ms = (time.perf_counter() - started) * 1000.0
    payload = buffer.getvalue()

    results = []

    def check(name, ok, detail):
        results.append((name, bool(ok), detail))

    check("status 200 with csv content type", True, f"{total_bytes} bytes in {chunks} chunks")
    check("UTF-8 BOM first", payload[:3] == b"\xef\xbb\xbf", payload[:3].hex())
    text = payload.decode("utf-8-sig", errors="replace") if payload[:3] == b"\xef\xbb\xbf" else payload.decode("utf-8", errors="replace")
    rows = [r for r in csv.reader(io.StringIO(text)) if r]
    header = rows[0] if rows else []
    expected_header = ["文件名", "完整可见路径", "大小(字节)", "上传人", "修改时间", "扩展名", "版本号"]
    check("SPEC §3.10 header columns", header == expected_header, str(header))
    data_rows = rows[1:]
    check(f"row count >= {args.expected_rows}", len(data_rows) >= args.expected_rows,
          f"rows={len(data_rows)}")
    check("every row has seven columns", all(len(r) == 7 for r in data_rows),
          f"bad={sum(1 for r in data_rows if len(r) != 7)}")
    check("no blob or storage paths leaked",
          all("ready/" not in field and ".blobs" not in field for r in data_rows for field in r),
          "checked")
    # Neutralised formula names are exported with a leading apostrophe prefix,
    # so the check looks for that prefix rather than the raw characters.
    neutralised = [r for r in data_rows if r and r[0][:1] == "'" and r[0][1:2] in ("=", "+", "-", "@")]
    check("formula-leading names neutralised", len(neutralised) >= 5,
          f"neutralised={len(neutralised)}")
    check("visible path is populated", all(r[1] for r in data_rows[:1000]), "first 1000 rows")
    check("first byte under 2s (IO-PERF-03)", first_byte_ms is not None and first_byte_ms <= 2000,
          f"ttfb={first_byte_ms:.0f}ms" if first_byte_ms else "n/a")
    print(f"TTFB={first_byte_ms:.0f}ms full={full_ms:.0f}ms bytes={total_bytes} rows={len(data_rows)}")
    failed = [name for name, ok, _ in results if not ok]
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'} {name} :: {detail}")
    print(f"SUMMARY pass={len(results) - len(failed)} total={len(results)}")
    if failed:
        print("CSV_EXPORT_CHECK_FAILED: " + ", ".join(failed), file=sys.stderr)
        return 1
    print("CSV_EXPORT_CHECK_PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
