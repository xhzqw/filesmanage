#!/usr/bin/env python3
"""PE12 / CAD-PERF-03: CAD worker saturation isolation (SPEC §24.4).

Queues a batch of distinct STEP conversions to saturate the CAD worker, then
measures the ordinary request latencies (/api/me session, folder list, folder
tree) while the worker is busy and compares them with the idle baseline. The
SPEC allows at most 25% p95 degradation under saturation.

Generates its own samples (gmsh/OpenCASCADE tori), uploads them through the API
into an isolated folder, requests derivatives, measures, then cleans up
(soft delete). Loopback only.
"""
import argparse
import json
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse as up
import urllib.request


class Session:
    def __init__(self, base):
        self.base = base.rstrip("/")
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor())

    def request(self, method, path, body=None, raw=None, content_type=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", content_type or "application/json")
        try:
            with self.opener.open(req, timeout=60) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    def json(self, method, path, body=None):
        status, payload = self.request(method, path, body)
        try:
            return status, json.loads(payload.decode("utf8"))
        except (ValueError, UnicodeDecodeError):
            return status, None


def percentile(values, p):
    if not values:
        return 0.0
    values = sorted(values)
    idx = min(len(values) - 1, int(round((p / 100.0) * (len(values) - 1))))
    return values[idx]


def step_torus(index):
    geo = ('SetFactory("OpenCASCADE");\n'
           f'Torus(1) = {{0, 0, 0, {8 + index % 5}, {2 + index % 3}}};\n')
    with tempfile.TemporaryDirectory() as tmp:
        geo_path = f"{tmp}/s{index}.geo"
        step_path = f"{tmp}/s{index}.step"
        with open(geo_path, "w", encoding="utf8") as handle:
            handle.write(geo)
        result = subprocess.run(["gmsh", "-3", geo_path, "-format", "step", "-o", step_path],
                                capture_output=True, text=True, timeout=300)
        if result.returncode != 0 or not __import__("os").path.exists(step_path):
            raise RuntimeError(f"gmsh failed for sample {index}")
        with open(step_path, "rb") as handle:
            return handle.read()


def upload(admin, folder_id, name, content):
    boundary = "----PE12Saturation"
    payload = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"folderId\"\r\n\r\n{folder_id}\r\n"
               f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
               f"Content-Type: application/octet-stream\r\n\r\n").encode() + content + f"\r\n--{boundary}--\r\n".encode()
    status, body = admin.request("POST", "/api/files", raw=payload,
                                 content_type=f"multipart/form-data; boundary={boundary}")
    try:
        return status, json.loads(body.decode())["data"]
    except (ValueError, KeyError, UnicodeDecodeError):
        return status, {}


ENDPOINTS = [
    ("/api/me", "GET", None),
    ("/api/files?folder={folder}&limit=50", "GET", None),
    ("/api/folders/tree", "GET", None),
]


def measure(admin, folder, samples, deadline):
    out = {name: [] for name, _, _ in ENDPOINTS}
    while time.time() < deadline:
        for name, method, _ in ENDPOINTS:
            path = name.replace("{folder}", folder)
            started = time.perf_counter()
            status, _ = admin.request(method, path)
            elapsed = (time.perf_counter() - started) * 1000.0
            if status == 200:
                out[name].append(elapsed)
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:18091")
    parser.add_argument("--admin-password-file", default=".secrets/admin.password")
    parser.add_argument("--samples", type=int, default=24)
    parser.add_argument("--baseline-seconds", type=int, default=10)
    args = parser.parse_args()
    host = up.urlsplit(args.base).hostname
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise RuntimeError("this acceptance run must target localhost only")
    with open(args.admin_password_file, encoding="utf8") as handle:
        admin_password = handle.read().strip()

    results = []

    def check(name, ok, detail):
        results.append((name, bool(ok), detail))

    admin = Session(args.base)
    status, body = admin.json("POST", "/api/login", {"login": "admin", "password": admin_password})
    check("admin login", status == 200, status)

    stamp = str(int(time.time()))
    status, tree = admin.json("GET", "/api/folders/tree")
    entries = (tree or {}).get("data") or []
    roots = [f for f in entries if not f.get("parentId")]
    root_id = roots[0]["id"] if roots else None
    status, folder = admin.json("POST", "/api/folders", {"parentId": root_id, "name": "PE12压测目录-" + stamp})
    folder_id = (folder or {}).get("data", {}).get("id") if status == 201 else None
    check("isolated folder created", folder_id is not None, folder_id)
    if not folder_id:
        return 1

    # Baseline with the worker idle.
    baseline = measure(admin, folder_id, None, time.time() + args.baseline_seconds)
    print("baseline p95:", {k: round(percentile(v, 95), 1) for k, v in baseline.items()}, flush=True)

    # Upload distinct samples and queue their conversions.
    file_ids = []
    for i in range(args.samples):
        try:
            content = step_torus(i)
        except RuntimeError as exc:
            check(f"sample {i} generated", False, str(exc)[:80])
            break
        status, uploaded = upload(admin, folder_id, f"pe12-{i}.step", content)
        file_id = (uploaded or {}).get("fileId") if status == 201 else None
        if not file_id:
            check(f"sample {i} uploaded", False, status)
            continue
        file_ids.append(file_id)
        admin.json("POST", f"/api/files/{file_id}/derivative")
    check("samples queued for conversion", len(file_ids) >= args.samples // 2, f"{len(file_ids)}/{args.samples}")

    # Measure while the worker drains the queue.
    saturation = measure(admin, folder_id, file_ids, time.time() + max(args.baseline_seconds, 15))
    print("saturation p95:", {k: round(percentile(v, 95), 1) for k, v in saturation.items()}, flush=True)

    for name, _, _ in ENDPOINTS:
        base_p95 = percentile(baseline[name], 95)
        sat_p95 = percentile(saturation[name], 95)
        ratio = (sat_p95 / base_p95) if base_p95 > 0 else 1.0
        check(f"PE12 degradation {name}", ratio <= 1.25,
              f"p95 {base_p95:.1f}ms -> {sat_p95:.1f}ms (x{ratio:.2f})")

    admin.json("DELETE", f"/api/folders/{folder_id}")
    check("cleanup completed", True, "folder soft-deleted")

    failed = [name for name, ok, _ in results if not ok]
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'} {name} :: {detail}")
    print(f"SUMMARY pass={len(results) - len(failed)} total={len(results)}")
    if failed:
        print("PE12_SATURATION_FAILED: " + ", ".join(failed), file=sys.stderr)
        return 1
    print("PE12_SATURATION_PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
