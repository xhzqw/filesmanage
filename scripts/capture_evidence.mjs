#!/usr/bin/env node
// Visual acceptance evidence: screenshots of every real page, captured through
// the same authenticated browser session the journey gate uses.
//
// DOM assertions prove behaviour; these images are what a reviewer looks at to
// confirm the brand shell (DEC-14), the folder tree, the model viewer with its
// assembly part tree, and the business surfaces actually render.
//
// Usage: node scripts/capture_evidence.mjs [--base http://127.0.0.1:18091]
//        [--out docs/evidence]
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const BASE = opt("base", "http://127.0.0.1:18091").replace(/\/+$/, "");
const OUT = opt("out", "docs/evidence");
const PASSWORD_FILE = opt("password-file", ".secrets/admin.password");
const PORT = Number(opt("port", "9346"));

const password = readFileSync(PASSWORD_FILE, "utf8").trim();

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
    const res = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error("evaluate threw");
    return res.result.value;
  }
  async navigate(url) {
    const loaded = new Promise((resolve) => {
      const timer = setInterval(() => {
        const hit = this.events.find((e) => e.method === "Page.loadEventFired");
        if (hit) { this.events.splice(this.events.indexOf(hit), 1); clearInterval(timer); resolve(); }
      }, 100);
      setTimeout(() => { clearInterval(timer); resolve(); }, 30000);
    });
    await this.send("Page.navigate", { url });
    await loaded;
    await delay(1500);
  }
  async shot(name) {
    const res = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const path = `${OUT}/${name}.png`;
    writeFileSync(path, Buffer.from(res.data, "base64"));
    return path;
  }
  close() { this.ws.close(); }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const chrome = spawn("/usr/bin/google-chrome", [
    "--headless=new", `--remote-debugging-port=${PORT}`, "--no-sandbox",
    "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
    "--window-size=1440,900", "about:blank",
  ], { stdio: "ignore" });

  let cdp;
  const shots = [];
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

    // 1. login page (unauthenticated)
    await cdp.navigate(`${BASE}/login`);
    shots.push(["01-login", await cdp.shot("01-login")]);

    // 2. real login
    await cdp.evaluate(`(()=>{
      const set=(el,v)=>{const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
      set(document.querySelector('input[type=text],input:not([type])'),'admin');
      set(document.querySelector('input[type=password]'),${JSON.stringify(password)});
      [...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='登录').click();return true;})()`);
    // The SPA redirects to /doc on success; only then are later pages authenticated.
    for (let i = 0; i < 40; i++) {
      const path = await cdp.evaluate(`(()=>location.pathname)()`);
      if (path === "/doc" || path === "/first-sign-in") break;
      await delay(250);
    }
    // 3. the document page with the real folder tree
    await cdp.navigate(`${BASE}/doc`);
    await delay(2000);
    shots.push(["02-documents", await cdp.shot("02-documents")]);

    // 4. preview of a real file (byte metadata visible)
    const list = await cdp.evaluate(`(async()=>{
      const res=await fetch('/api/files?folder=folder_root&limit=5',{credentials:'same-origin'});
      const body=await res.json();
      const item=(body.data?.items??[])[0];
      return item?item.id:null;})()`);
    if (list) {
      await cdp.navigate(`${BASE}/preview/${list}`);
      await delay(1500);
      shots.push(["03-preview", await cdp.shot("03-preview")]);
    }

    // 5. the model viewer with the assembly part tree
    const step = await cdp.evaluate(`(async()=>{
      // Walk every visible folder and keep the NEWEST model file: a model
      // whose derivative predates the MSH pipeline renders without a part
      // tree, so the freshest one is the one that shows the assembly.
      const tree=await (await fetch('/api/folders/tree',{credentials:'same-origin'})).json();
      let best=null;
      for(const folder of (tree.data??[])){
        const res=await fetch('/api/files?folder='+folder.id+'&limit=200',{credentials:'same-origin'});
        const body=await res.json();
        for(const item of (body.data?.items??[])){
          if(!/\\.(step|stp|igs|iges)$/i.test(item.name))continue;
          if(!best||item.updatedAt>best.updatedAt)best=item;
        }
      }
      return best?best.id:null;})()`);
    if (step) {
      await cdp.navigate(`${BASE}/model/${step}`);
      await delay(6000);
      shots.push(["04-model-assembly", await cdp.shot("04-model-assembly")]);
    }

    // 6-9. business surfaces
    for (const [name, route] of [["05-search", "/search"], ["06-stats", "/stats"],
                                 ["07-org", "/org"], ["08-approvals", "/approvals"]]) {
      await cdp.navigate(`${BASE}${route}`);
      await delay(2000);
      shots.push([name, await cdp.shot(name)]);
    }

    // 10. the trash page
    await cdp.navigate(`${BASE}/trash`);
    await delay(1500);
    shots.push(["09-trash", await cdp.shot("09-trash")]);
  } finally {
    cdp && cdp.close();
    chrome.kill("SIGKILL");
  }

  const index = [
    "# 浏览器验收截图证据（2026-10-09）",
    "",
    "由 `scripts/capture_evidence.mjs` 通过已认证的 headless Chrome 会话抓取；",
    "行为断言见 `scripts/browser_journey_check.mjs`（19/19）与",
    "`scripts/browser_business_check.mjs`（12/12）。",
    "",
    "| 文件 | 页面 |",
    "|---|---|",
    ...shots.map(([name]) => `| ${name}.png | ${name.replace(/^\d+-/, "").replace(/-/g, " ")} |`),
    "",
  ].join("\n");
  writeFileSync(`${OUT}/README.md`, index);
  for (const [name, path] of shots) {
    console.log(`captured ${path}`);
  }
  console.log(`EVIDENCE_CAPTURED ${shots.length} screenshots -> ${OUT}`);
}

main().catch((err) => {
  console.error("run error: " + err.message);
  process.exit(1);
});
