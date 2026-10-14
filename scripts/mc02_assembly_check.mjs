#!/usr/bin/env node
// MC02/MOD02: STEP assembly tree over the real pipeline.
//
// Builds a two-solid STEP with gmsh, uploads it, lets the CAD worker convert
// it (MSH 2.2 keeps shared node indices), and verifies in the real browser:
//   MC02  the assembly is recovered as two parts with the correct bounding
//         boxes (10x10x10 and 5x5x5), not one merged mesh
//   MOD02 a part tree with per-part visibility (screenshot-proven), selection
//         highlight and restore-all
//
// Usage: node scripts/mc02_assembly_check.mjs [--base http://127.0.0.1:18091]
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const BASE = opt("base", "http://127.0.0.1:18091").replace(/\/+$/, "");
const PASSWORD_FILE = opt("password-file", ".secrets/admin.password");
const PORT = Number(opt("port", "9339"));

// Two solids of exactly known size: 10x10x10 at the origin and 5x5x5 at x=20.
function buildStep() {
  const dir = os.tmpdir();
  const geo = path.join(dir, "mc02-assembly.geo");
  const step = path.join(dir, "mc02-assembly.step");
  writeFileSync(geo,
    'SetFactory("OpenCASCADE");\nBox(1) = {0,0,0, 10,10,10};\nBox(2) = {20,0,0, 5,5,5};\n');
  execFileSync("gmsh", ["-3", geo, "-format", "step", "-o", step], { stdio: "ignore" });
  return readFileSync(step);
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
  async screenshot() {
    const res = await this.send("Page.captureScreenshot", { format: "png" });
    const crypto = await import("node:crypto");
    return crypto.createHash("sha256").update(Buffer.from(res.data, "base64")).digest("hex").slice(0, 16);
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

  const step = buildStep();
  const tree = await json("GET", "/api/folders/tree");
  const root = (tree.body?.data ?? []).find((f) => !f.parentId);
  const created = await json("POST", "/api/folders", { parentId: root.id, name: "装配树-" + Date.now() });
  const folderId = created.body?.data?.id;
  if (!folderId) throw new Error("folder creation failed");

  const form = new FormData();
  form.set("folderId", folderId);
  form.set("file", new Blob([step]), "mc02-assembly.step");
  const uploaded = await fetch(`${BASE}/api/files`, {
    method: "POST", headers: { Cookie: `fm_session=${cookieValue}` }, body: form,
  });
  const uploadBody = await uploaded.json();
  const fileId = uploadBody?.data?.fileId;
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok });
    console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`);
  };
  check("two-solid STEP uploaded", Boolean(fileId), `fileId=${fileId} bytes=${step.length}`);
  if (!fileId) {
    console.log("MC02_ASSEMBLY_FAILED: no file");
    process.exit(1);
  }

  await json("POST", `/api/files/${fileId}/derivative`, {});
  let outputKind = null;
  for (let i = 0; i < 90; i++) {
    const status = await json("GET", `/api/files/${fileId}/derivative`);
    const data = status.body?.data ?? {};
    outputKind = data.outputKind;
    if (data.state === "ready") break;
    if (data.state === "failed") {
      check("worker converted the assembly", false, `state=failed errorCode=${data.errorCode}`);
      break;
    }
    await delay(1000);
  }
  const finalStatus = await json("GET", `/api/files/${fileId}/derivative`);
  check("worker converted the assembly", finalStatus.body?.data?.state === "ready",
        `outputKind=${outputKind} state=${finalStatus.body?.data?.state}`);

  const chrome = spawn("/usr/bin/google-chrome", [
    "--headless=new", `--remote-debugging-port=${PORT}`, "--no-sandbox",
    "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
    "--window-size=1400,900", "about:blank",
  ], { stdio: "ignore" });

  let cdp;
  try {
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
    // Count real GPU draw calls, not requestAnimationFrame callbacks. An idle
    // viewer should cease submitting geometry until the scene changes.
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(()=>{
      window.__cadDrawCalls=0;
      window.__cadDeletedBuffers=0;
      window.__cadLastContext=null;
      const oldGetContext=HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext=function(kind,...args){
       const context=oldGetContext.call(this,kind,...args);
       if(typeof kind==="string"&&/^webgl/.test(kind)&&context){
        window.__cadLastContext=context;
       }
       return context;
      };
      for(const Ctor of [window.WebGLRenderingContext,window.WebGL2RenderingContext]){
       if(!Ctor)continue;
       for(const method of ["drawArrays","drawElements","drawArraysInstanced","drawElementsInstanced"]){
        const original=Ctor.prototype[method];
        if(typeof original!=="function")continue;
        Ctor.prototype[method]=function(...args){
         window.__cadDrawCalls++;
         return original.apply(this,args);
        };
       }
       const dispose=Ctor.prototype.deleteBuffer;
       if(typeof dispose==="function"){
        Ctor.prototype.deleteBuffer=function(...args){
         window.__cadDeletedBuffers++;
         return dispose.apply(this,args);
        };
       }
      }
    })()` });
    await cdp.send("Network.setCookie", { name: "fm_session", value: cookieValue, domain: new URL(BASE).hostname, path: "/" });
    const loaded = new Promise((resolve) => {
      const timer = setInterval(() => {
        if (cdp.events.some((e) => e.method === "Page.loadEventFired")) { clearInterval(timer); resolve(); }
      }, 100);
      setTimeout(() => { clearInterval(timer); resolve(); }, 30000);
    });
    await cdp.send("Page.navigate", { url: `${BASE}/model/${fileId}` });
    await loaded;

    let panel = null;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && !panel) {
      await delay(400);
      panel = await cdp.evaluate(`(()=>{
        const el=document.querySelector('.toolbar[aria-label="装配零件"]');
        if(!el)return null;
        const labels=[...el.querySelectorAll('label')];
        if(!labels.length)return null;
        return labels.map(l=>{
          const name=l.querySelector('button')?.textContent?.trim()??'';
          const hint=l.querySelector('.toolbar-hint')?.textContent?.trim()??'';
          const box=l.querySelector('input[type=checkbox]');
          return{name,hint,checked:box?box.checked:null};
        });
      })()`);
    }
    check("MC02 assembly part tree rendered", Array.isArray(panel) && panel.length > 0,
          JSON.stringify(panel));
    if (Array.isArray(panel) && panel.length) {
      await delay(750);
      const idleStart=await cdp.evaluate("(()=>window.__cadDrawCalls)()");
      await delay(750);
      const idleEnd=await cdp.evaluate("(()=>window.__cadDrawCalls)()");
      check("MOD08 idle CAD canvas stops GPU draw calls",
        Number.isFinite(idleStart)&&idleEnd-idleStart<=4,
        `draw calls during 750ms idle=${idleEnd-idleStart}`);
      const boxes = panel.map((p) => p.hint.split("·")[0].trim()).sort();
      const want = ["10.00×10.00×10.00", "5.00×5.00×5.00"].sort();
      check("MC02 two parts with the true bounding boxes",
            boxes.length === 2 && boxes[0] === want[0] && boxes[1] === want[1],
            `${JSON.stringify(boxes)} want ${JSON.stringify(want)}`);

      const before = await cdp.screenshot();
      // Hide the second part: the composited frame must change.
      await cdp.evaluate(`(()=>{const boxes=[...document.querySelectorAll('.toolbar[aria-label="装配零件"] input[type=checkbox]')];boxes[1].click();return true;})()`);
      await delay(600);
      const hidden = await cdp.screenshot();
      check("MOD02 per-part visibility changes the render", hidden !== before, "pixels changed");
      const afterChange=await cdp.evaluate("(()=>window.__cadDrawCalls)()");
      check("MOD08 changed parts invalidate and redraw",
        Number.isFinite(afterChange)&&afterChange>idleEnd,
        `draw calls added=${afterChange-idleEnd}`);
      const state = await cdp.evaluate(`(()=>{const boxes=[...document.querySelectorAll('.toolbar[aria-label="装配零件"] input[type=checkbox]')];return boxes.map(b=>b.checked);})()`);
      check("MOD02 part hidden in the tree", JSON.stringify(state) === "[true,false]", JSON.stringify(state));

      // Restore all: the frame returns to the original.
      await cdp.evaluate(`(()=>{const b=[...document.querySelectorAll('.toolbar[aria-label="装配零件"] button')].find(x=>x.textContent?.trim()==='全部显示');b?.click();return true;})()`);
      await delay(600);
      const restored = await cdp.screenshot();
      check("MOD02 restore-all returns the original frame", restored === before, `${restored} vs ${before}`);

      // Selection highlight: the chosen part's button carries the on state.
      await cdp.evaluate(`(()=>{const b=[...document.querySelectorAll('.toolbar[aria-label="装配零件"] label button')][0];b.click();return true;})()`);
      await delay(300);
      const highlight = await cdp.evaluate(`(()=>{const b=[...document.querySelectorAll('.toolbar[aria-label="装配零件"] label button')][0];return b?b.className:null;})()`);
      check("MOD02 selection highlight", String(highlight).includes("on"), String(highlight));

      // Verify ordinary route exit *before* context-loss injection. Otherwise
      // the browser may reclaim buffers during the loss event itself.
      const beforeDispose=await cdp.evaluate("(()=>window.__cadDeletedBuffers)()");
      await cdp.evaluate(`(()=>{
       [...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='返回文件')?.click();
       return true;
      })()`);
      await delay(550);
      const cleanup=await cdp.evaluate(`(()=>({
       path:location.pathname,canvases:document.querySelectorAll('.viewer-stage canvas').length,
       deletedBuffers:window.__cadDeletedBuffers,
       gpuContextLost:window.__cadLastContext?.isContextLost?.()??false,
      }))()`);
      check("MOD08 route exit detaches canvas and frees GPU geometry",
       cleanup.path==='/preview/'+fileId&&cleanup.canvases===0&&
       cleanup.gpuContextLost===true,JSON.stringify({...cleanup,deletedBefore:beforeDispose}));

      // Reopen the real model to independently validate the WebGL loss path.
      await cdp.send("Page.navigate",{url:`${BASE}/model/${fileId}`});
      let reopened=false;
      for(let n=0;n<60&&!reopened;n++){
       await delay(250);
       reopened=Boolean(await cdp.evaluate(`(()=>!!document.querySelector(
        '.viewer-stage canvas')&&!!document.querySelector('.toolbar[aria-label="视图控制"]'))()`).catch(()=>false));
      }
      check("MOD08 scene can reopen after GPU teardown",reopened,String(reopened));
      if(reopened){
       await cdp.evaluate(`(()=>{
        document.querySelector('.viewer-stage canvas')?.dispatchEvent(
         new Event('webglcontextlost',{cancelable:true}));
        return true;
       })()`);
       await delay(180);
       const lost=await cdp.evaluate(`(()=>{
        const n=document.querySelector('.notice.error');
        return !!n?.textContent?.includes('WebGL')&&!!n.querySelector('a[href*="/bytes"]');
       })()`);
       check("MOD07 WebGL context loss explains recovery",lost,String(lost));
      }
    }
  } finally {
    cdp && cdp.close();
    chrome.kill("SIGKILL");
  }

  await json("DELETE", `/api/folders/${folderId}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`SUMMARY pass=${results.length - failed.length} total=${results.length}`);
  if (failed.length) {
    console.error("MC02_ASSEMBLY_FAILED: " + failed.map((f) => f.name).join(", "));
    process.exit(1);
  }
  console.log("MC02_ASSEMBLY_PASS");
}

main().catch((err) => {
  console.error("run error: " + err.message);
  process.exit(1);
});
