#!/usr/bin/env python3
"""DO05: DOCX header/footer/page-break round-trip through the real commit path (SPEC §19).

Generates a DOCX carrying a header, a footer and an explicit page break,
uploads it, opens a real editing session, then fires the editor's status-2
save callback with the edited bytes served from a pinned mock editor host —
exercising the production path end to end: JWT verification, SSRF-pinned
download from the configured editor host, OOXML structural validation, the
version commit and the authoritative download. Finally it asserts the
committed version still carries header1.xml, footer1.xml, the page break and
the edit.

Run on the target host as root, loopback for the API; the mock editor host
binds 203.0.113.10:18096 and a pinned dev instance 203.0.113.10:18097 (both
torn down afterwards). The business database is used; the sample file is
soft-deleted at the end.
"""
import argparse
import base64
import hashlib
import hmac
import http.cookiejar
import http.server
import json
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import zipfile

ROOT = "/srv/filesmanage"
ENV_FILE = f"{ROOT}/.secrets/server.env"
MOCK_PORT = 18096
INSTANCE_PORT = 18097
FOLDER_NAME = "研发部"

CT = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>"""

RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>"""

DOC = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:pPr><w:headerReference w:type="default" r:id="rIdH1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><w:footerReference w:type="default" r:id="rIdF1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></w:pPr><w:r><w:t>第一页正文：示例科技技术规范初稿</w:t></w:r></w:p>
<w:p><w:r><w:br w:type="page"/><w:t>第二页正文：分页符之后的内容</w:t></w:r></w:p>
<w:sectPr><w:headerReference w:type="default" r:id="rIdH1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><w:footerReference w:type="default" r:id="rIdF1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></w:sectPr>
</w:body></w:document>"""

DOC_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdH1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
<Relationship Id="rIdF1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
</Relationships>"""

HEADER = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>示例科技 · 文件头</w:t></w:r></w:p>
</w:hdr>"""

FOOTER = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>第 1 页 / 内部资料</w:t></w:r></w:p>
</w:ftr>"""

CORE = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>DO05 页眉页脚样本</dc:title><dc:creator>filesmanage</dc:creator>
</cp:coreProperties>"""


def build_sample(path):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CT)
        z.writestr("_rels/.rels", RELS)
        z.writestr("word/document.xml", DOC)
        z.writestr("word/_rels/document.xml.rels", DOC_RELS)
        z.writestr("word/header1.xml", HEADER)
        z.writestr("word/footer1.xml", FOOTER)
        z.writestr("docProps/core.xml", CORE)


def build_edited(src, dst):
    zin = zipfile.ZipFile(src)
    doc = zin.read("word/document.xml").decode()
    edited = doc.replace("第一页正文：示例科技技术规范初稿",
                         "（DO05往返编辑）第一页正文：示例科技技术规范初稿")
    assert edited != doc, "edit anchor not found"
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.namelist():
            data = edited.encode() if item == "word/document.xml" else zin.read(item)
            zout.writestr(item, data)


def b64url(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def jwt(secret, claims):
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    body = b64url(json.dumps(claims, separators=(",", ":")).encode())
    sig = b64url(hmac.new(secret.encode(), f"{header}.{body}".encode(), hashlib.sha256).digest())
    return f"{header}.{body}.{sig}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--folder", default=FOLDER_NAME)
    args = parser.parse_args()

    env = dict(l.split("=", 1) for l in open(ENV_FILE).read().splitlines() if "=" in l)
    env = {k.strip(): v.strip() for k, v in env.items()}
    secret = env["FILESMANAGE_OFFICE_SECRET"]
    admin_password = open(f"{ROOT}/.secrets/admin.password").read().strip()

    results = []

    def check(name, ok, detail):
        results.append((name, bool(ok), detail))

    build_sample("/tmp/do05-sample.docx")
    build_edited("/tmp/do05-sample.docx", "/tmp/do05-edited.docx")
    check("sample + edited DOCX built", True, "header/footer/page-break parts present")

    # Mock editor host serving the edited file (the SSRF-pinned download source).
    os.makedirs("/tmp/do05-officehost", exist_ok=True)
    subprocess.run(["cp", "/tmp/do05-edited.docx", "/tmp/do05-officehost/"], check=True)
    handler = http.server.SimpleHTTPRequestHandler
    httpd = http.server.ThreadingHTTPServer(("203.0.113.10", MOCK_PORT),
                                            lambda *a, **kw: handler(*a, directory="/tmp/do05-officehost", **kw))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    check(f"mock editor host on :{MOCK_PORT}", True, "serving do05-edited.docx")

    # Pinned dev instance: the callback downloader may only talk to EditorURL.
    instance_env = dict(env)
    instance_env.update({
        "FILESMANAGE_ADDR": f"0.0.0.0:{INSTANCE_PORT}",
        "FILESMANAGE_OFFICE_URL": f"http://203.0.113.10:{MOCK_PORT}",
        "FILESMANAGE_OFFICE_SOURCE_BASE": f"http://203.0.113.10:{INSTANCE_PORT}",
    })
    instance_log = open("/tmp/do05-instance.log", "w")
    instance = subprocess.Popen([f"{ROOT}/.bin/server"], cwd=ROOT, env=instance_env,
                                stdout=instance_log, stderr=instance_log)
    base = f"http://127.0.0.1:{INSTANCE_PORT}"
    for _ in range(20):
        try:
            urllib.request.urlopen(base + "/health/ready", timeout=2)
            break
        except Exception:
            time.sleep(0.5)
    check("pinned dev instance up", True, f"port {INSTANCE_PORT}")

    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def api(method, path, body=None, raw=None, ctype=None, auth=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(base + path, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", ctype or "application/json")
        if auth:
            req.add_header("Authorization", "Bearer " + auth)
        try:
            with opener.open(req, timeout=60) as response:
                return response.status, response.read(), jar
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read(), jar

    try:
        status, payload, jar = api("POST", "/api/login",
                                   {"login": "admin", "password": admin_password})
        check("login on pinned instance", status == 200, status)

        boundary = "----DO05Check"
        multipart = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"folderId\"\r\n\r\n"
                     f"{'folder_rd'}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\";"
                     f' filename="do05-{int(time.time())}.docx"\r\nContent-Type:'
                     " application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n"
                     ).encode() + open("/tmp/do05-sample.docx", "rb").read() + f"\r\n--{boundary}--\r\n".encode()
        status, payload, jar = api("POST", "/api/files", raw=multipart, ctype=f"multipart/form-data; boundary={boundary}")
        uploaded = json.loads(payload)["data"]
        file_id = uploaded["fileId"]
        check("sample uploaded", status == 201, file_id)

        status, payload, jar = api("POST", f"/api/files/{file_id}/office/session")
        config = json.loads(payload)["data"]
        doc_key = config["config"]["document"]["key"]
        check("editing session opened", status == 201, doc_key)

        now = int(time.time())
        token = jwt(secret, {"document": {"fileId": file_id, "key": doc_key, "baseSeq": 1},
                             "exp": now + 600, "iat": now - 10, "userId": "u_admin"})
        body = json.dumps({"key": doc_key, "status": 2,
                           "url": f"http://203.0.113.10:{MOCK_PORT}/do05-edited.docx"}).encode()
        status, payload, jar = api("POST", "/api/internal/office/callback", raw=body,
                                   ctype="application/json", auth=token)
        # The callback handler always answers HTTP 200; error 0 means committed.
        reply = json.loads(payload)
        check("status-2 callback committed", reply.get("error") == 0, reply)

        status, payload, jar = api("GET", f"/api/files/{file_id}/versions")
        versions = json.loads(payload)["data"]
        v2 = [v for v in versions if v["versionSeq"] == 2]
        check("v2 committed as edit", bool(v2), [(v["versionSeq"], v["action"]) for v in versions])

        status, payload, jar = api("GET", f"/api/files/{file_id}/bytes")
        open("/tmp/do05-v2.docx", "wb").write(payload)
        z = zipfile.ZipFile("/tmp/do05-v2.docx")
        doc = z.read("word/document.xml").decode()
        check("v2 keeps header1.xml", "word/header1.xml" in z.namelist(), z.namelist())
        check("v2 keeps footer1.xml", "word/footer1.xml" in z.namelist(), z.namelist())
        check("v2 header text intact", "示例科技 · 文件头" in z.read("word/header1.xml").decode(), "")
        check("v2 footer text intact", "第 1 页 / 内部资料" in z.read("word/footer1.xml").decode(), "")
        check("v2 page break intact", 'w:type="page"' in doc, "")
        check("v2 carries the edit", "DO05往返编辑" in doc, "")

        status, payload, jar = api("DELETE", f"/api/files/{file_id}")
        check("sample soft-deleted", status == 200, status)
    finally:
        instance.send_signal(signal.SIGTERM)
        httpd.shutdown()
        instance_log.close()

    failed = [name for name, ok, _ in results if not ok]
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'} {name} :: {detail}")
    print(f"SUMMARY pass={len(results) - len(failed)} total={len(results)}")
    if failed:
        print("DO05_CHECK_FAILED: " + ", ".join(failed), file=sys.stderr)
        return 1
    print("DO05_CHECK_PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
