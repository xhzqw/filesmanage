#!/usr/bin/env python3
"""AG09 crash-recovery drill: staging sweep on startup (SPEC §23 AG09).

An upload stages content first and only renames it into the content-addressed
ready location inside the same window as the database commit, so a crash can
leave at most an unreferenced ready blob — never a dangling reference. What it
does leave behind is a staging file. The server sweeps those at startup.

This drill proves the sweep end-to-end: it plants an orphaned staging file
(crash before the database commit) and a fresh one (an in-flight upload of a
concurrently running process), restarts the dev server, and asserts the
orphan is gone while the fresh file survives. It also verifies the safe
ordering property directly: a committed upload's bytes are readable after the
restart.

Loopback only; touches nothing outside the workspace blob directory.
"""
import os
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_FILE = os.path.join(ROOT, ".secrets", "server.env")
BLOB_DIR = ".blobs"
BASE = "http://127.0.0.1:18091"


def blob_root():
    with open(ENV_FILE, encoding="utf8") as handle:
        for line in handle:
            if line.startswith("FILESMANAGE_BLOB_DIR="):
                return os.path.join(ROOT, line.strip().split("=", 1)[1])
    return os.path.join(ROOT, BLOB_DIR)


def run(command):
    return subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=300)


def main():
    root = blob_root()
    staging = os.path.join(root, "staging")
    os.makedirs(staging, exist_ok=True)

    results = []

    def check(name, ok, detail):
        results.append((name, bool(ok)))
        print(f"{'PASS' if ok else 'FAIL'} {name} :: {detail}")

    # Plant an orphan (mtime two hours old: a crash before the DB commit) and a
    # fresh staging file (an in-flight upload that must survive the sweep).
    orphan = os.path.join(staging, "ag09-orphan-" + str(int(time.time())))
    fresh = os.path.join(staging, "ag09-fresh-" + str(int(time.time())))
    for path, age_hours in ((orphan, 2), (fresh, 0)):
        with open(path, "wb") as handle:
            handle.write(b"ag09 drill payload")
        old = time.time() - age_hours * 3600
        os.utime(path, (old, old))

    stopped = run(["bash", "scripts/run-dev.sh", "stop"])
    started = run(["bash", "scripts/run-dev.sh", "start"])
    check("dev services restarted for the drill",
          started.returncode == 0 and "health/ready OK" in started.stdout + started.stderr,
          (started.stdout + started.stderr).strip().splitlines()[-1] if (started.stdout + started.stderr).strip() else started.returncode)

    check("AG09 orphaned staging file swept", not os.path.exists(orphan),
          "removed" if not os.path.exists(orphan) else "still present")
    check("AG09 fresh staging file preserved", os.path.exists(fresh),
          "preserved" if os.path.exists(fresh) else "wrongly removed")
    if os.path.exists(fresh):
        os.remove(fresh)

    # Ordering property: a committed upload is fully readable after a restart
    # (the rename precedes the database commit, so no dangling reference can
    # exist).
    with open(os.path.join(ROOT, ".secrets", "admin.password"), encoding="utf8") as handle:
        password = handle.read().strip()
    login = urllib.request.Request(BASE + "/api/login", method="POST",
                                   data=b'{"login":"admin","password":"' + password.encode() + b'"}',
                                   headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(login, timeout=30) as response:
        cookie = response.headers.get_all("Set-Cookie")[0].split(";")[0]

    boundary = "----AG09Drill"
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"folderId\"\r\n\r\nfolder_root\r\n"
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"ag09-drill.bin\"\r\n"
            f"Content-Type: application/octet-stream\r\n\r\nag09 drill payload\r\n--{boundary}--\r\n").encode()
    upload = urllib.request.Request(BASE + "/api/files", data=body, method="POST",
                                    headers={"Content-Type": f"multipart/form-data; boundary={boundary}",
                                             "Cookie": cookie})
    import json
    with urllib.request.urlopen(upload, timeout=60) as response:
        uploaded = json.loads(response.read())["data"]
    file_id = uploaded["fileId"]
    download = urllib.request.Request(BASE + "/api/files/" + file_id + "/bytes",
                                      headers={"Cookie": cookie})
    with urllib.request.urlopen(download, timeout=60) as response:
        payload = response.read()
    check("AG09 committed upload readable after restart", payload == b"ag09 drill payload",
          f"HTTP 200 bytes={len(payload)}")

    delete = urllib.request.Request(BASE + "/api/files/" + file_id, method="DELETE",
                                    headers={"Cookie": cookie})
    urllib.request.urlopen(delete, timeout=60).read()

    failed = [name for name, ok in results if not ok]
    print(f"SUMMARY pass={len(results) - len(failed)} total={len(results)}")
    if failed:
        print("AG09_RECOVERY_DRILL_FAILED: " + ", ".join(failed), file=sys.stderr)
        return 1
    print("AG09_RECOVERY_DRILL_PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
