#!/usr/bin/env python3
"""Authenticated cross-user security E2E for M7 (G-SEC / PE04 / S15).

Creates a disposable probe account and a secured folder in the business
database, then verifies that a folder filter can never be used to read another
user's data, that grants and folder shares take effect immediately, and that
revocation is visible on the very next request. Cleanup soft-deletes the folder
and disables the probe account, leaving the audit trail intact.

Loopback only. Run on the target host as root:

    python3 scripts/m7_security_e2e.py --base http://127.0.0.1:18091 \
        --admin-password-file .secrets/admin.password
"""
import argparse
import csv
import io
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

INITIAL_PASSWORD = "M7-Probe-Pw-9f27c11791439429x"
ROTATED_PASSWORD = "M7-Probe-Rotated-8c15ae03b2745190y"


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
            with self.opener.open(req, timeout=15) as response:
                payload = response.read()
                return response.status, payload
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    def json(self, method, path, body=None):
        status, payload = self.request(method, path, body)
        try:
            return status, json.loads(payload.decode("utf8"))
        except (ValueError, UnicodeDecodeError):
            return status, None

    def upload(self, folder_id, filename, content):
        boundary = "----M7SecurityE2E9f27c117"
        parts = [
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"folderId\"\r\n\r\n{folder_id}\r\n".encode(),
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n"
            f"Content-Type: text/plain\r\n\r\n".encode() + content + b"\r\n",
            f"--{boundary}--\r\n".encode(),
        ]
        status, payload = self.request("POST", "/api/files", raw=b"".join(parts),
                                       content_type=f"multipart/form-data; boundary={boundary}")
        try:
            return status, json.loads(payload.decode("utf8"))
        except (ValueError, UnicodeDecodeError):
            return status, None


def decode_csv(payload):
    text = payload.decode("utf-8", errors="replace")
    return text[1:] if text.startswith("\ufeff") else text


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:18091")
    parser.add_argument("--admin-password-file", default=".secrets/admin.password")
    args = parser.parse_args()
    host = urllib.parse.urlsplit(args.base).hostname
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise RuntimeError("this security E2E must target localhost only")
    with open(args.admin_password_file, encoding="utf8") as handle:
        admin_password = handle.read().strip()

    results = []

    def check(name, condition, detail):
        results.append((name, bool(condition), detail))

    admin = Session(args.base)
    status, body = admin.json("POST", "/api/login", {"login": "admin", "password": admin_password})
    check("admin login", status == 200 and body and body.get("ok"), status)

    status, tree = admin.json("GET", "/api/folders/tree")
    entries = (tree or {}).get("data") or []
    roots = [f for f in entries if not f.get("parentId")]
    root_id = roots[0]["id"] if roots else (entries[0]["id"] if entries else None)
    check("root folder resolved", root_id is not None, root_id)

    import time
    stamp = str(int(time.time()))
    probe_login = "m7probe" + stamp
    status, created = admin.json("POST", "/api/users", {
        "login": probe_login, "displayName": "M7安全探针", "password": INITIAL_PASSWORD,
    })
    probe_id = (created or {}).get("data", {}).get("id") if status == 201 else None
    check("probe user created", probe_id is not None, status)

    probe = Session(args.base)
    status, body = probe.json("POST", "/api/login", {"login": probe_login, "password": INITIAL_PASSWORD})
    must_change = bool((body or {}).get("data", {}).get("mustChangePassword"))
    check("probe first login demands password change", status == 200 and must_change, status)
    status, _ = probe.json("POST", "/api/me/password", {"oldPassword": INITIAL_PASSWORD, "newPassword": ROTATED_PASSWORD})
    check("probe password change clears the flag", status == 200, status)

    # Secured folder with one file; the probe has no grant on it.
    status, folder = admin.json("POST", "/api/folders", {"parentId": root_id, "name": "M7安全目录-" + stamp})
    folder_id = (folder or {}).get("data", {}).get("id") if status == 201 else None
    check("secured folder created", folder_id is not None, status)
    status, uploaded = admin.upload(folder_id, "m7-机密.txt", "M7机密内容".encode())
    file_id = (uploaded or {}).get("data", {}).get("fileId") if status == 201 else None
    check("file uploaded into secured folder", file_id is not None, status)

    # Phase 1 — no grant: every folder-filtered read must stay empty/refused.
    status, _ = probe.json("GET", f"/api/files?folder={folder_id}")
    check("ungranted file list refused", status in (403, 404), status)
    status, body = probe.json("GET", f"/api/search?folder={folder_id}&limit=50")
    total = ((body or {}).get("data") or {}).get("total")
    check("ungranted folder-filtered search empty", status == 200 and total == 0, f"HTTP {status} total={total}")
    status, body = probe.json("GET", f"/api/search?folder={folder_id}&scope=descendants&limit=50")
    total = ((body or {}).get("data") or {}).get("total")
    check("ungranted descendants search empty", status == 200 and total == 0, f"HTTP {status} total={total}")
    status, body = probe.json("GET", f"/api/stats?folder={folder_id}")
    stats = (body or {}).get("data") or {}
    check("ungranted folder-filtered stats zeroed",
          status == 200 and stats.get("totalFiles") == 0 and stats.get("totalFolders") == 0,
          f"HTTP {status} files={stats.get('totalFiles')} folders={stats.get('totalFolders')}")
    status, payload = probe.request("GET", f"/api/exports/files.csv?folder={folder_id}")
    text = decode_csv(payload)
    rows = [r for r in csv.reader(io.StringIO(text)) if r]
    check("ungranted export carries no data rows", status == 200 and len(rows) <= 1, f"HTTP {status} rows={len(rows)}")
    status, body = probe.json("GET", "/api/folders/tree")
    names = [f.get("id") for f in ((body or {}).get("data") or [])]
    check("secured folder absent from probe tree", folder_id not in names, folder_id in names)

    # Phase 2 — grant takes effect on the next request.
    status, grant = admin.json("POST", f"/api/folders/{folder_id}/acls", {
        "subjectKind": "user", "subjectId": probe_id,
        "actions": ["list", "preview", "download"],
    })
    grant_id = (grant or {}).get("data", {}).get("id") if status == 201 else None
    check("grant created", grant_id is not None, status)
    status, body = probe.json("GET", f"/api/files?folder={folder_id}")
    items = ((body or {}).get("data") or {}).get("items") or []
    check("granted file list visible", status == 200 and len(items) >= 1, f"HTTP {status} items={len(items)}")
    status, body = probe.json("GET", f"/api/search?folder={folder_id}&limit=50")
    total = ((body or {}).get("data") or {}).get("total")
    check("granted folder-filtered search sees the file", status == 200 and (total or 0) >= 1,
          f"HTTP {status} total={total}")
    status, payload = probe.request("GET", f"/api/exports/files.csv?folder={folder_id}")
    text = decode_csv(payload)
    rows = [r for r in csv.reader(io.StringIO(text)) if r]
    check("granted export streams data rows", status == 200 and len(rows) >= 2, f"HTTP {status} rows={len(rows)}")

    # Phase 3 — revocation is immediate on the next request (PE04).
    status, _ = admin.json("DELETE", f"/api/acls/{grant_id}")
    check("grant revoked", status == 200, status)
    status, _ = probe.json("GET", f"/api/files?folder={folder_id}")
    check("revoked list refused immediately", status in (403, 404), status)
    status, body = probe.json("GET", f"/api/search?folder={folder_id}&limit=50")
    total = ((body or {}).get("data") or {}).get("total")
    check("revoked search empty immediately", status == 200 and total == 0, f"HTTP {status} total={total}")

    # Phase 4 — folder share with descendants reaches child folders (S15).
    status, subfolder = admin.json("POST", "/api/folders", {"parentId": folder_id, "name": "M7子目录-" + stamp})
    sub_id = (subfolder or {}).get("data", {}).get("id") if status == 201 else None
    check("child folder created", sub_id is not None, status)
    status, uploaded = admin.upload(sub_id, "m7-子目录文件.txt", "子目录内容".encode())
    check("file uploaded into child folder", status == 201, status)
    status, share = admin.json("POST", "/api/shares", {
        "resourceKind": "folder", "resourceId": folder_id,
        "recipientKind": "user", "recipientId": probe_id,
        "actions": ["list", "preview"], "includeDescendants": True,
    })
    share_id = (share or {}).get("data", {}).get("id") if status == 201 else None
    check("folder share with descendants created", share_id is not None, status)
    status, body = probe.json("GET", f"/api/search?folder={folder_id}&scope=descendants&limit=50")
    total = ((body or {}).get("data") or {}).get("total")
    check("share with descendants reaches child files", status == 200 and (total or 0) >= 1,
          f"HTTP {status} total={total}")
    status, body = probe.json("GET", f"/api/files?folder={sub_id}")
    items = ((body or {}).get("data") or {}).get("items") or []
    check("shared child folder listable", status == 200 and len(items) >= 1, f"HTTP {status} items={len(items)}")

    # Phase 5 — revoking the share closes access immediately.
    status, _ = admin.json("DELETE", f"/api/shares/{share_id}")
    check("share revoked", status == 200, status)
    status, _ = probe.json("GET", f"/api/files?folder={sub_id}")
    check("revoked share refuses child list", status in (403, 404), status)
    status, body = probe.json("GET", f"/api/search?folder={folder_id}&scope=descendants&limit=50")
    total = ((body or {}).get("data") or {}).get("total")
    check("revoked share empties descendants search", status == 200 and total == 0, f"HTTP {status} total={total}")

    # Cleanup: soft delete the secured tree, disable the probe account.
    status, _ = admin.json("DELETE", f"/api/folders/{folder_id}")
    check("secured folder soft-deleted", status == 200, status)
    status, _ = admin.json("POST", f"/api/users/{probe_id}/disable")
    check("probe account disabled", status == 200, status)
    status, _ = probe.json("GET", "/api/me")
    check("disabled probe session rejected", status in (401, 403), status)

    failed = [name for name, ok, _ in results if not ok]
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'} {name} :: {detail}")
    print(f"SUMMARY pass={len(results) - len(failed)} total={len(results)}")
    if failed:
        print("SECURITY_E2E_FAILED: " + ", ".join(failed), file=sys.stderr)
        return 1
    print("SECURITY_E2E_PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
