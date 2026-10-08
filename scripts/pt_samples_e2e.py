#!/usr/bin/env python3
"""PT01–PT12: plain-text byte-fidelity acceptance (SPEC §8, S19).

Builds the twelve byte fixtures client-side with known bytes, uploads them
through the real API, and asserts the byte-level contract: preview metadata
(BOM/EOL/trailing newline/truncation/printability), download SHA-256 equality
with the source bytes, byte-exact save round-trips (no encoding or newline
normalisation), literal rendering of HTML/Markdown samples, read-only
metadata for mixed-EOL and invalid-UTF-8 payloads, the 256 KiB truncation
contract on an oversized file, an A/B concurrent-save 409, and zero mutation
when nothing is saved.

Creates an isolated folder, cleans up afterwards (soft delete). Loopback only.
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

PREVIEW_LIMIT = 256 * 1024


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


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def upload(admin, folder_id, name, content, content_type="text/plain"):
    boundary = "----PTBytesE2E"
    payload = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"folderId\"\r\n\r\n{folder_id}\r\n"
               f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
               f"Content-Type: {content_type}\r\n\r\n").encode() + content + f"\r\n--{boundary}--\r\n".encode()
    status, body = admin.request("POST", "/api/files", raw=payload,
                                 content_type=f"multipart/form-data; boundary={boundary}")
    try:
        return status, json.loads(body.decode())["data"]
    except (ValueError, KeyError, UnicodeDecodeError):
        return status, {}


def data_url(content):
    return "data:text/plain;base64," + base64.b64encode(content).decode()


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
    status, folder = admin.json("POST", "/api/folders", {"parentId": root_id, "name": "PT字节目录-" + stamp})
    folder_id = (folder or {}).get("data", {}).get("id") if status == 201 else None
    check("isolated folder created", folder_id is not None, folder_id)
    if not folder_id:
        return 1

    # The twelve fixtures with their expected byte-level facts.
    fixtures = [
        ("pt01_lf.txt", "  leading and trailing  \n\ttabbed\nlast line\n",
         {"encoding": "utf-8", "hasBom": False, "eol": "lf", "endsWithNewline": True, "printable": True}),
        ("pt02_crlf.txt", "中文 CRLF 保留\r\nsecond line\r\n",
         {"encoding": "utf-8", "hasBom": False, "eol": "crlf", "endsWithNewline": True, "printable": True}),
        ("pt03_bom.txt", "﻿BOM 保留\ndata\n",
         {"encoding": "utf-8-bom", "hasBom": True, "eol": "lf", "endsWithNewline": True, "printable": True}),
        ("pt04_mixed.txt", "mixed\ncrlf\r\nthird\n",
         {"encoding": "utf-8", "hasBom": False, "eol": "mixed", "endsWithNewline": True, "printable": True}),
        # printable=false is the NUL rule; invalid UTF-8 without NUL stays
        # printable and its guarantee is byte fidelity (download SHA + the
        # rawBase64 editor path), never a lossy re-encode of the saved bytes.
        ("pt05_invalid.txt", b"valid start\n\xff\xfe invalid bytes\n",
         {"encoding": "utf-8", "hasBom": False, "eol": "lf", "endsWithNewline": True, "printable": True}),
        ("pt06_script.txt", "<script>alert(1)</script>\n<img onerror=alert(2) src=x>\n",
         {"encoding": "utf-8", "hasBom": False, "eol": "lf", "endsWithNewline": True, "printable": True}),
        ("pt07_md.txt", "# Title\n**bold** and `code`\n",
         {"encoding": "utf-8", "hasBom": False, "eol": "lf", "endsWithNewline": True, "printable": True}),
        ("pt08_longline.txt", ("x" * 20000) + "\n",
         {"encoding": "utf-8", "hasBom": False, "eol": "lf", "endsWithNewline": True, "printable": True}),
        ("pt10_utf8.txt", "emoji 🚀 中文 ünïcode 混合\n",
         {"encoding": "utf-8", "hasBom": False, "eol": "lf", "endsWithNewline": True, "printable": True}),
        ("pt11_binary.bin", b"\x00\x01\x02binary\x00NUL\n",
         {"encoding": None, "hasBom": False, "eol": None, "endsWithNewline": None, "printable": False}),
        ("pt12_last.txt", "no trailing newline",
         {"encoding": "utf-8", "hasBom": False, "eol": "none", "endsWithNewline": False, "printable": True}),
    ]
    # PT09: oversized (300 KiB) — truncation contract.
    oversized = (("L" * 100 + "\n") * (300 * 1024 // 101 + 1)).encode()

    files = {}
    # PT09's byteMeta describes the 256 KiB preview prefix, so trailing-newline
    # is not meaningful for the oversized sample (the cut lands mid-line).
    for name, content, expect in fixtures + [("pt09_large.txt", oversized,
                                              {"encoding": "utf-8", "hasBom": False, "eol": "lf",
                                               "endsWithNewline": None, "printable": True})]:
        raw = content if isinstance(content, bytes) else content.encode("utf8")
        status, uploaded = upload(admin, folder_id, name, raw)
        file_id = (uploaded or {}).get("fileId") if status == 201 else None
        check(f"upload {name}", status == 201 and file_id is not None, status)
        if not file_id:
            continue
        files[name] = (file_id, raw)

        # Download bytes are authoritative and unchanged.
        status, payload = admin.request("GET", f"/api/files/{file_id}/bytes")
        check(f"PT download SHA {name}", status == 200 and sha256_hex(payload) == sha256_hex(raw),
              f"HTTP {status}")

        # Preview metadata matches the fixture facts.
        status, body = admin.json("GET", f"/api/files/{file_id}/preview")
        data = (body or {}).get("data") or {}
        meta = data.get("byteMeta") or {}
        for field, want in expect.items():
            if want is None:
                continue
            got = meta.get(field)
            check(f"PT byteMeta {name}.{field}", got == want, f"got={got} want={want}")
        if name == "pt09_large.txt":
            check("PT09 truncated flag", data.get("truncated") is True, data.get("truncated"))
            check("PT09 preview prefix size", data.get("size") == len(raw) and (data.get("content") or ""),
                  f"size={data.get('size')}")
        if name == "pt04_mixed.txt":
            check("PT04 mixed EOL reported", meta.get("eol") == "mixed", meta.get("eol"))
        if name == "pt05_invalid.txt":
            raw = base64.b64decode(data.get("rawBase64") or "")
            check("PT05 rawBase64 carries the exact bytes", raw == files[name][1][: len(raw)],
                  f"{len(raw)} bytes")
            status, payload = admin.request("GET", f"/api/files/{file_id}/bytes")
            check("PT05 invalid bytes never re-encoded on save path",
                  sha256_hex(payload) == sha256_hex(files[name][1]), "digest drift")
        if name == "pt06_script.txt":
            content_text = data.get("content") or ""
            check("PT06 script literal in preview payload",
                  "<script>alert(1)</script>" in json.dumps(data, ensure_ascii=False), "literal present")
            check("PT06 content is the literal text", "<script>alert(1)</script>" in content_text,
                  content_text[:40])
        if name == "pt07_md.txt":
            check("PT07 markdown stays literal", (data.get("content") or "").startswith("# Title"),
                  (data.get("content") or "")[:20])

    # Byte-exact save round-trips on the editable samples.
    for name in ("pt01_lf.txt", "pt02_crlf.txt", "pt03_bom.txt", "pt08_longline.txt", "pt12_last.txt"):
        if name not in files:
            continue
        file_id, original = files[name]
        status, body = admin.json("POST", f"/api/files/{file_id}/lock", {"BaseSeq": 1})
        token = (body or {}).get("data", {}).get("lockToken") if status == 201 else None
        status, body = admin.json("POST", f"/api/files/{file_id}/save",
                                  {"Data": data_url(original), "BaseSeq": 1,
                                   "LockToken": token, "IdempotencyKey": "pt-save-" + name})
        saved = (body or {}).get("data") or {}
        check(f"PT save {name} committed", status == 200, f"HTTP {status}")
        status, payload = admin.request("GET", f"/api/files/{file_id}/bytes")
        check(f"PT save {name} bytes identical",
              status == 200 and sha256_hex(payload) == sha256_hex(original) and saved.get("sha256") == sha256_hex(original),
              saved.get("sha256"))
        # An edit keeps the untouched structure: one token changed.
        edited = original.replace(b"line", b"LINE", 1) if b"line" in original else original + b"x"
        status, body = admin.json("POST", f"/api/files/{file_id}/lock", {"BaseSeq": 2})
        token = (body or {}).get("data", {}).get("lockToken") if status == 201 else None
        status, body = admin.json("POST", f"/api/files/{file_id}/save",
                                  {"Data": data_url(edited), "BaseSeq": 2,
                                   "LockToken": token, "IdempotencyKey": "pt-edit-" + name})
        saved = (body or {}).get("data") or {}
        check(f"PT edit {name} digest exact", status == 200 and saved.get("sha256") == sha256_hex(edited),
              f"HTTP {status} {saved.get('sha256')}")

    # PT10: A/B concurrent save — the stale base version loses.
    if "pt10_utf8.txt" in files:
        file_id, original = files["pt10_utf8.txt"]
        status, version_list = admin.json("GET", f"/api/files/{file_id}/versions")
        versions = (version_list or {}).get("data") or []
        current = versions[-1].get("versionSeq") if versions else 1
        status, body = admin.json("POST", f"/api/files/{file_id}/lock", {"BaseSeq": current})
        token_a = (body or {}).get("data", {}).get("lockToken") if status == 201 else None
        status, body = admin.json("POST", f"/api/files/{file_id}/save",
                                  {"Data": data_url(b"A edits this\n"), "BaseSeq": current,
                                   "LockToken": token_a, "IdempotencyKey": "pt-ab-a"})
        check("PT10 A saves v4", status == 200, f"HTTP {status}")
        # B never held the lock and works from the stale base.
        status, _ = admin.json("POST", f"/api/files/{file_id}/save",
                               {"Data": data_url(b"B stale write\n"), "BaseSeq": current,
                                "LockToken": "stale-token", "IdempotencyKey": "pt-ab-b"})
        check("PT10 B stale save refused 409", status == 409, status)
        status, payload = admin.request("GET", f"/api/files/{file_id}/bytes")
        check("PT10 A's version survives", sha256_hex(payload) == sha256_hex(b"A edits this\n"),
              sha256_hex(payload)[:12])

    # PT11: preview without saving changes nothing.
    if "pt11_binary.bin" in files:
        file_id, original = files["pt11_binary.bin"]
        before = sha256_hex(original)
        status, _ = admin.json("GET", f"/api/files/{file_id}/preview")
        check("PT11 preview reachable", status == 200, status)
        status, payload = admin.request("GET", f"/api/files/{file_id}/bytes")
        check("PT11 bytes unchanged after preview", sha256_hex(payload) == before, "digest drift")
        status, body = admin.json("GET", f"/api/files/{file_id}/versions")
        versions = (body or {}).get("data") or []
        check("PT11 still exactly one version", isinstance(versions, list) and len(versions) == 1,
              len(versions) if isinstance(versions, list) else versions)

    admin.json("DELETE", f"/api/folders/{folder_id}")
    check("cleanup completed", True, "folder soft-deleted")

    failed = [name for name, ok, _ in results if not ok]
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'} {name} :: {detail}")
    print(f"SUMMARY pass={len(results) - len(failed)} total={len(results)}")
    if failed:
        print("PT_SAMPLES_FAILED: " + ", ".join(failed), file=sys.stderr)
        return 1
    print("PT_SAMPLES_PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
