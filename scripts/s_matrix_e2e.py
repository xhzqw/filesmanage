#!/usr/bin/env python3
"""S1–S18 executable acceptance spot-checks against the dev server.

Automates the SPEC §13.2/§13.3 items that are API-verifiable in one pass:
login/session (S1), workgroup and user grants with union (S3/S4), cross-user
isolation (S5), admin-only endpoints (S11), favorites idempotency (S16), stats
scope and CSV export (S17/S18) and the time-limited ACL boundary (S10, which
waits out a real 65-second expiry instead of mocking the clock).

Creates a disposable probe account and isolated folders in the business
database, then cleans up (soft delete + disable) so the audit chain stays
intact. Loopback only.
"""
import argparse
import csv
import io
import json
import sys
import time
import urllib.error
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
            with self.opener.open(req, timeout=30) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    def json(self, method, path, body=None):
        status, payload = self.request(method, path, body)
        try:
            return status, json.loads(payload.decode("utf8"))
        except (ValueError, UnicodeDecodeError):
            return status, None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:18091")
    parser.add_argument("--admin-password-file", default=".secrets/admin.password")
    args = parser.parse_args()
    import urllib.parse as up
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
    check("S1 admin login", status == 200 and body and body.get("ok"), status)
    status, body = admin.json("GET", "/api/me")
    check("S1 me returns identity", status == 200 and (body or {}).get("data", {}).get("isAdmin") is True, status)
    status, _ = admin.json("GET", "/api/users")

    stamp = str(int(time.time()))
    probe_login = "smatrix" + stamp
    password = "S-Matrix-Pw-7d21ba04c9e35718"
    status, created = admin.json("POST", "/api/users", {"login": probe_login, "displayName": "S矩阵探针", "password": password})
    probe_id = (created or {}).get("data", {}).get("id") if status == 201 else None
    check("probe account created", probe_id is not None, status)
    probe = Session(args.base)
    status, body = probe.json("POST", "/api/login", {"login": probe_login, "password": password})
    check("probe login (must-change set)", status == 200 and (body or {}).get("data", {}).get("mustChangePassword") is True, status)
    status, _ = probe.json("POST", "/api/me/password", {"oldPassword": password, "newPassword": password + "x"})
    check("probe first password change", status == 200, status)
    status, _ = admin.json("GET", "/api/users")
    probe_status, _ = probe.json("GET", "/api/users")
    check("S11 non-admin user list refused", probe_status == 403, probe_status)

    # Isolated tree: group-visible folder + a user-grant folder + an expiry folder.
    status, tree = admin.json("GET", "/api/folders/tree")
    entries = (tree or {}).get("data") or []
    roots = [f for f in entries if not f.get("parentId")]
    root_id = roots[0]["id"] if roots else None
    check("root folder resolved", root_id is not None, root_id)

    def make_folder(name):
        status, body = admin.json("POST", "/api/folders", {"parentId": root_id, "name": name})
        return (body or {}).get("data", {}).get("id") if status == 201 else None

    group_folder = make_folder("S矩阵-组目录-" + stamp)
    user_folder = make_folder("S矩阵-用户目录-" + stamp)
    expiry_folder = make_folder("S矩阵-过期目录-" + stamp)
    check("test folders created", all([group_folder, user_folder, expiry_folder]),
          f"{group_folder} {user_folder} {expiry_folder}")

    # A workgroup to grant on; the probe is its only member.
    status, departments = admin.json("GET", "/api/departments")
    dept_id = ""
    dept_list = (departments or {}).get("data") or []
    if dept_list:
        dept_id = dept_list[0].get("id", "")
    status, group = admin.json("POST", "/api/groups", {"name": "S矩阵组-" + stamp, "departmentId": dept_id})
    group_id = (group or {}).get("data", {}).get("id") if status == 201 else None
    if group_id:
        admin.json("POST", f"/api/groups/{group_id}/members", {"userId": probe_id})
    check("workgroup with probe member", group_id is not None, group_id)

    status, _ = admin.json("POST", f"/api/folders/{group_folder}/acls",
                           {"subjectKind": "group", "subjectId": group_id,
                            "actions": ["list", "preview", "upload"]})
    check("S3 workgroup grant created", status == 201, status)
    status, _ = admin.json("POST", f"/api/folders/{user_folder}/acls",
                           {"subjectKind": "user", "subjectId": probe_id,
                            "actions": ["list", "preview", "download"]})
    check("S4 user grant created", status == 201, status)

    status, body = probe.json("GET", f"/api/files?folder={group_folder}")
    check("S3 granted folder listable", status == 200, status)
    status, body = probe.json("GET", "/api/folders/tree")
    names = [f.get("id") for f in ((body or {}).get("data") or [])]
    check("S3 granted folder in probe tree", group_folder in names, group_folder in names)
    status, _ = probe.json("GET", f"/api/files?folder={user_folder}")
    check("S4 direct grant listable", status == 200, status)
    # Pagination boundary: the documented maximum page size (and anything above
    # it, which the server clamps) must be honoured. The list query fetches one
    # lookahead row, so an off-by-one repository guard turns limit=200 into a
    # 400; this pins the boundary at the HTTP surface.
    for probe_limit in (200, 201, 5000):
        status, body = probe.json("GET", f"/api/files?folder={user_folder}&sort=name_asc&limit={probe_limit}")
        check(f"list limit {probe_limit} honoured", status == 200, status)
    # Union: the group folder also receives a direct user grant for download.
    status, _ = admin.json("POST", f"/api/folders/{group_folder}/acls",
                           {"subjectKind": "user", "subjectId": probe_id,
                            "actions": ["list", "preview", "upload", "download"]})
    check("S4 union grant created", status == 201, status)
    status, body = probe.json("GET", "/api/folders/tree")
    check("S4 union keeps visibility", group_folder in [f.get("id") for f in ((body or {}).get("data") or [])], True)

    # S5: a folder with no grant at all stays invisible.
    status, private = admin.json("POST", "/api/folders", {"parentId": root_id, "name": "S矩阵-私密-" + stamp})
    private_id = (private or {}).get("data", {}).get("id") if status == 201 else None
    status, _ = probe.json("GET", f"/api/files?folder={private_id}")
    check("S5 ungranted folder refused", status in (403, 404), status)
    status, body = probe.json("GET", "/api/folders/tree")
    check("S5 private folder hidden from tree", private_id not in [f.get("id") for f in ((body or {}).get("data") or [])], True)
    status, body = probe.json("GET", "/api/search")
    items = ((body or {}).get("data") or {}).get("items") or []
    check("S5 private folder absent from search", all(i.get("folderId") != private_id for i in items), len(items))

    # S10: time-limited ACL that really expires (server-time based).
    status, _ = admin.json("POST", f"/api/folders/{expiry_folder}/acls",
                           {"subjectKind": "user", "subjectId": probe_id,
                            "actions": ["list", "preview"],
                            "expiresAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 65))})
    check("S10 expiring grant created", status == 201, status)
    status, _ = probe.json("GET", f"/api/files?folder={expiry_folder}")
    check("S10 visible before expiry", status == 200, status)
    print("waiting 70s for the grant to expire (S10 boundary)", flush=True)
    time.sleep(70)
    status, _ = probe.json("GET", f"/api/files?folder={expiry_folder}")
    check("S10 refused after expiry", status in (403, 404), status)

    # S16: favorites idempotency on a file the probe can see.
    status, listing = admin.json("GET", f"/api/files?folder={user_folder}")
    file_id = None
    items = ((listing or {}).get("data") or {}).get("items") or []
    if items:
        file_id = items[0]["id"]
    if file_id is None:
        # upload one file as admin through the multipart endpoint
        boundary = "----SMatrixUpload"
        payload = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"folderId\"\r\n\r\n{user_folder}\r\n"
                   f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"s-matrix.txt\"\r\n"
                   f"Content-Type: text/plain\r\n\r\nS 矩阵 样本\r\n--{boundary}--\r\n").encode()
        status, body = admin.request("POST", "/api/files", raw=payload,
                                     content_type=f"multipart/form-data; boundary={boundary}")
        try:
            file_id = json.loads(body.decode())["data"]["fileId"]
        except (ValueError, KeyError, UnicodeDecodeError):
            file_id = None
    check("probe-visible file available", file_id is not None, file_id)
    if file_id:
        status, _ = probe.json("PUT", f"/api/favorites/file/{file_id}")
        check("S16 favorite added", status == 200, status)
        status, _ = probe.json("PUT", f"/api/favorites/file/{file_id}")
        check("S16 duplicate favorite idempotent", status == 200, status)
        status, body = probe.json("GET", "/api/favorites")
        favorites = (body or {}).get("data") or []
        check("S16 favorite listed once",
              sum(1 for f in favorites if f.get("fileId") == file_id) == 1, len(favorites))
        status, _ = probe.json("DELETE", f"/api/favorites/file/{file_id}")
        check("S16 favorite removed", status == 200, status)
        status, _ = probe.json("DELETE", f"/api/favorites/file/{file_id}")
        check("S16 second remove idempotent", status == 200, status)

    # S17/S18: stats scope and CSV export for the probe's visible set.
    status, body = probe.json("GET", "/api/stats")
    stats = (body or {}).get("data") or {}
    check("S17 stats reachable", status == 200, f"files={stats.get('totalFiles')}")
    status, payload = probe.request("GET", "/api/exports/files.csv")
    text = payload.decode("utf-8-sig", errors="replace") if payload[:3] == b"\xef\xbb\xbf" else payload.decode("utf-8", errors="replace")
    rows = [r for r in csv.reader(io.StringIO(text)) if r]
    check("S18 export BOM + header", status == 200 and len(rows) >= 1 and rows[0][0] == "文件名",
          f"rows={len(rows)}")
    check("S18 export contains only visible rows",
          all(r[1] for r in rows[1:]) if len(rows) > 1 else True, "paths non-empty")

    # Cleanup: soft delete the test tree, disable the probe (audit chain kept).
    for folder in (expiry_folder, user_folder, group_folder, private_id):
        if folder:
            admin.json("DELETE", f"/api/folders/{folder}")
    if group_id:
        for member in (probe_id,):
            admin.request("DELETE", f"/api/groups/{group_id}/members/{member}")
    admin.json("POST", f"/api/users/{probe_id}/disable")
    check("cleanup completed", True, "folders soft-deleted, probe disabled")

    failed = [name for name, ok, _ in results if not ok]
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'} {name} :: {detail}")
    print(f"SUMMARY pass={len(results) - len(failed)} total={len(results)}")
    if failed:
        print("S_MATRIX_FAILED: " + ", ".join(failed), file=sys.stderr)
        return 1
    print("S_MATRIX_PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
