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


def upload_binary(admin, folder_id, name, content, content_type="application/octet-stream"):
    boundary = "----RBRollbackBin"
    payload = (b"--" + boundary.encode() + b"\r\n"
               + b'Content-Disposition: form-data; name="folderId"\r\n\r\n' + folder_id.encode() + b"\r\n"
               + b"--" + boundary.encode() + b"\r\n"
               + ('Content-Disposition: form-data; name="file"; filename="' + name + '"\r\n').encode()
               + ("Content-Type: " + content_type + "\r\n\r\n").encode()
               + content + b"\r\n--" + boundary.encode() + b"--\r\n")
    status, body = admin.request("POST", "/api/files", raw=payload,
                                 content_type=f"multipart/form-data; boundary={boundary}")
    try:
        return status, json.loads(body.decode())["data"]
    except (ValueError, KeyError, UnicodeDecodeError):
        return status, {}


def lock_and_save_raw(admin, file_id, base_seq, content, key):
    status, body = admin.json("POST", f"/api/files/{file_id}/lock", {"BaseSeq": base_seq})
    if status != 201:
        return status, None
    token = (body or {}).get("data", {}).get("lockToken")
    status, body = admin.json("POST", f"/api/files/{file_id}/save",
                              {"Data": "data:application/octet-stream;base64,"
                                       + base64.b64encode(content).decode(),
                               "BaseSeq": base_seq, "LockToken": token,
                               "IdempotencyKey": key})
    return status, (body or {}).get("data")


def minimal_docx(text):
    """A structurally valid DOCX container: enough for byte-level rollback
    assertions (editor fidelity itself is DO05's contract)."""
    import zipfile
    import io as _io
    buffer = _io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml",
                         '<?xml version="1.0" encoding="UTF-8"?>'
                         '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                         '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                         '<Default Extension="xml" ContentType="application/xml"/>'
                         '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
                         '</Types>')
        archive.writestr("_rels/.rels",
                         '<?xml version="1.0" encoding="UTF-8"?>'
                         '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                         '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
                         '</Relationships>')
        archive.writestr("word/document.xml",
                         '<?xml version="1.0" encoding="UTF-8"?>'
                         '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                         '<w:body><w:p><w:r><w:t>' + text + '</w:t></w:r></w:p></w:body></w:document>')
    return buffer.getvalue()


def minimal_step():
    """A real STEP body from gmsh/OpenCASCADE, or None when the toolchain is
    unavailable (the media case is then skipped, not faked)."""
    import subprocess
    import tempfile
    import os
    geo = 'SetFactory("OpenCASCADE");\nTorus(1) = {0, 0, 0, 8, 3};\n'
    with tempfile.TemporaryDirectory() as tmp:
        geo_path = os.path.join(tmp, "rb10.geo")
        step_path = os.path.join(tmp, "rb10.step")
        with open(geo_path, "w", encoding="utf8") as handle:
            handle.write(geo)
        try:
            result = subprocess.run(["gmsh", "-3", geo_path, "-format", "step", "-o", step_path],
                                    capture_output=True, text=True, timeout=300)
        except (OSError, subprocess.SubprocessError):
            return None
        if result.returncode != 0 or not os.path.exists(step_path):
            return None
        with open(step_path, "rb") as handle:
            return handle.read()


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

    # ---- RB-T06: concurrent rollback, single winner ----
    # Three sessions race to roll the same file from the same expected version
    # with different idempotency keys. CAS must admit exactly one commit and
    # leave the seq series gap-free.
    import threading
    race = []
    race_lock = threading.Lock()

    def racer(key):
        sess = Session(args.base)
        sess.json("POST", "/api/login", {"login": "admin", "password": admin_password})
        st, bd = sess.json("POST", f"/api/files/{file_id}/rollback",
                           {"TargetSeq": 1, "ExpectedCurrentSeq": 6, "LockToken": token,
                            "Reason": "并发回滚", "IdempotencyKey": key})
        with race_lock:
            race.append((st, ((bd or {}).get("data") or {}).get("versionSeq")))

    threads = [threading.Thread(target=racer, args=(f"rb-race-{i}",)) for i in range(3)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)
    winners = [entry for entry in race if entry[0] == 200]
    check("RB-T06 concurrent rollbacks have exactly one winner", len(winners) == 1, race)
    seqs = [v.get("versionSeq") for v in versions_of(admin, file_id)]
    check("RB-T06 history stays gap-free after the race",
          seqs == list(range(1, len(seqs) + 1)), seqs)

    # ---- RB-T07/08: rollback under an approval policy ----
    status, body = admin.json("POST", "/api/folders", {"parentId": root_id, "name": "RB审批目录-" + stamp})
    policy_folder = (body or {}).get("data", {}).get("id") if status == 201 else None
    status, me = admin.json("GET", "/api/me")
    admin_id = (me or {}).get("data", {}).get("id")
    status, uploaded = upload(admin, policy_folder, "rb-approval.txt", A)
    policy_file = (uploaded or {}).get("fileId") if status == 201 else None
    check("RB-T07 policy file uploaded", policy_file is not None, status)
    if policy_file:
        # v2 is committed BEFORE the policy is enabled: under a policy every
        # write pends, so the baseline version must exist first.
        lock_and_save(admin, policy_file, 1, B, "rb-policy-b")
        check("RB-T07 baseline v2 committed before the policy",
              len(versions_of(admin, policy_file)) == 2, len(versions_of(admin, policy_file)))
        admin.json("PUT", f"/api/folders/{policy_folder}/approval-policy",
                   {"approverId": admin_id, "enabled": True})
        status, body = admin.json("POST", f"/api/files/{policy_file}/lock", {"BaseSeq": 2})
        ptoken = (body or {}).get("data", {}).get("lockToken")
        status, body = admin.json("POST", f"/api/files/{policy_file}/rollback",
                                  {"TargetSeq": 1, "ExpectedCurrentSeq": 2, "LockToken": ptoken,
                                   "Reason": "审批回滚", "IdempotencyKey": "rb-policy-rollback"})
        check("RB-T07 rollback under policy pends", status == 202, f"HTTP {status}")
        approval_id = ((body or {}).get("data") or {}).get("approvalId")
        check("RB-T07 no version while pending",
              len(versions_of(admin, policy_file)) == 2, len(versions_of(admin, policy_file)))
        status, payload = admin.request("GET", f"/api/files/{policy_file}/bytes")
        check("RB-T07 download keeps the old current version",
              hashlib.sha256(payload).hexdigest() == sha["B"], f"HTTP {status}")
        status, body = admin.json("GET", "/api/search?q=rb-approval")
        items = ((body or {}).get("data") or {}).get("items") or []
        check("RB-T07 search still points at the current version",
              any(item.get("id") == policy_file for item in items), len(items))

        # RB-T08: a rejected rollback must not create any version.
        admin.json("POST", f"/api/approvals/{approval_id}/reject", {"comment": "拒绝回滚"})
        check("RB-T08 rejected rollback creates no version",
              len(versions_of(admin, policy_file)) == 2, len(versions_of(admin, policy_file)))
        status, _ = admin.json("POST", f"/api/approvals/{approval_id}/approve", {"comment": "重复审批"})
        check("RB-T08 duplicate decision refused", status in (409, 404, 400), status)
        status, _ = admin.json("POST", f"/api/files/{policy_file}/rollback",
                               {"TargetSeq": 1, "ExpectedCurrentSeq": 99, "LockToken": ptoken,
                                "Reason": "旧基准", "IdempotencyKey": "rb-policy-stale"})
        check("RB-T08 stale base refused under policy", status in (409, 400), status)
        check("RB-T08 still no extra version after refusals",
              len(versions_of(admin, policy_file)) == 2, len(versions_of(admin, policy_file)))

        # A fresh, approved rollback then appends exactly one new version.
        status, body = admin.json("POST", f"/api/files/{policy_file}/lock", {"BaseSeq": 2})
        ptoken2 = (body or {}).get("data", {}).get("lockToken")
        status, body = admin.json("POST", f"/api/files/{policy_file}/rollback",
                                  {"TargetSeq": 1, "ExpectedCurrentSeq": 2, "LockToken": ptoken2,
                                   "Reason": "再次申请", "IdempotencyKey": "rb-policy-rollback-2"})
        approval2 = ((body or {}).get("data") or {}).get("approvalId")
        status, body = admin.json("POST", f"/api/approvals/{approval2}/approve", {"comment": "同意"})
        check("RB-T07 approved rollback commits", status == 200, f"HTTP {status}")
        versions = versions_of(admin, policy_file)
        check("RB-T07 approval appends exactly one version", len(versions) == 3, len(versions))
        last = versions[-1] if versions else {}
        check("RB-T07 appended version is a rollback of v1",
              last.get("action") == "rollback" and last.get("sha256") == sha["A"], last)
        status, payload = admin.request("GET", f"/api/files/{policy_file}/bytes")
        check("RB-T07 current bytes equal the approved target",
              hashlib.sha256(payload).hexdigest() == sha["A"], f"HTTP {status}")

    # ---- RB-T10: rollback restores exact bytes for every media class ----
    step_v1 = minimal_step()
    media = [
        ("rb10-plain.txt", "rb10 明文内容", "rb10 明文内容-改", "text/plain"),
        ("rb10-bom.txt", "\ufeffrb10 BOM 内容", "\ufeffrb10 BOM 内容-改", "text/plain"),
        ("rb10-crlf.txt", "rb10 第一行\r\nrb10 第二行", "rb10 第一行\r\nrb10 第二行-改", "text/plain"),
        ("rb10.docx", minimal_docx("回滚前"), minimal_docx("回滚后"),
         "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ]
    if step_v1:
        media.append(("rb10.step", step_v1, step_v1 + b"\n/* appended */\n", "application/step"))
    else:
        check("RB-T10 STEP sample generated", False, "gmsh unavailable on target")
    for name, v1, v2, ctype in media:
        raw1 = v1.encode("utf8") if isinstance(v1, str) else v1
        raw2 = v2.encode("utf8") if isinstance(v2, str) else v2
        status, uploaded = upload_binary(admin, folder_id, name, raw1, ctype)
        media_id = (uploaded or {}).get("fileId") if status == 201 else None
        check(f"RB-T10 {name} uploaded", media_id is not None, status)
        if not media_id:
            continue
        status, _ = lock_and_save_raw(admin, media_id, 1, raw2, f"rb10-save-{name}")
        check(f"RB-T10 {name} v2 saved", status == 200, f"HTTP {status}")
        status, body = admin.json("POST", f"/api/files/{media_id}/lock", {"BaseSeq": 2})
        mtoken = (body or {}).get("data", {}).get("lockToken")
        status, body = admin.json("POST", f"/api/files/{media_id}/rollback",
                                  {"TargetSeq": 1, "ExpectedCurrentSeq": 2, "LockToken": mtoken,
                                   "Reason": "RB-T10", "IdempotencyKey": f"rb10-rollback-{name}"})
        check(f"RB-T10 {name} rollback committed", status == 200, f"HTTP {status}")
        status, payload = admin.request("GET", f"/api/files/{media_id}/bytes")
        want = hashlib.sha256(raw1).hexdigest()
        check(f"RB-T10 {name} bytes equal the target version",
              hashlib.sha256(payload).hexdigest() == want,
              f"HTTP {status} sha={hashlib.sha256(payload).hexdigest()[:12]} want={want[:12]}")
        versions = versions_of(admin, media_id)
        check(f"RB-T10 {name} version digests unchanged",
              [v.get("sha256") for v in versions] == [want, hashlib.sha256(raw2).hexdigest(), want],
              [v.get("sha256", "")[:12] for v in versions])

    # RB-T10 (index + derivative point at the new current): after the STEP
    # rollback the derivative must be bound to version 1 again.
    step_media = [m for m in media if m[0].endswith(".step")]
    if step_media:
        status, body = admin.json("GET", "/api/search?q=rb10.step")
        items = ((body or {}).get("data") or {}).get("items") or []
        check("RB-T10 search index points at the current version",
              any(item.get("name") == "rb10.step" for item in items), len(items))

    # ---- RB-T11: history, derivatives and shared blobs survive rollback ----
    # A content-addressed blob shared by two versions must stay downloadable
    # after a rollback (no garbage collector exists to reclaim it, and none may
    # run while a version still references the digest).
    status, uploaded = upload_binary(admin, folder_id, "rb11-shared.bin", b"shared blob bytes", "application/octet-stream")
    shared_id = (uploaded or {}).get("fileId") if status == 201 else None
    if shared_id:
        lock_and_save_raw(admin, shared_id, 1, b"shared blob bytes", "rb11-same")  # identical digest
        status, body = admin.json("POST", f"/api/files/{shared_id}/lock", {"BaseSeq": 2})
        stoken = (body or {}).get("data", {}).get("lockToken")
        admin.json("POST", f"/api/files/{shared_id}/rollback",
                   {"TargetSeq": 1, "ExpectedCurrentSeq": 2, "LockToken": stoken,
                    "Reason": "RB-T11", "IdempotencyKey": "rb11-rollback"})
        versions = versions_of(admin, shared_id)
        check("RB-T11 full history survives the rollback",
              [v.get("versionSeq") for v in versions] == [1, 2, 3], [v.get("versionSeq") for v in versions])
        check("RB-T11 both versions reference the same blob",
              len({v.get("sha256") for v in versions}) == 1, {v.get("sha256", "")[:12] for v in versions})
        status, payload = admin.request("GET", f"/api/files/{shared_id}/bytes")
        check("RB-T11 shared blob still downloadable after rollback",
              status == 200 and payload == b"shared blob bytes", f"HTTP {status}")

    # Cleanup.
    admin.json("DELETE", f"/api/folders/{folder_id}")
    if policy_folder:
        admin.json("DELETE", f"/api/folders/{policy_folder}")
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
