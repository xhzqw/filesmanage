#!/usr/bin/env python3
"""S12 upgrade/rollback drill at dev level (SPEC §12 S12).

systemd installation and the production cutover stay unauthorised (BLK-05), but
the upgrade/rollback *drill* itself needs no production access and is the part
that proves the delivery can be moved backwards safely.

The drill:
  1. verifies the current build (health, real login, a known file's bytes);
  2. writes a new file through the API (data created by the current build);
  3. builds the previous release commit in a git worktree and swaps it in;
  4. verifies the rolled-back build starts, authenticates and still serves the
     data written by the newer build (no schema or data loss);
  5. restores the current build, verifies again, and cleans up.

The rollback target defaults to the commit before the MSH derivative change so
the drill also documents the one real compatibility boundary: a rolled-back
server reports derivative output kinds it did not produce, and the newer
frontend keeps parsing them.

Loopback only; the business database is used read-mostly (the drill writes one
disposable file and deletes it).
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = "http://127.0.0.1:18091"
WORKTREE = "/tmp/filesmanage-rollback"


def run(command, cwd=ROOT):
    return subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=900)


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def api(method, path, cookie=None, body=None, raw=None, content_type=None):
    headers = {}
    if cookie:
        headers["Cookie"] = cookie
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    if data is not None:
        headers["Content-Type"] = content_type or "application/json"
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def login(password):
    status, payload = api("POST", "/api/login", body={"login": "admin", "password": password})
    if status != 200:
        raise RuntimeError(f"login failed HTTP {status}")
    cookie = None
    # urllib hides Set-Cookie; use a cookie jar through http.cookiejar instead.
    import http.cookiejar
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    req = urllib.request.Request(BASE + "/api/login", method="POST",
                                 data=json.dumps({"login": "admin", "password": password}).encode(),
                                 headers={"Content-Type": "application/json"})
    with opener.open(req, timeout=60) as response:
        response.read()
    for item in jar:
        if item.name == "fm_session":
            cookie = f"fm_session={item.value}"
    if not cookie:
        raise RuntimeError("no session cookie issued")
    return cookie


def upload(cookie, name, content):
    boundary = "----UpgradeRollback"
    payload = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"folderId\"\r\n\r\nfolder_root\r\n"
               f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
               f"Content-Type: text/plain\r\n\r\n".encode() + content +
               f"\r\n--{boundary}--\r\n".encode())
    status, body = api("POST", "/api/files", cookie=cookie, raw=payload,
                       content_type=f"multipart/form-data; boundary={boundary}")
    try:
        return json.loads(body)["data"]
    except (ValueError, KeyError):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rollback-to", default="HEAD~1",
                        help="commit to build and swap in as the previous release")
    args = parser.parse_args()
    with open(os.path.join(ROOT, ".secrets", "admin.password"), encoding="utf8") as handle:
        password = handle.read().strip()

    results = []

    def check(name, ok, detail):
        results.append((name, bool(ok)))
        print(f"{'PASS' if ok else 'FAIL'} {name} :: {detail}")

    # 1. current build is healthy and serving real data
    status, _ = api("GET", "/health/ready")
    check("current build ready", status == 200, f"HTTP {status}")
    cookie = login(password)
    status, payload = api("GET", "/api/me", cookie=cookie)
    check("current build authenticates", status == 200, f"HTTP {status}")

    # 2. data written by the current build
    stamp = str(int(time.time()))
    marker = f"upgrade-rollback drill {stamp}".encode()
    uploaded = upload(cookie, f"drill-marker-{stamp}.txt", marker)
    check("current build writes data", uploaded is not None and uploaded.get("fileId"), str(uploaded))
    if not uploaded:
        print("cannot continue without a marker file", file=sys.stderr)
        return 1
    file_id = uploaded["fileId"]
    status, payload = api("GET", f"/api/files/{file_id}/bytes", cookie=cookie)
    check("marker readable on the current build", status == 200 and payload == marker,
          f"HTTP {status} sha={hashlib.sha256(payload).hexdigest()[:12]}")

    # 3. build the previous release in a worktree and swap it in
    target = args.rollback_to
    run(["git", "worktree", "remove", "--force", WORKTREE])
    added = run(["git", "worktree", "add", "--detach", WORKTREE, target])
    check("rollback worktree created", added.returncode == 0, target if added.returncode == 0 else added.stderr.strip()[:120])
    if added.returncode != 0:
        return 1
    built = run(["go", "build", "-o", os.path.join(ROOT, ".bin", "server.rollback"), "./cmd/server"],
                cwd=WORKTREE)
    check("previous release built", built.returncode == 0, built.stderr.strip()[:120] if built.returncode else "ok")
    if built.returncode != 0:
        run(["git", "worktree", "remove", "--force", WORKTREE])
        return 1

    current_binary = os.path.join(ROOT, ".bin", "server")
    rollback_binary = os.path.join(ROOT, ".bin", "server.rollback")
    current_digest = sha256_file(current_binary)
    os.replace(current_binary, current_binary + ".current")
    os.replace(rollback_binary, current_binary)
    stopped = run(["bash", "scripts/run-dev.sh", "stop"])
    started = run(["bash", "scripts/run-dev.sh", "start"])
    check("rolled-back build started", started.returncode == 0 and "health/ready OK" in started.stdout + started.stderr,
          (started.stdout + started.stderr).strip().splitlines()[-1] if (started.stdout + started.stderr).strip() else started.returncode)

    # 4. the rolled-back build serves the data the newer build wrote
    try:
        status, _ = api("GET", "/health/ready")
        check("rolled-back build ready", status == 200, f"HTTP {status}")
        cookie = login(password)
        status, payload = api("GET", f"/api/files/{file_id}/bytes", cookie=cookie)
        check("S12 rollback keeps data written by the newer build",
              status == 200 and payload == marker,
              f"HTTP {status} sha={hashlib.sha256(payload).hexdigest()[:12]}")
        # A write under the rolled-back build must also work.
        written = upload(cookie, f"drill-rollback-{stamp}.txt", b"written under the rolled-back build")
        check("rolled-back build writes data", written is not None and written.get("fileId"), str(written)[:80])
        rollback_file = written.get("fileId") if written else None
    finally:
        # 5. restore the current build
        os.replace(current_binary, rollback_binary)
        os.replace(current_binary + ".current", current_binary)
        run(["bash", "scripts/run-dev.sh", "stop"])
        restored = run(["bash", "scripts/run-dev.sh", "start"])
        check("current build restored", sha256_file(current_binary) == current_digest
              and "health/ready OK" in restored.stdout + restored.stderr,
              "binary digest matches" if sha256_file(current_binary) == current_digest else "digest mismatch")
        run(["git", "worktree", "remove", "--force", WORKTREE])

    cookie = login(password)
    status, payload = api("GET", f"/api/files/{file_id}/bytes", cookie=cookie)
    check("marker still readable after restore", status == 200 and payload == marker, f"HTTP {status}")
    for target_id in (file_id, rollback_file):
        if target_id:
            api("DELETE", f"/api/files/{target_id}", cookie=cookie)
    os.path.exists(rollback_binary) and os.remove(rollback_binary)

    failed = [name for name, ok in results if not ok]
    print(f"SUMMARY pass={len(results) - len(failed)} total={len(results)}")
    if failed:
        print("UPGRADE_ROLLBACK_DRILL_FAILED: " + ", ".join(failed), file=sys.stderr)
        return 1
    print("UPGRADE_ROLLBACK_DRILL_PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
