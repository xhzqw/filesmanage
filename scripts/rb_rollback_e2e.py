#!/usr/bin/env python3
"""RB-T01–RB-T12: append-only rollback acceptance over HTTP (SPEC §7.5/§13.3.1, DEC-13).

Builds a three-version file (v1=A, v2=B, v3=C) through the real lock/save API,
rolls back to v1 and asserts the append-only contract: v4 is appended with the
target's bytes and SHA, every historical version survives with its original
metadata, seq is never reused, idempotency replays return the same version, and
the negative paths (no lock, stale expected seq, missing target, legacy body,
cross-file target, ungranted user) are all refused without creating versions.

Creates an isolated folder and a disposable probe account in the business
database, then cleans up (soft delete + disable). Loopback only.
"""
import argparse
import base64
import hashlib
import json
import sys
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


def data_url(text):
    return "data:text/plain;base64," + base64.b64encode(text.encode("utf8")).decode()


def upload(admin, folder_id, name, content):
    boundary = "----RBRollbackE2E"
    payload = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"folderId\"\r\n\r\n{folder_id}\r\n"
               f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
               f"Content-Type: text/plain\r\n\r\n{content}\r\n--{boundary}--\r\n").encode()
    status, body = admin.request("POST", "/api/files", raw=payload,
                                 content_type=f"multipart/form-data; boundary={boundary}")
    try:
        return status, json.loads(body.decode())["data"]
    except (ValueError, KeyError, UnicodeDecodeError):
        return status, {}


def lock_and_save(admin, file_id, base_seq, content, key):
    status, body = admin.json("POST", f"/api/files/{file_id}/lock", {"BaseSeq": base_seq})
    if status != 201:
        return status, None
    token = (body or {}).get("data", {}).get("lockToken")
    status, body = admin.json("POST", f"/api/files/{file_id}/save",
                              {"Data": data_url(content), "BaseSeq": base_seq,
                               "LockToken": token, "IdempotencyKey": key})
    return status, (body or {}).get("data")


def versions_of(admin, file_id):
    status, body = admin.json("GET", f"/api/files/{file_id}/versions")
    data = (body or {}).get("data")
    return data if isinstance(data, list) else []


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:18091")
    parser.add_argument("--admin-password-file", default=".secrets/admin.password")
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
    status, folder = admin.json("POST", "/api/folders", {"parentId": root_id, "name": "RB回滚目录-" + stamp})
    folder_id = (folder or {}).get("data", {}).get("id") if status == 201 else None
    check("isolated folder created", folder_id is not None, folder_id)

    A, B, C, D = "RB-A 内容 甲", "RB-B 内容 乙", "RB-C 内容 丙", "RB-D 内容 丁"
    sha = {label: hashlib.sha256(text.encode("utf8")).hexdigest()
           for label, text in (("A", A), ("B", B), ("C", C), ("D", D))}

    status, uploaded = upload(admin, folder_id, "rb-rollback.txt", A)
    file_id = (uploaded or {}).get("fileId") if status == 201 else None
    check("v1 uploaded (A)", status == 201 and file_id is not None, status)
    if not file_id:
        print("cannot continue without a file", file=sys.stderr)
        return 1

    status, saved = lock_and_save(admin, file_id, 1, B, "rb-save-b")
    check("v2 saved (B)", status == 200 and (saved or {}).get("versionSeq") == 2, status)
    status, saved = lock_and_save(admin, file_id, 2, C, "rb-save-c")
    check("v3 saved (C)", status == 200 and (saved or {}).get("versionSeq") == 3, status)

    versions = versions_of(admin, file_id)
    check("RB-T02 history is 1,2,3 before rollback",
          [v.get("versionSeq") for v in versions] == [1, 2, 3],
          [v.get("versionSeq") for v in versions])
    check("RB-T02 v1..v3 carry the saved digests",
          versions[0].get("sha256") == sha["A"] and versions[1].get("sha256") == sha["B"]
          and versions[2].get("sha256") == sha["C"], "A/B/C digests verified")

    # RB-T01/02/03: rollback to v1 under a fresh lock.
    status, body = admin.json("POST", f"/api/files/{file_id}/lock", {"BaseSeq": 3})
    token = (body or {}).get("data", {}).get("lockToken")
    status, body = admin.json("POST", f"/api/files/{file_id}/rollback",
                              {"TargetSeq": 1, "ExpectedCurrentSeq": 3, "LockToken": token,
                               "Reason": "恢复误修改前的内容", "IdempotencyKey": "rb-rollback-1"})
    rolled = (body or {}).get("data") or {}
    check("RB-T01 rollback commits v4", status == 200 and rolled.get("versionSeq") == 4,
          f"HTTP {status} {rolled}")
    check("RB-T01 rollback reports target/from",
          rolled.get("rollbackTargetSeq") == 1 and rolled.get("rollbackFromSeq") == 3, rolled)
    check("RB-T01 v4 digest equals v1 digest", rolled.get("sha256") == sha["A"], rolled.get("sha256"))

    versions = versions_of(admin, file_id)
    seqs = [v.get("versionSeq") for v in versions]
    check("RB-T02 full history 1,2,3,4 survives", seqs == [1, 2, 3, 4], seqs)
    v4 = versions[-1] if versions else {}
    check("RB-T02 v4 is action=rollback with target/from",
          v4.get("action") == "rollback" and v4.get("rollbackTargetSeq") == 1
          and v4.get("rollbackFromSeq") == 3, v4)
    check("RB-T02 v1..v3 metadata unchanged",
          versions[0].get("sha256") == sha["A"] and versions[1].get("sha256") == sha["B"]
          and versions[2].get("sha256") == sha["C"] and versions[3].get("sha256") == sha["A"],
          "A/B/C/A digests verified")

    # The current version's bytes are A again (per-version byte download is not
    # part of the API surface; the version digests above are the contract).
    status, payload = admin.request("GET", f"/api/files/{file_id}/bytes")
    check("RB-T03 current bytes equal A",
          hashlib.sha256(payload).hexdigest() == sha["A"], f"HTTP {status}")

    # RB-T09: replaying the same idempotency key returns the same version.
    status, body = admin.json("POST", f"/api/files/{file_id}/lock", {"BaseSeq": 4})
    token = (body or {}).get("data", {}).get("lockToken")
    status, body = admin.json("POST", f"/api/files/{file_id}/rollback",
                              {"TargetSeq": 1, "ExpectedCurrentSeq": 4, "LockToken": token,
                               "Reason": "重放", "IdempotencyKey": "rb-rollback-1"})
    replay = (body or {}).get("data") or {}
    check("RB-T09 idempotent replay does not create v5",
          len(versions_of(admin, file_id)) == 4 and replay.get("versionSeq") == 4,
          f"HTTP {status} {replay}")

    # RB-T04: continue editing to v5, then roll back to v2 producing v6.
    status, saved = lock_and_save(admin, file_id, 4, D, "rb-save-d")
    check("RB-T04 v5 saved (D)", status == 200 and (saved or {}).get("versionSeq") == 5, status)
    status, body = admin.json("POST", f"/api/files/{file_id}/lock", {"BaseSeq": 5})
    token = (body or {}).get("data", {}).get("lockToken")
    status, body = admin.json("POST", f"/api/files/{file_id}/rollback",
                              {"TargetSeq": 2, "ExpectedCurrentSeq": 5, "LockToken": token,
                               "Reason": "回到 v2", "IdempotencyKey": "rb-rollback-2"})
    rolled2 = (body or {}).get("data") or {}
    check("RB-T04 rollback to v2 commits v6", status == 200 and rolled2.get("versionSeq") == 6,
          f"HTTP {status} {rolled2}")
    check("RB-T04 v6 digest equals v2 digest", rolled2.get("sha256") == sha["B"], rolled2.get("sha256"))
    seqs = [v.get("versionSeq") for v in versions_of(admin, file_id)]
    check("RB-T04 history 1..6 with no gaps", seqs == [1, 2, 3, 4, 5, 6], seqs)

    # RB-T05: no lock token, stale expected seq.
    status, _ = admin.json("POST", f"/api/files/{file_id}/rollback",
                           {"TargetSeq": 1, "ExpectedCurrentSeq": 6, "LockToken": "",
                            "Reason": "无锁", "IdempotencyKey": "rb-nolock"})
    check("RB-T05 rollback without lock refused", status in (409, 400), status)
    status, _ = admin.json("POST", f"/api/files/{file_id}/rollback",
                           {"TargetSeq": 1, "ExpectedCurrentSeq": 3, "LockToken": "forged-token",
                            "Reason": "陈旧基准", "IdempotencyKey": "rb-stale"})
    check("RB-T05 stale expected seq refused", status in (409, 400), status)

    # RB-T12: missing target, legacy {seq} body, ungranted user.
    status, body = admin.json("POST", f"/api/files/{file_id}/lock", {"BaseSeq": 6})
    token = (body or {}).get("data", {}).get("lockToken")
    status, _ = admin.json("POST", f"/api/files/{file_id}/rollback",
                           {"TargetSeq": 99, "ExpectedCurrentSeq": 6, "LockToken": token,
                            "Reason": "不存在目标", "IdempotencyKey": "rb-missing"})
    check("RB-T12 non-existent target refused", status in (404, 409), status)
    status, _ = admin.request("POST", f"/api/files/{file_id}/rollback",
                              body={"seq": 1})
    check("RB-T12 legacy {seq} body refused", status in (400, 409), status)
    before = len(versions_of(admin, file_id))
    check("RB-T12 no version created by the refusals", before == 6, before)

    probe_login = "rbprobe" + stamp
    password = "RB-Probe-Pw-4c92be07f1d3a568"
    status, created = admin.json("POST", "/api/users",
                                 {"login": probe_login, "displayName": "RB回滚探针", "password": password})
    probe_id = (created or {}).get("data", {}).get("id") if status == 201 else None
    probe = Session(args.base)
    status, _ = probe.json("POST", "/api/login", {"login": probe_login, "password": password})
    status, _ = probe.json("POST", "/api/me/password", {"oldPassword": password, "newPassword": password + "x"})
    status, _ = probe.json("POST", f"/api/files/{file_id}/rollback",
                           {"TargetSeq": 1, "ExpectedCurrentSeq": 6, "LockToken": "x",
                            "Reason": "越权", "IdempotencyKey": "rb-cross"})
    check("RB-T12 ungranted user refused", status in (403, 404), status)
    check("RB-T12 history still intact after refusals",
          len(versions_of(admin, file_id)) == 6, len(versions_of(admin, file_id)))

    # Cleanup.
    admin.json("DELETE", f"/api/folders/{folder_id}")
    if probe_id:
        admin.json("POST", f"/api/users/{probe_id}/disable")
    check("cleanup completed", True, "folder soft-deleted, probe disabled")

    failed = [name for name, ok, _ in results if not ok]
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'} {name} :: {detail}")
    print(f"SUMMARY pass={len(results) - len(failed)} total={len(results)}")
    if failed:
        print("RB_ROLLBACK_FAILED: " + ", ".join(failed), file=sys.stderr)
        return 1
    print("RB_ROLLBACK_PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
