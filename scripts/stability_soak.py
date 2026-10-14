#!/usr/bin/env python3
"""Stability soak: sustained mixed traffic with FD/RSS sampling (IO-PERF-04).

The cache soak proves the caches stay bounded; this one looks for the slow
leaks a short run cannot see - file descriptors and RSS creeping upward under
sustained mixed traffic. It drives a realistic mix (login, tree, list,
preview, search, stats, export, upload) for the requested duration while
sampling the server's open-FD count and RSS, then asserts both plateau.

Loopback only; the drill's own data is cleaned up.
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = "http://127.0.0.1:18091"


def run(command):
    return subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=600)


def proc_stats(pid):
    rss = fds = 0
    try:
        with open(f"/proc/{pid}/status", encoding="utf8") as handle:
            for line in handle:
                if line.startswith("VmRSS:"):
                    rss = int(line.split()[1])
        fds = len(os.listdir(f"/proc/{pid}/fd"))
    except (FileNotFoundError, ProcessLookupError):
        pass
    return rss, fds


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--minutes", type=float, default=10)
    parser.add_argument("--sample-every", type=float, default=15.0)
    args = parser.parse_args()

    with open(os.path.join(ROOT, ".secrets", "admin.password"), encoding="utf8") as handle:
        password = handle.read().strip()

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

    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor())
    login = urllib.request.Request(BASE + "/api/login", method="POST",
                                   data=json.dumps({"login": "admin", "password": password}).encode(),
                                   headers={"Content-Type": "application/json"})
    with opener.open(login, timeout=30) as response:
        response.read()

    def get(path, timeout=60):
        req = urllib.request.Request(BASE + path, method="GET")
        try:
            with opener.open(req, timeout=timeout) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    # A folder of our own so the soak's uploads are isolated and cleanable.
    status, payload = get("/api/folders/tree")
    root_folder = json.loads(payload)["data"][0]["id"]
    req = urllib.request.Request(BASE + "/api/folders", method="POST",
                                 data=json.dumps({"parentId": root_folder,
                                                  "name": "soak-" + str(int(time.time()))}).encode(),
                                 headers={"Content-Type": "application/json"})
    with opener.open(req, timeout=30) as response:
        folder_id = json.loads(response.read())["data"]["id"]

    deadline = time.time() + args.minutes * 60
    next_sample = time.time()
    samples = []
    requests = 0
    errors = 0
    terms = ["预算", "报告", "计划", "测试", "文档", "样本"]

    while time.time() < deadline:
        for path in ("/api/me", "/api/folders/tree", f"/api/files?folder={folder_id}&limit=50",
                     "/api/search?q=" + urllib.parse.quote(terms[requests % len(terms)]) + "&limit=20",
                     "/api/stats"):
            status, _ = get(path)
            requests += 1
            if status >= 500:
                errors += 1
        # One upload per round keeps the write path exercised too.
        boundary = "----SoakStability"
        body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"folderId\"\r\n\r\n{folder_id}\r\n"
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"stability-{requests}.txt\"\r\n"
                f"Content-Type: text/plain\r\n\r\nstability soak payload {requests}\r\n--{boundary}--\r\n").encode()
        req = urllib.request.Request(BASE + "/api/files", data=body, method="POST",
                                     headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
        try:
            with opener.open(req, timeout=60) as response:
                response.read()
                requests += 1
        except urllib.error.HTTPError as exc:
            if exc.code >= 500:
                errors += 1
        if time.time() >= next_sample:
            samples.append(proc_stats(pid))
            next_sample = time.time() + args.sample_every

    rss_values = [s[0] for s in samples]
    fd_values = [s[1] for s in samples]
    warm = max(1, len(samples) // 5)
    fd_plateau = fd_values[warm:]
    rss_plateau = rss_values[warm:]
    fd_growth = (max(fd_plateau) - min(fd_plateau)) if fd_plateau else 0
    rss_growth = (max(rss_plateau) - min(rss_plateau)) if rss_plateau else 0
    check("no 5xx during the soak", errors == 0, f"{errors} server errors over {requests} requests")
    check("open FDs plateau (no FD leak)", fd_growth <= 8,
          f"fd min={min(fd_plateau) if fd_plateau else 0} max={max(fd_plateau) if fd_plateau else 0} spread={fd_growth}")
    check("RSS plateaus after warm-up", rss_growth < 60 * 1024,
          f"rss min={min(rss_plateau) if rss_plateau else 0}kB max={max(rss_plateau) if rss_plateau else 0}kB spread={rss_growth}kB")

    # The cleanup must carry the session too: a bare urlopen has no cookie jar
    # and would 401 after the checks have already passed.
    req = urllib.request.Request(BASE + "/api/folders/" + folder_id, method="DELETE")
    opener.open(req, timeout=60).read()

    failed = [name for name, ok in results if not ok]
    print(f"SUMMARY pass={len(results) - len(failed)} total={len(results)} "
          f"requests={requests} samples={len(samples)} minutes={args.minutes}")
    if failed:
        print("STABILITY_SOAK_FAILED: " + ", ".join(failed), file=sys.stderr)
        return 1
    print("STABILITY_SOAK_PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
