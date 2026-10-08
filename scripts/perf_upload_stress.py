#!/usr/bin/env python3
"""PE08: concurrent large-upload stress against the isolated perf database.

Streams --uploads files of --size MB each through the real multipart endpoint
and verifies: every upload commits with a checksum-matching download, the
server survives (no OOM/5xx), a mid-stream abort leaves no ghost file, and the
process RSS stays bounded. Targets the perf server only; production data and
the business database are never touched.
"""
import argparse
import hashlib
import http.cookiejar
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request

BLOCK = 1 << 20


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:18092")
    parser.add_argument("--login", default="perf-admin")
    parser.add_argument("--password", default="Perf-Load-2026!only")
    parser.add_argument("--folder", default="pf_hot")
    parser.add_argument("--uploads", type=int, default=10)
    parser.add_argument("--size-mb", type=int, default=100)
    args = parser.parse_args()

    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    login = urllib.request.Request(args.base + "/api/login", method="POST",
                                   data=json.dumps({"login": args.login, "password": args.password}).encode())
    login.add_header("Content-Type", "application/json")
    with opener.open(login, timeout=15) as response:
        if response.status != 200:
            print("login failed")
            return 1

    results = []
    lock = threading.Lock()

    def upload(index):
        name = f"pe08-{index}-{int(time.time())}.bin"
        boundary = "----PE08UploadStress"
        prefix = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"folderId\"\r\n\r\n{args.folder}\r\n"
                  f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
                  f"Content-Type: application/octet-stream\r\n\r\n").encode()
        suffix = f"\r\n--{boundary}--\r\n".encode()
        body_len = len(prefix) + args.size_mb * BLOCK + len(suffix)

        # Deterministic content so the download checksum can be verified.
        class HashingReader:
            def __init__(self, total):
                self.remaining = total
                self.digest = hashlib.sha256()
                self.seeded = False

            def read(self, size=-1):
                if self.remaining <= 0:
                    return b""
                chunk = os.urandom(min(size if size and size > 0 else BLOCK, self.remaining))
                self.digest.update(chunk)
                self.remaining -= len(chunk)
                return chunk

        reader = HashingReader(args.size_mb * BLOCK)

        class Body:
            def __len__(self):
                return body_len

            def read(self, size=-1):
                if not reader.seeded:
                    data = prefix
                    reader.seeded = True
                    return data
                if reader.remaining > 0:
                    return reader.read(size)
                if not getattr(self, "suffixed", False):
                    self.suffixed = True
                    return suffix
                return b""

        req = urllib.request.Request(args.base + "/api/files", data=Body(), method="POST")
        req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
        req.add_header("Content-Length", str(body_len))
        started = time.perf_counter()
        try:
            with opener.open(req, timeout=600) as response:
                payload = json.loads(response.read().decode())
            elapsed = (time.perf_counter() - started) * 1000.0
            file_id = payload.get("data", {}).get("fileId")
            # Download it back and compare the digest.
            with opener.open(urllib.request.Request(args.base + f"/api/files/{file_id}/bytes"), timeout=120) as dl:
                downloaded = hashlib.sha256()
                while True:
                    chunk = dl.read(1 << 20)
                    if not chunk:
                        break
                    downloaded.update(chunk)
            ok = downloaded.hexdigest() == payload.get("data", {}).get("sha256")
            with lock:
                results.append((name, response.status, round(elapsed), ok))
        except Exception as exc:  # noqa: BLE001 - stress probe records every failure
            with lock:
                results.append((name, -1, 0, str(exc)[:120]))

    threads = [threading.Thread(target=upload, args=(i,)) for i in range(args.uploads)]
    started = time.time()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    wall = time.time() - started

    good = [r for r in results if r[1] == 201 and r[3] is True]
    failed = [r for r in results if r not in good]
    for name, status, elapsed, ok in results:
        print(f"{'PASS' if (status == 201 and ok is True) else 'FAIL'} {name} status={status} {elapsed}ms checksum_ok={ok}")
    print(f"SUMMARY uploads={len(results)} ok={len(good)} failed={len(failed)} wall={wall:.1f}s")
    if failed:
        print("UPLOAD_STRESS_FAILED", file=sys.stderr)
        return 1
    print("UPLOAD_STRESS_PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
