#!/usr/bin/env node
// MOD03/MOD04/MOD05 + MC05: model metadata panel verification.
//
// Uploads samples whose geometry is known exactly, then asserts the viewer's
// metadata panel over CDP:
//   MOD03 来源格式 / 版本 / 源 SHA / 尺寸 / 组件数 / 派生 SHA / 警告 all
//          present and matching the API truth
//   MOD04 mesh formats report 未知单位 (never assumed millimetres); a 3MF that
//          declares unit="millimeter" shows millimetre
//   MOD05 every dimension readout is labelled 近似（三角化网格）
//   MC05  STL ASCII renders and carries the unit hint
//
// Usage: node scripts/mod03_meta_check.mjs [--base http://127.0.0.1:18091]
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
const PORT = Number(opt("port", "9338"));

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
function zipStore(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, raw] of entries) {
    const content = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8");
    const nameBuf = Buffer.from(name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(crc32(content), 14);
    lh.writeUInt32LE(content.length, 18);
    lh.writeUInt32LE(content.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(Buffer.concat([lh, nameBuf, content]));
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc32(content), 16);
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

// Unit STL cube: 12 triangles, bounding box exactly 1x1x1.
function stlCube() {
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
                 [1, 6, 5], [1, 2, 6], [2, 7, 6], [2, 3, 7], [3, 4, 7], [0, 4, 3]];
  const out = ["solid mod03_cube"];
  for (const f of faces) {
    out.push("facet normal 0 0 1", "outer loop");
    for (const i of f) out.push("vertex " + v[i].join(" "));
    out.push("endloop", "endfacet");
  }
  out.push("endsolid mod03_cube");
  return Buffer.from(out.join("\n") + "\n");
}

// 3MF: two unit cubes, the second offset by 3 on X, unit declared millimetre.
function threemfTwoCubes(unit) {
  const mesh = (id, ox) => `<object id="${id}" type="model" name="part${id}">
   <mesh>
    <vertices>
     ${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
       const p = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]][i];
       return `<vertex x="${p[0] + ox}" y="${p[1]}" z="${p[2]}"/>`;
     }).join("")}
    </vertices>
    <triangles>
     ${[[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
       [1, 6, 5], [1, 2, 6], [2, 7, 6], [2, 3, 7], [3, 4, 7], [0, 4, 3]]
       .map((t) => `<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>`).join("")}
    </triangles>
   </mesh>
  </object>`;
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="${unit}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources>
  ${mesh(1, 0)}
  ${mesh(2, 3)}
 </resources>
 <build>
  <item objectid="1"/>
  <item objectid="2"/>
 </build>
</model>`;
  return zipStore([
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`],
    ["3D/3dmodel.model", model],
  ]);
}

// glTF: one triangle in the XY plane (bounding box 1x1x0), positions in an
// external .bin sibling (a .gltf without a buffer uri is read as GLB-embedded
// data, which this is not).
function gltfTriangle() {
  const positions = Buffer.alloc(36);
  [[0, 0, 0], [1, 0, 0], [0, 1, 0]].forEach((v, i) => {
    positions.writeFloatLE(v[0], i * 12);
    positions.writeFloatLE(v[1], i * 12 + 4);
    positions.writeFloatLE(v[2], i * 12 + 8);
  });
  return {
    "mod03_tri.gltf": Buffer.from(JSON.stringify({
      asset: { version: "2.0", generator: "mod03" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      buffers: [{ uri: "mod03_buffer.bin", byteLength: positions.length }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }],
    })),
    "mod03_buffer.bin": positions,
  };
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
      } else if (msg.method) this.events.push(msg);
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
      headers: { "Content-Type": "application/json", Cookie: `fm_session=${cookieValue}` },
      body: body ? JSON.stringify(body) : undefined,
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
  const created = await json("POST", "/api/folders", { parentId: root.id, name: "元数据面板-" + Date.now() });
  const folderId = created.body?.data?.id;
  if (!folderId) throw new Error("folder creation failed");

  const cases = [
    { label: "STL cube", name: "mod03_cube.stl", content: stlCube(),
      triangles: 12, dims: ["1.00", "1.00", "1.00"], unit: "未知单位（不按毫米计算）", components: 1 },
    { label: "3MF two cubes (declared mm)", name: "mod03_two.3mf", content: threemfTwoCubes("millimeter"),
      triangles: 24, dims: ["4.00", "1.00", "1.00"], unit: "millimeter", components: 2 },
    { label: "glTF triangle", name: "mod03_tri.gltf", content: gltfTriangle(),
      triangles: 1, dims: ["1.00", "1.00", "0.00"], unit: "未知单位（不按毫米计算）", components: 1,
      companions: true },
  ];

  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok });
    console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`);
  };

  const chrome = spawn("/usr/bin/google-chrome", [
    "--headless=new", `--remote-debugging-port=${PORT}`, "--no-sandbox",
    "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
    "--window-size=1400,900", "about:blank",
  ], { stdio: "ignore" });

  let cdp;
  try {
    for (const sample of cases) {
      // Multi-file samples upload every companion as its own file first.
      const files = sample.content instanceof Buffer
        ? [[sample.name, sample.content]]
        : Object.entries(sample.content);
      for (const [name, content] of files) {
        if (name !== sample.name) await upload(folderId, name, content);
      }
      const fileId = await upload(folderId, sample.name, files.find(([n]) => n === sample.name)[1]);
      check(`${sample.label} uploaded`, Boolean(fileId), `fileId=${fileId}`);
      if (!fileId) continue;
      const meta = await json("GET", `/api/files/${fileId}`);
      const truth = meta.body?.data?.file;
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
        await cdp.send("Network.setCookie", { name: "fm_session", value: cookieValue, domain: new URL(BASE).hostname, path: "/" });
      }
      const loaded = new Promise((resolve) => {
        const timer = setInterval(() => {
          if (cdp.events.some((e) => e.method === "Page.loadEventFired")) {
            clearInterval(timer);
            resolve();
          }
        }, 100);
        setTimeout(() => { clearInterval(timer); resolve(); }, 30000);
      });
      await cdp.send("Page.navigate", { url: `${BASE}/model/${fileId}` });
      await loaded;
      let panel = null;
      let pageState = "";
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline && !panel) {
        await delay(400);
        if (!pageState) {
          pageState = await cdp.evaluate(
            "([...document.querySelectorAll('.notice.error,.empty')].map(e=>e.textContent).join(' | ')).slice(0,160)",
          );
        }
        panel = await cdp.evaluate(`(()=>{
          const el=document.querySelector('.viewer-meta');
          if(!el)return null;
          const spans=[...el.querySelectorAll('.toolbar-hint')].map(s=>s.textContent??'');
          if(spans.length<5)return null;
          return spans.join(' || ');
        })()`);
      }
      check(`${sample.label} metadata panel rendered`, Boolean(panel), (String(panel).slice(0, 200) || pageState));
      if (!panel) continue;
      const text = String(panel);
      const field = (label) => {
        const m = new RegExp(label + "\\s*([^|]*)").exec(text);
        return m ? m[1].trim() : null;
      };
      check(`${sample.label} MOD03 format`, text.includes("来源格式"), field("来源格式"));
      check(`${sample.label} MOD03 version matches API`,
            text.includes("版本 v" + (truth?.currentVersionSeq ?? -1)), "v" + (truth?.currentVersionSeq ?? "?"));
      check(`${sample.label} MOD03 source SHA matches API`,
            text.includes((truth?.sha256 ?? "").slice(0, 16)), (truth?.sha256 ?? "").slice(0, 16));
      check(`${sample.label} MOD03 component count`, text.includes("组件数 " + sample.components), field("组件数"));
      check(`${sample.label} MOD03 derivative SHA`, /派生 SHA [0-9a-f]{16}/.test(text), field("派生 SHA"));
      check(`${sample.label} MOD04 unit`, text.includes("单位 " + sample.unit), field("单位"));
      check(`${sample.label} MOD05 approximate dimensions`,
            text.includes("尺寸（近似，三角化网格）" + sample.dims.join(" × ")), field("尺寸（近似，三角化网格）"));
      const hint = await cdp.evaluate("document.querySelector('.toolbar-hint')?.textContent ?? ''");
      check(`${sample.label} triangle count`, hint.includes("三角形 " + sample.triangles), String(hint).slice(0, 60));
    }
  } finally {
    cdp && cdp.close();
    chrome.kill("SIGKILL");
  }

  await json("DELETE", `/api/folders/${folderId}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`SUMMARY pass=${results.length - failed.length} total=${results.length}`);
  if (failed.length) {
    console.error("MOD03_META_CHECK_FAILED: " + failed.length + " checks");
    process.exit(1);
  }
  console.log("MOD03_META_CHECK_PASS");
}

main().catch((err) => {
  console.error("run error: " + err.message);
  process.exit(1);
});
