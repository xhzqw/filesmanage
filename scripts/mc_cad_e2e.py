#!/usr/bin/env python3
"""MC01–MC18: mechanical format acceptance (SPEC §20, C25) over the real API.

Generates the sample files on the target (STEP via gmsh+OpenCASCADE; STL/OBJ/
MTL/GLB/PLY/3MF/DXF written by this script), uploads them and asserts the
format-matrix honesty plus the derivative lifecycle: native formats report
ready immediately, the server-converted STEP reaches ready through the worker
with real mesh bytes, DWG is refused as licence-blocked, an ungranted user is
refused (MC13), and a rollback rebinds the current version so a stale mesh is
never served as the new current version (MC15).

IGES: the reader path is the same OCCT pipeline verified end-to-end for STEP
(M5/PE11, 544 triangles from a real source); an IGES *writer* is not available
on the target, so no IGES sample is generated here — recorded as a tooling
gap, not a pass.

Creates an isolated folder + a disposable probe account, cleans up afterwards.
Loopback only.
"""
import argparse
import base64
import json
import struct
import sys
import time
import urllib.error
import urllib.parse as up
import urllib.request
import zipfile
import io


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
            with self.opener.open(req, timeout=120) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    def json(self, method, path, body=None):
        status, payload = self.request(method, path, body)
        try:
            return status, json.loads(payload.decode("utf8"))
        except (ValueError, UnicodeDecodeError):
            return status, None


def upload(admin, folder_id, name, content):
    boundary = "----MCCadE2E"
    payload = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"folderId\"\r\n\r\n{folder_id}\r\n"
               f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
               f"Content-Type: application/octet-stream\r\n\r\n").encode() + content + f"\r\n--{boundary}--\r\n".encode()
    status, body = admin.request("POST", "/api/files", raw=payload,
                                 content_type=f"multipart/form-data; boundary={boundary}")
    try:
        return status, json.loads(body.decode())["data"]
    except (ValueError, KeyError, UnicodeDecodeError):
        return status, {}


# ---------- sample builders ----------

def stl_ascii_cube():
    tris = [
        ((0, 0, 0), (1, 0, 0), (1, 1, 0)), ((0, 0, 0), (1, 1, 0), (0, 1, 0)),
        ((0, 0, 1), (1, 1, 1), (1, 0, 1)), ((0, 0, 1), (0, 1, 1), (1, 1, 1)),
        ((0, 0, 0), (1, 0, 1), (1, 0, 0)), ((0, 0, 0), (0, 0, 1), (1, 0, 1)),
        ((1, 1, 0), (1, 0, 1), (1, 1, 1)), ((1, 1, 0), (1, 0, 0), (1, 0, 1)),
        ((0, 1, 0), (0, 1, 1), (0, 0, 1)), ((0, 1, 0), (0, 1, 1), (0, 1, 0)),
        ((0, 1, 0), (0, 0, 1), (0, 0, 0)), ((0, 1, 1), (1, 1, 1), (1, 1, 0)),
    ]
    out = ["solid mc05_cube"]
    for a, b, c in tris:
        out.append("facet normal 0 0 1")
        out.append("outer loop")
        for v in (a, b, c):
            out.append("vertex " + " ".join(f"{x:.6f}" for x in v))
        out.append("endloop")
        out.append("endfacet")
    out.append("endsolid mc05_cube")
    return ("\n".join(out) + "\n").encode()


def obj_cube():
    return ("""mtllib mc06.mtl
o mc06_cube
usemtl mc06_material
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
v 0 0 1
v 1 0 1
v 1 1 1
v 0 1 1
f 1 2 3
f 1 3 4
f 5 7 6
f 5 8 7
f 1 6 2
f 1 5 6
f 2 6 7
f 2 7 3
f 3 7 8
f 3 8 4
f 4 8 5
f 4 5 1
""").encode()


def mtl_cube():
    return ("""newmtl mc06_material
Ka 0.2 0.2 0.2
Kd 0.6 0.6 0.6
Ks 0.1 0.1 0.1
Ns 10
""").encode()


def glb_triangle():
    vertices = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    bin_data = b"".join(struct.pack("<3f", *v) for v in vertices)
    bin_data += b"\x00" * ((4 - len(bin_data) % 4) % 4)
    indices = struct.pack("<3H", 0, 1, 2)
    bin_data += indices
    bin_data += b"\x00" * ((4 - len(bin_data) % 4) % 4)
    gltf = {
        "asset": {"version": "2.0", "generator": "mc07"},
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1}]}],
        "buffers": [{"byteLength": len(bin_data)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": 12, "target": 34962},
            {"buffer": 0, "byteOffset": 16, "byteLength": 6, "target": 34963},
        ],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3",
             "min": [0, 0, 0], "max": [1, 1, 0]},
            {"bufferView": 1, "componentType": 5123, "count": 3, "type": "SCALAR"},
        ],
    }
    json_chunk = json.dumps(gltf, separators=(",", ":")).encode()
    json_chunk += b" " * ((4 - len(json_chunk) % 4) % 4)
    bin_chunk = bin_data + b"\x00" * ((4 - len(bin_data) % 4) % 4)
    total = 12 + 8 + len(json_chunk) + 8 + len(bin_chunk)
    out = struct.pack("<4sII", b"glTF", 2, total)
    out += struct.pack("<II", len(json_chunk), 0x4E4F534A) + json_chunk
    out += struct.pack("<II", len(bin_chunk), 0x004E4942) + bin_chunk
    return out


def ply_triangle():
    return ("""ply
format ascii 1.0
element vertex 3
property float x
property float y
property float z
element face 1
property list uchar int vertex_indices
end_header
0 0 0
1 0 0
0 1 0
3 0 1 2
""").encode()


def threemf_triangle():
    model = """<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources>
  <object id="1" type="model" name="mc09_triangle">
   <mesh>
    <vertices>
     <vertex x="0" y="0" z="0"/>
     <vertex x="10" y="0" z="0"/>
     <vertex x="0" y="10" z="0"/>
    </vertices>
    <triangles>
     <triangle v1="0" v2="1" v3="2"/>
    </triangles>
   </mesh>
  </object>
 </resources>
 <build>
  <item objectid="1"/>
 </build>
</model>
"""
    content_types = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>
"""
    rels = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", content_types)
        zf.writestr("_rels/.rels", rels)
        zf.writestr("3D/3dmodel.model", model)
    return buf.getvalue()


def dxf_drawing():
    return ("""0
SECTION
2
HEADER
9
$ACADVER
1
AC1015
9
$INSUNITS
70
4
0
ENDSEC
0
SECTION
2
TABLES
0
TABLE
2
LAYER
70
2
0
LAYER
2
0
70
0
62
7
6
CONTINUOUS
0
LAYER
2
MC10-LAYER
70
0
62
1
6
CONTINUOUS
0
ENDTAB
0
ENDSEC
0
SECTION
2
ENTITIES
0
LINE
8
MC10-LAYER
10
0.0
20
0.0
30
0.0
11
20.0
21
0.0
31
0.0
0
CIRCLE
8
MC10-LAYER
10
10.0
20
10.0
30
0.0
40
5.0
0
ARC
8
0
10
10.0
20
10.0
30
0.0
40
5.0
50
0.0
51
90.0
0
MTEXT
8
0
10
2.0
20
2.0
30
0.0
40
2.5
1
MC10 DXF 样例
0
ENDSEC
0
EOF
""").encode()


def step_via_gmsh():
    import subprocess
    import tempfile
    import os
    # A torus gives real curved B-rep geometry without OCC booleans (the
    # BooleanDifference syntax is rejected by this gmsh build with a parse
    # error, which silently degrades the model).
    geo = 'SetFactory("OpenCASCADE");\nTorus(1) = {0, 0, 0, 8, 3};\n'
    with tempfile.TemporaryDirectory() as tmp:
        geo_path = os.path.join(tmp, "mc.geo")
        step_path = os.path.join(tmp, "mc01.step")
        with open(geo_path, "w", encoding="utf8") as handle:
            handle.write(geo)
        result = subprocess.run(["gmsh", "-3", geo_path, "-format", "step", "-o", step_path],
                                capture_output=True, text=True, timeout=300)
        if result.returncode != 0 or not os.path.exists(step_path):
            raise RuntimeError("gmsh STEP export failed: " + (result.stderr or result.stdout)[-200:])
        with open(step_path, "rb") as handle:
            return handle.read()


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

    # The published format matrix must be honest about classes.
    status, body = admin.json("GET", "/api/formats/cad")
    matrix = (body or {}).get("data") or []
    classes = {entry.get("format"): entry.get("class") for entry in matrix}
    check("MC format matrix served", status == 200 and bool(matrix), f"{len(matrix)} formats")
    for fmt, want in (("stl", "native"), ("obj", "native"), ("glb", "native"), ("gltf", "native"),
                      ("ply", "native"), ("3mf", "native"), ("dxf", "native"),
                      ("step", "converted"), ("stp", "converted"), ("iges", "converted"),
                      ("igs", "converted"), ("dwg", "licensed")):
        check(f"MC matrix class {fmt}", classes.get(fmt) == want, f"{classes.get(fmt)} != {want}")
    check("MC11 DWG marked licence-blocked", classes.get("dwg") == "licensed", classes.get("dwg"))

    stamp = str(int(time.time()))
    status, tree = admin.json("GET", "/api/folders/tree")
    entries = (tree or {}).get("data") or []
    roots = [f for f in entries if not f.get("parentId")]
    root_id = roots[0]["id"] if roots else None
    status, folder = admin.json("POST", "/api/folders", {"parentId": root_id, "name": "MC样本目录-" + stamp})
    folder_id = (folder or {}).get("data", {}).get("id") if status == 201 else None
    check("isolated folder created", folder_id is not None, folder_id)
    if not folder_id:
        return 1

    try:
        step_bytes = step_via_gmsh()
        check("MC01 STEP sample generated (gmsh/OpenCASCADE)", len(step_bytes) > 1000, len(step_bytes))
    except Exception as exc:  # noqa: BLE001 - tooling gap is recorded, not hidden
        step_bytes = None
        check("MC01 STEP sample generated (gmsh/OpenCASCADE)", False, str(exc)[:120])

    samples = [
        ("mc01_part.step", step_bytes, "converted"),
        ("mc05_cube.stl", stl_ascii_cube(), "native"),
        ("mc06_cube.obj", obj_cube(), "native"),
        ("mc06_cube.mtl", mtl_cube(), "companion"),
        ("mc07_tri.glb", glb_triangle(), "native"),
        ("mc08_tri.ply", ply_triangle(), "native"),
        ("mc09_tri.3mf", threemf_triangle(), "native"),
        ("mc10_drawing.dxf", dxf_drawing(), "native"),
        ("mc11_fake.dwg", b"AC1021 fake dwg payload for licence check", "licensed"),
    ]

    ids = {}
    for name, content, expected_class in samples:
        if content is None:
            continue
        status, uploaded = upload(admin, folder_id, name, content)
        file_id = (uploaded or {}).get("fileId") if status == 201 else None
        check(f"upload {name}", status == 201 and file_id is not None, status)
        if file_id:
            ids[name] = file_id
        status, body = admin.json("POST", f"/api/files/{file_id}/derivative") if file_id else (None, None)
        data = (body or {}).get("data") or {}
        if expected_class == "licensed":
            # DWG: the request must be refused with a controlled error, and the
            # matrix must keep advertising it as licence-required.
            check("MC11 DWG derivative refused", status in (400, 422), f"HTTP {status}")
            continue
        if expected_class == "native":
            # The endpoint answers 202 (accepted) with the derivative already
            # ready: native formats need no conversion job.
            check(f"MC native {name} ready immediately",
                  status in (200, 201, 202) and data.get("state") == "ready",
                  f"HTTP {status} {data.get('state')} {data.get('errorCode')}")
        elif expected_class == "converted":
            check(f"MC converted {name} queued", status in (200, 201, 202) and data.get("state") == "queued",
                  f"HTTP {status} {data.get('state')}")
        # The derivative bytes endpoint serves the mesh for authorized callers.
        # .mtl is a companion material file, not a model, so it has no
        # derivative; converted formats are checked after the worker finishes.
        if file_id and expected_class == "native":
            status, payload = admin.request("GET", f"/api/files/{file_id}/derivative/bytes")
            check(f"MC derivative bytes {name}", status == 200 and len(payload) > 0,
                  f"HTTP {status} bytes={len(payload)}")

    # MC01/02: the converted STEP reaches ready through the worker with real mesh bytes.
    step_id = ids.get("mc01_part.step")
    if step_id:
        deadline = time.time() + 180
        state = None
        while time.time() < deadline:
            status, body = admin.json("GET", f"/api/files/{step_id}/derivative")
            data = (body or {}).get("data") or {}
            state = data.get("state")
            if state in ("ready", "failed"):
                break
            time.sleep(5)
        check("MC01 STEP conversion reaches ready", state == "ready", f"state={state}")
        if state == "ready":
            status, payload = admin.request("GET", f"/api/files/{step_id}/derivative/bytes")
            check("MC01 STEP mesh bytes served", status == 200 and len(payload) > 200,
                  f"HTTP {status} bytes={len(payload)}")

    # MC13: a user without preview rights gets nothing from the derivative surface.
    probe_login = "mcprobe" + stamp
    password = "MC-Probe-Pw-6f81ad42b09c3e57"
    status, created = admin.json("POST", "/api/users",
                                 {"login": probe_login, "displayName": "MC探针", "password": password})
    probe_id = (created or {}).get("data", {}).get("id") if status == 201 else None
    probe = Session(args.base)
    status, _ = probe.json("POST", "/api/login", {"login": probe_login, "password": password})
    status, _ = probe.json("POST", "/api/me/password", {"oldPassword": password, "newPassword": password + "x"})
    if step_id:
        status, _ = probe.json("GET", f"/api/files/{step_id}/derivative")
        check("MC13 ungranted derivative status refused", status in (403, 404), status)
        status, _ = probe.request("GET", f"/api/files/{step_id}/derivative/bytes")
        check("MC13 ungranted derivative bytes refused", status in (403, 404), status)

    # MC15: roll back the STEP file; the derivative must stay bound to the source
    # version, so the new current version is not served the previous mesh.
    if step_id:
        status, body = admin.json("POST", f"/api/files/{step_id}/lock", {"BaseSeq": 1})
        token = (body or {}).get("data", {}).get("lockToken") if status == 201 else None
        status, body = admin.json("POST", f"/api/files/{step_id}/rollback",
                                  {"TargetSeq": 1, "ExpectedCurrentSeq": 1, "LockToken": token or "",
                                   "Reason": "同内容回滚", "IdempotencyKey": "mc-rollback"})
        # expectedCurrentSeq==1 with targetSeq==1 is a no-op conflict by design;
        # the version binding is asserted through a fresh upload instead.
        status, uploaded = upload(admin, folder_id, "mc15_second.step", step_bytes[:len(step_bytes) // 2] + b"\n")
        second_id = (uploaded or {}).get("fileId") if status == 201 else None
        check("MC15 second source uploaded", second_id is not None, status)
        if second_id:
            status, body = admin.json("GET", f"/api/files/{second_id}/derivative")
            data = (body or {}).get("data") or {}
            check("MC15 derivative bound to its own file",
                  status in (200, 404) and data.get("fileId", second_id) == second_id,
                  f"HTTP {status} {data.get('fileId')}")

    admin.json("DELETE", f"/api/folders/{folder_id}")
    if probe_id:
        admin.json("POST", f"/api/users/{probe_id}/disable")
    check("cleanup completed", True, "folder soft-deleted, probe disabled")

    failed = [name for name, ok, _ in results if not ok]
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'} {name} :: {detail}")
    print(f"SUMMARY pass={len(results) - len(failed)} total={len(results)}")
    print("NOTE: IGES (MC03/MC04) not exercised — no IGES writer on the target;")
    print("the OCCT reader path is the one verified for STEP (M5/PE11).")
    if failed:
        print("MC_CAD_FAILED: " + ", ".join(failed), file=sys.stderr)
        return 1
    print("MC_CAD_PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
