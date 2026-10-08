#!/usr/bin/env python3
"""Cache soak: prove the in-process caches stay bounded under real traffic.

The unit test pins the eviction logic; this exercises it against the live
server with a key space far larger than maxCacheEntries (thousands of distinct
search queries and dozens of distinct sessions) while sampling the server's
RSS. A leak shows up as RSS climbing after warm-up; a bounded cache shows a
plateau.

Loopback only; reads only (searches and session validation), plus one grant
create/revoke pair at the end to reconfirm revocation immediacy under load.
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = "http://127.0.0.1:18091"


def run(command):
    return subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=600)


def rss_kb(pid):
    with open(f"/proc/{pid}/status", encoding="utf8") as handle:
        for line in handle:
            if line.startswith("VmRSS:"):
                return int(line.split()[1])
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--queries", type=int, default=6000, help="distinct search queries to drive")
    parser.add_argument("--sessions", type=int, default=40, help="distinct sessions to open")
    args = parser.parse_args()

    with open(os.path.join(ROOT, ".secrets", "admin.password"), encoding="utf8") as handle:
        password = handle.read().strip()

    # A fresh server makes the RSS plateau unambiguous.
    run(["bash", "scripts/run-dev.sh", "stop"])
    started = run(["bash", "scripts/run-dev.sh", "start"])
    if "health/ready OK" not in started.stdout + started.stderr:
        print("server did not start", file=sys.stderr)
        return 1

    out = run(["ss", "-ltnp"])
    pid = None
    for line in out.stdout.splitlines():
        if ":18091" in line:
            fields = line.split("pid=")
            if len(fields) > 1:
                pid = int(fields[1].split(",")[0])
    if not pid:
        print("server pid not found", file=sys.stderr)
        return 1

    results = []

    def check(name, ok, detail):
        results.append((name, bool(ok)))
        print(f"{'PASS' if ok else 'FAIL'} {name} :: {detail}")

    # Distinct sessions: each login is a new token, so the session cache sees
    # args.sessions distinct keys.
    cookies = []
    for i in range(args.sessions):
        req = urllib.request.Request(BASE + "/api/login", method="POST",
                                     data=json.dumps({"login": "admin", "password": password}).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as response:
            cookie = response.headers.get_all("Set-Cookie")[0].split(";")[0]
        cookies.append(cookie)
    check("distinct sessions opened", len(cookies) == args.sessions, f"{len(cookies)} sessions")

    samples = []
    started_at = time.time()
    for i in range(args.queries):
        cookie = cookies[i % len(cookies)]
        # Every query is distinct, so every one is a cache miss that inserts a
        # new key: the key space is args.queries large, far past the cap.
        term = f"soak{i}"
        req = urllib.request.Request(f"{BASE}/api/search?q={term}&limit=10",
                                     headers={"Cookie": cookie})
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                response.read()
        except urllib.error.HTTPError as exc:
            exc.read()
        if i % 500 == 0:
            samples.append((i, rss_kb(pid)))
    samples.append((args.queries, rss_kb(pid)))

    peak_after_warmup = max(rss for _, rss in samples[2:]) if len(samples) > 2 else 0
    warmup_rss = samples[1][1] if len(samples) > 1 else 0
    growth = peak_after_warmup - warmup_rss
    trajectory = " -> ".join(f"{rss}kB" for _, rss in samples)
    check("RSS plateaus after warm-up (no unbounded growth)",
          growth < 100 * 1024,
          f"growth={growth}kB over {args.queries} distinct queries; trajectory {trajectory}")

    # Revocation immediacy must still hold after all that churn. The probe is
    # a NON-admin account (an admin sees every folder regardless of grants, so
    # an admin-based check would prove nothing) and the uploaded file actually
    # matches the search term, so the totals are 1/0 rather than a vacuous 0/0.
    stamp = str(int(time.time()))
    user = urllib.request.Request(BASE + "/api/users", method="POST",
                                  data=json.dumps({"login": "soakprobe" + stamp, "displayName": "Soak探针",
                                                   "password": "Soak-Probe-Pw-5e81ac42d09b"}).encode(),
                                  headers={"Content-Type": "application/json", "Cookie": cookies[0]})
    with urllib.request.urlopen(user, timeout=30) as response:
        probe_id = json.loads(response.read())["data"]["id"]
    # The handler keeps the session across a password change, so a cookie jar
    # is all the probe needs (no manual cookie juggling).
    probe_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor())
    login = urllib.request.Request(BASE + "/api/login", method="POST",
                                   data=json.dumps({"login": "soakprobe" + stamp,
                                                    "password": "Soak-Probe-Pw-5e81ac42d09b"}).encode(),
                                   headers={"Content-Type": "application/json"})
    with probe_opener.open(login, timeout=30) as response:
        response.read()
    change = urllib.request.Request(BASE + "/api/me/password", method="POST",
                                    data=json.dumps({"oldPassword": "Soak-Probe-Pw-5e81ac42d09b",
                                                     "newPassword": "Soak-Probe-Pw-5e81ac42d09bx"}).encode(),
                                    headers={"Content-Type": "application/json"})
    with probe_opener.open(change, timeout=30) as response:
        response.read()
    probe_cookie = "jar"

    tree = urllib.request.Request(BASE + "/api/folders/tree", headers={"Cookie": cookies[0]})
    with urllib.request.urlopen(tree, timeout=30) as response:
        root_folder = json.loads(response.read())["data"][0]["id"]
    folder = urllib.request.Request(BASE + "/api/folders", method="POST",
                                    data=json.dumps({"parentId": root_folder, "name": "soak-" + str(int(time.time()))}).encode(),
                                    headers={"Content-Type": "application/json", "Cookie": cookies[0]})
    with urllib.request.urlopen(folder, timeout=30) as response:
        folder_id = json.loads(response.read())["data"]["id"]
    boundary = "----Soak"
    payload = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"folderId\"\r\n\r\n{folder_id}\r\n"
               f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"soak-probe.txt\"\r\n"
               f"Content-Type: text/plain\r\n\r\nsoak1\r\n--{boundary}--\r\n").encode()
    upload = urllib.request.Request(BASE + "/api/files", data=payload, method="POST",
                                    headers={"Content-Type": f"multipart/form-data; boundary={boundary}",
                                             "Cookie": cookies[0]})
    with urllib.request.urlopen(upload, timeout=30) as response:
        probe_file = json.loads(response.read())["data"]["fileId"]
    grant = urllib.request.Request(f"{BASE}/api/folders/{folder_id}/acls", method="POST",
                                   data=json.dumps({"subjectKind": "user", "subjectId": probe_id,
                                                    "actions": ["list"]}).encode(),
                                   headers={"Content-Type": "application/json", "Cookie": cookies[0]})
    with urllib.request.urlopen(grant, timeout=30) as response:
        grant_id = json.loads(response.read())["data"]["id"]
    search = urllib.request.Request(f"{BASE}/api/search?q=soak1&folder={folder_id}")
    with probe_opener.open(search, timeout=30) as response:
        total = json.loads(response.read())["data"]["total"]
    revoke = urllib.request.Request(f"{BASE}/api/acls/{grant_id}", method="DELETE",
                                    headers={"Cookie": cookies[0]})
    urllib.request.urlopen(revoke, timeout=30).read()
    search2 = urllib.request.Request(f"{BASE}/api/search?q=soak1&folder={folder_id}")
    with probe_opener.open(search2, timeout=30) as response:
        total_after = json.loads(response.read())["data"]["total"]
    check("revocation still immediate after the soak", total_after == 0,
          f"total before={total} after={total_after}")
    check("soak probe was visible while granted", total == 1, f"total before revocation={total}")
    disable = urllib.request.Request(f"{BASE}/api/users/{probe_id}/disable", method="POST",
                                     headers={"Cookie": cookies[0]})
    urllib.request.urlopen(disable, timeout=30).read()
    delete = urllib.request.Request(f"{BASE}/api/folders/{folder_id}", method="DELETE",
                                    headers={"Cookie": cookies[0]})
    urllib.request.urlopen(delete, timeout=30).read()

    elapsed = time.time() - started_at
    failed = [name for name, ok in results if not ok]
    print(f"SUMMARY pass={len(results) - len(failed)} total={len(results)} elapsed={elapsed:.0f}s")
    if failed:
        print("CACHE_SOAK_FAILED: " + ", ".join(failed), file=sys.stderr)
        return 1
    print("CACHE_SOAK_PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
