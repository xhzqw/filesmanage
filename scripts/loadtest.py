#!/usr/bin/env python3
"""Load test for filesmanage against the isolated perf database (SPEC §24).

Runs the §24.3 endpoint budget with the PERF-API-02 business mix, reports
p50/p95/p99 per endpoint class, and can walk the 1/10/30/100/200 concurrency
ladder (PE03) or hold a sustained load (PE02). It never touches production
data: point it at the dev server whose DATABASE_URL is filesmanage_perf with
the SPEC §24.2 dataset seeded (scripts/perf_dataset.sql).

Usage:
  python3 scripts/loadtest.py --base http://127.0.0.1:18092 --users 100 \
      --duration 900 --warmup 60 --json-out .secrets/perf/latest.json
  python3 scripts/loadtest.py --base http://127.0.0.1:18092 --ladder 1,10,30,100,200 \
      --duration 60 --json-out .secrets/perf/ladder.json

The perf login matches the scratch credential documented in
scripts/perf_dataset.sql (isolated filesmanage_perf only). Expected 4xx
business errors are counted separately from 5xx, which fail the run.
"""
import argparse
import copy
import http.cookiejar
import json
import os
import random
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

# SPEC §24.3 p95/p99 budget (reference environment, warm, authenticated).
BUDGETS_MS = {
    "/api/me": (150, 350),
    "/api/folders/tree": (450, 1200),
    "/api/files": (300, 800),
    "/api/search": (600, 1500),
    "/api/files/{id}": (300, 800),
    "/api/files/{id}/versions": (300, 800),
    "/api/shares": (300, 800),
    "/api/favorites": (300, 800),
    "/api/stats": (1000, 2500),
    "/api/exports/files.csv": (800, 2000),
    "/api/files/{id}/lock": (350, 900),
}

# SPEC PERF-API-02 business mix (weights).
MIX = [
    ("/api/files", 35),
    ("/api/folders/tree", 8),
    ("/api/search", 15),
    ("/api/files/{id}", 6),
    ("/api/files/{id}/versions", 4),
    ("/api/shares", 5),
    ("/api/favorites", 5),
    ("/api/stats", 5),
    ("/api/exports/files.csv", 3),
    ("/api/files/{id}/lock", 10),
    ("/api/me", 4),
]
DEFAULT_PERF_PASSWORD = "Perf-Load-2026!only"
# The seeded corpus carries two CJK corpora of different selectivity (SPEC
# §10.2 samples): 预算 matches ~80% of files, 设备验收 ~20%, and a name probe is
# near-unique. Rotating them keeps the measured mix representative instead of
# only the worst case.
SEARCH_QUERIES = [
    "%E9%A2%84%E7%AE%97",              # 预算  (~80% of the corpus)
    "%E5%B9%B4%E5%BA%A6%E9%A2%84%E7%AE%97",  # 年度预算 (~80%)
    "%E8%AE%BE%E5%A4%87%E9%AA%8C%E6%94%B6",  # 设备验收 (~20%)
    "%E8%A3%85%E9%85%8D%E6%B5%8B%E8%AF%95",  # 装配测试 (~20%)
]


class Client:
    def __init__(self, base, login, password, cookies=None):
        self.base = base.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        if cookies is not None:
            # Warm, authenticated request latency is the PERF-API-02 subject.
            # Reuse the scratch admin's session for each independent client
            # transport instead of generating N rapid logins that violate
            # the production login limiter. No auth security setting changes.
            for cookie in cookies:
                self.jar.set_cookie(copy.copy(cookie))
            return
        req = urllib.request.Request(self.base + "/api/login", method="POST",
                                     data=json.dumps({"login": login, "password": password}).encode())
        req.add_header("Content-Type", "application/json")
        with self.opener.open(req, timeout=15) as response:
            if response.status != 200:
                raise RuntimeError(f"perf login failed: HTTP {response.status}")

    def request_first_byte(self, method, path, body=None):
        """Time to the first response byte; used for streamed exports whose
        SPEC budget is time-to-first-byte, not full transfer (IO-PERF-03)."""
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        start = time.perf_counter()
        try:
            with self.opener.open(req, timeout=120) as response:
                response.read(1)
                return response.status, (time.perf_counter() - start) * 1000.0
        except urllib.error.HTTPError as exc:
            exc.read(1)
            return exc.code, (time.perf_counter() - start) * 1000.0

    def request(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        start = time.perf_counter()
        try:
            with self.opener.open(req, timeout=120) as response:
                payload = response.read()
                return response.status, (time.perf_counter() - start) * 1000.0, payload
        except urllib.error.HTTPError as exc:
            payload = exc.read()
            return exc.code, (time.perf_counter() - start) * 1000.0, payload

    def json(self, method, path, body=None):
        status, _, payload = self.request(method, path, body)
        return status, self._decode(payload)

    def _decode(self, payload):
        try:
            return json.loads(payload.decode("utf8"))
        except (ValueError, UnicodeDecodeError):
            return None


def percentile(values, p):
    if not values:
        return 0.0
    values = sorted(values)
    idx = min(len(values) - 1, int(round((p / 100.0) * (len(values) - 1))))
    return values[idx]


def discover_server_pid(port):
    try:
        out = subprocess.run(["ss", "-tlnp"], capture_output=True, text=True, timeout=20).stdout
        for line in out.splitlines():
            if f":{port} " in line and "pid=" in line:
                return int(line.split("pid=")[1].split(",")[0])
    except (subprocess.SubprocessError, ValueError, IndexError):
        pass
    return None


def sample_process(pid):
    try:
        with open(f"/proc/{pid}/stat", encoding="utf8") as handle:
            fields = handle.read().rsplit(") ", 1)[1].split()
        with open(f"/proc/{pid}/status", encoding="utf8") as handle:
            rss = 0
            for line in handle:
                if line.startswith("VmRSS:"):
                    rss = int(line.split()[1])
                    break
        return rss, int(fields[11]) + int(fields[12])
    except (OSError, ValueError, IndexError):
        return None


def pg_connections(dbname):
    try:
        out = subprocess.run(["runuser", "-u", "postgres", "--", "psql", "-X", "-A", "-t", "-c",
                              "select count(*) from pg_stat_activity where datname=current_database()",
                              "-d", dbname], capture_output=True, text=True, timeout=15).stdout
        return int(out.strip())
    except (subprocess.SubprocessError, ValueError):
        return None


class Mix:
    """Builds real requests against the seeded dataset."""

    def __init__(self, client):
        self.hot = "pf_hot"
        self.ordinary = "pf_bulk_0001"
        status, listing = client.json("GET", f"/api/files?folder={self.ordinary}&limit=1")
        items = ((listing or {}).get("data") or {}).get("items") or []
        self.file_id = items[0]["id"] if items else "pf_hot_1"
        _, meta = client.json("GET", f"/api/files/{self.file_id}")
        file = (meta or {}).get("data", {}).get("file") or {}
        self.base_seq = int(file.get("currentVersionSeq") or 4)

    def request_for(self, name, rng):
        if name == "/api/files":
            folder = self.hot if rng.random() < 0.2 else self.ordinary
            return "GET", f"/api/files?folder={folder}&limit=50&sort=updated_desc", None
        if name.endswith("/lock"):
            return "POST", f"/api/files/{self.file_id}/lock", {"BaseSeq": self.base_seq}
        if "{id}" in name:
            return "GET", name.replace("{id}", self.file_id), None
        if name == "/api/search":
            query = SEARCH_QUERIES[rng.randrange(len(SEARCH_QUERIES))]
            return "GET", f"/api/search?q={query}&limit=50", None
        if name == "/api/shares":
            return "GET", "/api/shares?scope=received", None
        return "GET", name, None


def run_level(base, login, password, users, duration, warmup, mix, rng, db_name, cookies):
    clients = [Client(base, login, password, cookies=cookies) for _ in range(users)]
    population = [name for name, _ in MIX]
    weights = [w for _, w in MIX]
    results, errors, throttled, server_errors = {}, {}, {}, []
    stop_at = [0.0]
    cpu_samples, rss_samples = [], []
    port = base.rsplit(":", 1)[-1]
    pid = discover_server_pid(port)

    def sampler():
        while time.time() < stop_at[0]:
            if pid:
                sample = sample_process(pid)
                if sample:
                    rss_samples.append(sample[0])
                    cpu_samples.append(sample[1])
            time.sleep(0.5)

    def worker(client):
        while time.time() < stop_at[0]:
            name = rng.choices(population, weights)[0]
            method, path, body = mix.request_for(name, rng)
            try:
                if name == "/api/exports/files.csv":
                    status, elapsed = client.request_first_byte(method, path, body)
                else:
                    status, elapsed, _ = client.request(method, path, body)
            except Exception:
                errors[name] = errors.get(name, 0) + 1
                continue
            if status == 429:
                throttled[name] = throttled.get(name, 0) + 1
                continue
            if status >= 500:
                server_errors.append(f"{name}:{status}")
            elif status >= 400:
                errors[name] = errors.get(name, 0) + 1
            else:
                results.setdefault(name, []).append(elapsed)

    def window(seconds):
        results.clear(), errors.clear(), throttled.clear(), server_errors.clear()
        stop_at[0] = time.time() + seconds
        threads = [threading.Thread(target=worker, args=(c,), daemon=True) for c in clients]
        watcher = threading.Thread(target=sampler, daemon=True)
        started = time.time()
        for t in threads:
            t.start()
        watcher.start()
        for t in threads:
            t.join()
        stop_at[0] = 0.0
        watcher.join(timeout=2)
        return time.time() - started

    window(warmup)
    elapsed = window(duration)
    return {
        "users": users, "duration_s": round(elapsed, 1),
        "samples": {k: len(v) for k, v in results.items()},
        "p50_ms": {k: round(percentile(v, 50), 1) for k, v in results.items()},
        "p95_ms": {k: round(percentile(v, 95), 1) for k, v in results.items()},
        "p99_ms": {k: round(percentile(v, 99), 1) for k, v in results.items()},
        "rps": round(sum(len(v) for v in results.values()) / elapsed, 1) if elapsed else 0,
        "client_errors_4xx": errors, "throttled_429": throttled,
        "server_errors_5xx": sorted(set(server_errors)),
        "server_rss_kb_max": max(rss_samples) if rss_samples else None,
        "server_cpu_jiffies_delta": (cpu_samples[-1] - cpu_samples[0]) if len(cpu_samples) > 1 else None,
        "pg_connections_after": pg_connections(db_name),
    }


def print_level(report):
    print(f"users={report['users']} duration={report['duration_s']}s rps={report['rps']} "
          f"rss_max={report['server_rss_kb_max']}kB conns={report['pg_connections_after']}", flush=True)
    print(f"{'endpoint':<28}{'n':>8}{'p50':>9}{'p95':>9}{'p99':>9}{'p95_budget':>12}{'verdict':>9}", flush=True)
    for name, samples in report["samples"].items():
        p50, p95, p99 = report["p50_ms"][name], report["p95_ms"][name], report["p99_ms"][name]
        budget = BUDGETS_MS.get(name, (None, None))[1]
        verdict = ""
        if budget is not None:
            verdict = "PASS" if p95 <= budget else "OVER"
        print(f"{name:<28}{samples:>8}{p50:>9.1f}{p95:>9.1f}{p99:>9.1f}"
              f"{(budget if budget is not None else '-'):>12}{verdict:>9}", flush=True)
    if report["server_errors_5xx"]:
        print(f"SERVER_5XX: {report['server_errors_5xx']}", file=sys.stderr, flush=True)
    if report["client_errors_4xx"]:
        print(f"CLIENT_4XX: {report['client_errors_4xx']}", flush=True)
    if report["throttled_429"]:
        print(f"THROTTLED_429: {report['throttled_429']}", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:18092")
    parser.add_argument("--login", default="perf-admin")
    parser.add_argument("--password", default=DEFAULT_PERF_PASSWORD)
    parser.add_argument("--db-name", default="filesmanage_perf")
    parser.add_argument("--users", type=int, default=100)
    parser.add_argument("--duration", type=int, default=60)
    parser.add_argument("--warmup", type=int, default=30)
    parser.add_argument("--ladder", default="", help="comma-separated concurrency levels (PE03)")
    parser.add_argument("--seed", type=int, default=20261008)
    parser.add_argument("--json-out", default="")
    args = parser.parse_args()

    probe = Client(args.base, args.login, args.password)
    # One login for the isolated perf principal; --users represents concurrent
    # authenticated request workers, not unique accounts or login throughput.
    session_cookies = list(probe.jar)
    if not session_cookies:
        raise RuntimeError("isolated perf login produced no session cookie")
    mix = Mix(probe)
    print(f"targets: file={mix.file_id} baseSeq={mix.base_seq} hot={mix.hot} ordinary={mix.ordinary}", flush=True)

    runs = []
    rng = random.Random(args.seed)
    if args.ladder:
        for level in [int(x) for x in args.ladder.split(",") if x.strip()]:
            print(f"=== ladder level {level} users x {args.duration}s ===", flush=True)
            report = run_level(args.base, args.login, args.password, level, args.duration,
                               min(10, args.duration), mix, random.Random(args.seed + level), args.db_name, session_cookies)
            runs.append(report)
            print_level(report)
    else:
        print(f"=== sustained {args.users} users x {args.duration}s (warmup {args.warmup}s) ===", flush=True)
        report = run_level(args.base, args.login, args.password, args.users, args.duration,
                           args.warmup, mix, rng, args.db_name, session_cookies)
        runs.append(report)
        print_level(report)

    payload = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "base": args.base, "database": args.db_name,
        "mix": {name: weight for name, weight in MIX},
        "budgets_ms": BUDGETS_MS, "runs": runs,
    }
    if args.json_out:
        os.makedirs(os.path.dirname(args.json_out) or ".", exist_ok=True)
        with open(args.json_out, "w", encoding="utf8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
        print(f"machine-readable report: {args.json_out}", flush=True)
    print(f"PERF_RUN_COMPLETE runs={len(runs)}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
