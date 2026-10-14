#!/usr/bin/env node
// MC06/MC07/MC09: multi-resource model rendering over the real API and browser.
//
// Builds the multi-resource samples in this script, uploads every companion as
// its own file (that is how the system stores them), then renders each model
// page in headless Chrome over CDP and asserts:
//   * the mesh renders with the expected triangle count (OBJ cube 12, glTF
//     triangle 1, two-part 3MF 24)
//   * the referenced companions are actually fetched through
//     /api/files/<id>/bytes (sibling resolution works, not silently skipped)
//   * no request leaves for an external host (the viewer is not a fetch
//     surface for attacker-controlled texture URLs)
//   * the page raises no error
//
// Usage: node scripts/mc_multiasset_check.mjs [--base http://127.0.0.1:18091]
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import zlib from "node:zlib";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const BASE = opt("base", "http://127.0.0.1:18091").replace(/\/+$/, "");
const PASSWORD_FILE = opt("password-file", ".secrets/admin.password");
const PORT = Number(opt("port", "9335"));

// ---- minimal PNG encoder (RGB, no interlace) ----
function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 3;
      raw[p] = rgb[(y * width + x) * 3];
      raw[p + 1] = rgb[(y * width + x) * 3 + 1];
      raw[p + 2] = rgb[(y * width + x) * 3 + 2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// A 2x2 blue/white checkerboard: the MTL/glTF texture target.
const TEXTURE_PNG = png(2, 2, Buffer.from([
  0x2f, 0x7f, 0xd0, 0xff, 0xff, 0xff,
  0xff, 0xff, 0xff, 0x2f, 0x7f, 0xd0,
]));

const OBJ_CUBE = `mtllib mc06t.mtl
o mc06t_cube
usemtl mc06t_material
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
`;

const MTL_TEXTURED = `newmtl mc06t_material
Ka 0.2 0.2 0.2
Kd 0.6 0.6 0.6
Ks 0.1 0.1 0.1
Ns 10
map_Kd mc06t_texture.png
`;

// One triangle, positions in an external .bin, colour from an external texture.
function gltfWithCompanions() {
  const positions = Buffer.alloc(36);
  const verts = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
  verts.forEach((v, i) => {
    positions.writeFloatLE(v[0], i * 12);
    positions.writeFloatLE(v[1], i * 12 + 4);
    positions.writeFloatLE(v[2], i * 12 + 8);
  });
  const doc = {
    asset: { version: "2.0", generator: "mc-multiasset" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0, sampler: 0 }],
    images: [{ uri: "mc07_texture.png" }],
    samplers: [{}],
    buffers: [{ uri: "mc07_buffer.bin", byteLength: positions.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length }],
    accessors: [{
      bufferView: 0, componentType: 5126, count: 3, type: "VEC3",
      min: [0, 0, 0], max: [1, 1, 0],
    }],
  };
  return { json: Buffer.from(JSON.stringify(doc)), bin: positions };
}

function cubeMeshXml(id, name, ox) {
  const v = (x, y, z) => `<vertex x="${x + ox}" y="${y}" z="${z}"/>`;
  return `<object id="${id}" type="model" name="${name}">
   <mesh>
    <vertices>
     ${v(0, 0, 0)}${v(1, 0, 0)}${v(1, 1, 0)}${v(0, 1, 0)}
     ${v(0, 0, 1)}${v(1, 0, 1)}${v(1, 1, 1)}${v(0, 1, 1)}
    </vertices>
    <triangles>
     <triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="3" v3="2"/>
     <triangle v1="4" v2="5" v3="6"/><triangle v1="4" v2="6" v3="7"/>
     <triangle v1="0" v2="1" v3="5"/><triangle v1="0" v2="5" v3="4"/>
     <triangle v1="1" v2="6" v3="5"/><triangle v1="1" v2="2" v3="6"/>
     <triangle v1="2" v2="7" v3="6"/><triangle v2="3" v3="7" v1="2"/>
     <triangle v1="3" v2="4" v3="7"/><triangle v1="0" v2="4" v3="3"/>
    </triangles>
   </mesh>
  </object>`;
}

function threemfTwoParts() {
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources>
  ${cubeMeshXml(1, "mc09_part_a", 0)}
  ${cubeMeshXml(2, "mc09_part_b", 3)}
 </resources>
 <build>
  <item objectid="1"/>
  <item objectid="2"/>
 </build>
</model>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;
  return {
    "mc09_two.3mf": Buffer.from(zipStore([
      ["[Content_Types].xml", contentTypes],
      ["_rels/.rels", rels],
      ["3D/3dmodel.model", model],
    ])),
  };
}

// Minimal stored (uncompressed) zip writer: enough for 3MF packages.
function zipStore(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, raw] of entries) {
    const content = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8");
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(content);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); // stored
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(content.length, 18);
    lh.writeUInt32LE(content.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(Buffer.concat([lh, nameBuf, content]));
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(content.length, 20);
    ch.writeUInt32LE(content.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, nameBuf]));
    offset += 30 + nameBuf.length + content.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length, 8);
  end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("websocket failed")), { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const res = await this.send("Runtime.evaluate", { expression, returnByValue: true });
    if (res.exceptionDetails) throw new Error("evaluate threw");
    return res.result.value;
  }
  close() { this.ws.close(); }
}

async function main() {
  const password = readFileSync(PASSWORD_FILE, "utf8").trim();
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "admin", password }),
  });
  if (!login.ok) throw new Error(`login failed HTTP ${login.status}`);
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith("fm_session="));
  const cookieValue = cookie.slice("fm_session=".length).split(";")[0];

  const json = async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), Cookie: `fm_session=${cookieValue}` },
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const upload = async (folderId, name, content) => {
    const form = new FormData();
    form.set("folderId", folderId);
    form.set("file", new Blob([content]), name);
    const res = await fetch(`${BASE}/api/files`, { method: "POST", headers: { Cookie: `fm_session=${cookieValue}` }, body: form });
    const body = await res.json().catch(() => null);
    return res.status === 201 ? body?.data?.fileId : null;
  };

  const tree = await json("GET", "/api/folders/tree");
  const root = (tree.body?.data ?? []).find((f) => !f.parentId);
  const created = await json("POST", "/api/folders", { parentId: root.id, name: "多样资源-" + Date.now() });
  const folderId = created.body?.data?.id;
  if (!folderId) throw new Error("folder creation failed");

  const gltf = gltfWithCompanions();
  const samples = [
    {
      label: "MC06 OBJ+MTL+texture",
      files: [["mc06t_cube.obj", OBJ_CUBE], ["mc06t.mtl", MTL_TEXTURED], ["mc06t_texture.png", TEXTURE_PNG]],
      primary: "mc06t_cube.obj",
      triangles: 12,
      minCompanionFetches: 2, // mtl + png
    },
    {
      label: "MC07 glTF+bin+texture",
      files: [["mc07_scene.gltf", gltf.json], ["mc07_buffer.bin", gltf.bin], ["mc07_texture.png", TEXTURE_PNG]],
      primary: "mc07_scene.gltf",
      triangles: 1,
      minCompanionFetches: 2,
    },
    {
      label: "MC09 3MF two parts",
      files: Object.entries(threemfTwoParts()),
      primary: "mc09_two.3mf",
      triangles: 24,
      minCompanionFetches: 0,
    },
  ];

  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`);
  };

  const chrome = spawn("/usr/bin/google-chrome", [
    "--headless=new", `--remote-debugging-port=${PORT}`, "--no-sandbox",
    "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
    "--window-size=1400,900", "about:blank",
  ], { stdio: "ignore" });

  let cdp;
  try {
    for (const sample of samples) {
      const ids = {};
      for (const [name, content] of sample.files) {
        ids[name] = await upload(folderId, name, content);
      }
      const fileId = ids[sample.primary];
      check(`${sample.label} uploaded`, Boolean(fileId), `fileId=${fileId}`);
      if (!fileId) continue;
      await json("POST", `/api/files/${fileId}/derivative`, {});

      if (!cdp) {
        let target = null;
        for (let i = 0; i < 50 && !target; i++) {
          await delay(200);
          try {
            const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
            target = list.find((t) => t.type === "page");
          } catch { /* not up yet */ }
        }
        if (!target) throw new Error("no debuggable target");
        cdp = await CDP.connect(target.webSocketDebuggerUrl);
        await cdp.send("Page.enable");
        await cdp.send("Runtime.enable");
        await cdp.send("Network.enable");
        await cdp.send("Network.setCookie", { name: "fm_session", value: cookieValue, domain: new URL(BASE).hostname, path: "/" });
        // Re-installed on every document so page errors survive navigation.
        await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
          source: "window.__pageErrors=[];window.addEventListener('error',e=>window.__pageErrors.push(String(e.message)));",
        });
      }
      // Track every network request the page makes while loading the model.
      const requests = [];
      const pump = () => {
        for (;;) {
          const hit = cdp.events.find((e) => e.method === "Network.requestWillBeSent");
          if (!hit) break;
          cdp.events.splice(cdp.events.indexOf(hit), 1);
          requests.push(hit.params.request.url);
        }
      };
      const loaded = new Promise((resolve) => {
        const timer = setInterval(() => {
          pump();
          if (cdp.events.some((e) => e.method === "Page.loadEventFired")) {
            clearInterval(timer);
            resolve();
          }
        }, 100);
        setTimeout(() => { clearInterval(timer); resolve(); }, 30000);
      });
      await cdp.send("Page.navigate", { url: `${BASE}/model/${fileId}` });
      await loaded;
      // The load event can fire before the mesh mounts; keep pumping.
      const deadline = Date.now() + 60000;
      let triangles = null;
      let pageState = "";
      while (Date.now() < deadline) {
        pump();
        const text = await cdp.evaluate("document.querySelector('.toolbar-hint')?.textContent ?? ''");
        const m = /三角形\s+(\d+)/.exec(text);
        if (m && Number(m[1]) > 0) { triangles = Number(m[1]); break; }
        if (!pageState) {
          pageState = await cdp.evaluate(
            "([...document.querySelectorAll('.notice.error,.empty,.breadcrumb')].map(e=>e.textContent).join(' | ')).slice(0,300)",
          );
        }
        await delay(300);
      }
      pump();
      const companionFetches = requests.filter((u) => /\/api\/files\/[^/]+\/bytes/.test(u)).length;
      const external = requests.filter((u) => /^https?:\/\//i.test(u) && !u.startsWith(BASE));
      const pageErrors = await cdp.evaluate("window.__pageErrors.slice()");
      check(`${sample.label} renders`, triangles === sample.triangles, `triangles=${triangles} want=${sample.triangles} page="${pageState}"`);
      check(`${sample.label} companions resolved`, companionFetches >= sample.minCompanionFetches,
            `sibling byte requests=${companionFetches} want>=${sample.minCompanionFetches}`);
      check(`${sample.label} no external fetch`, external.length === 0, external.slice(0, 3).join(",") || "none");
      check(`${sample.label} no page error`, (pageErrors ?? []).length === 0, (pageErrors ?? []).join(";") || "none");
    }
  } finally {
    cdp && cdp.close();
    chrome.kill("SIGKILL");
  }

  await json("DELETE", `/api/folders/${folderId}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`SUMMARY pass=${results.length - failed.length} total=${results.length}`);
  if (failed.length) {
    console.error("MC_MULTIASSET_FAILED: " + failed.map((f) => f.name).join(", "));
    process.exit(1);
  }
  console.log("MC_MULTIASSET_PASS");
}

main().catch((err) => {
  console.error("run error: " + err.message);
  process.exit(1);
});
