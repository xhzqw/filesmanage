#!/usr/bin/env node
// Visual & accessibility gate (UX-ACCEPTANCE-v1 §6 VIS-04/VIS-11, §8 G5;
// DESIGN-SYSTEM-v1 §3.2/§5): fixed three-viewport screenshots plus a11y
// metadata over the real UI.
//
// For /doc, /trash, /org, /approvals and /preview/:id (a real file id resolved
// through the API) at 1366x768, 1440x900 and 1920x1080 it asserts per viewport:
//   - no horizontal document overflow (scrollWidth <= clientWidth + 1);
//   - the page's primary action sits inside the viewport (upload control on
//     /doc, restore button on /trash, workgroup-creation button on /org,
//     approve button on /approvals, download link on /preview);
//   - the table and the breadcrumb are reachable (non-zero size).
// It captures one PNG per route+viewport into docs/evidence/ux/ and reports
// the paths, then asserts the a11y metadata on /doc (role=grid with
// aria-label, aria-selected rows, role=tree with treeitems, one shell nav
// with the full label set). The a11y assertions run on the same /doc route
// pinned to this gate's fixture folder so the grid is guaranteed to carry
// real rows.
//
// This gate is new content (no ad-hoc source) and is independent of
// browser_journey_check.mjs / browser_business_check.mjs. One Chrome session
// is reused for every navigation.
//
// Usage: node scripts/ux_visual_check.mjs [--base http://127.0.0.1:18091]
//        [--password-file .secrets/admin.password] [--port 9362]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const BASE = opt("base", "http://127.0.0.1:18091").replace(/\/+$/, "");
const PASSWORD_FILE = opt("password-file", ".secrets/admin.password");
const PORT = Number(opt("port", "9362"));
const EVIDENCE_DIR = "docs/evidence/ux";

const password = readFileSync(PASSWORD_FILE, "utf8").trim();
const stamp = String(Date.now());

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`);
};

const VIEWPORTS = [
  { name: "1366x768", width: 1366, height: 768 },
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1920x1080", width: 1920, height: 1080 },
];

const NAV_LABELS = ["文档管理", "搜索", "共享/关注", "统计", "审批", "回收站", "组织管理"];

class CDP {
  constructor(ws) {
    this.ws = ws; this.next = 1; this.pending = new Map(); this.events = [];
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
    if (res.exceptionDetails) throw new Error("evaluate threw: " + JSON.stringify(res.exceptionDetails).slice(0, 200));
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
    await delay(1000);
  }
  async waitFor(predicate, timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await this.evaluate(`(${predicate})()`);
      if (value) return value;
      if (Date.now() > deadline) return null;
      await delay(250);
    }
  }
  close() { this.ws.close(); }
}

// A selector expression that returns the element carrying the page's primary
// action (or null); each one mirrors the surface the other gates drive. On
// /org the workgroup-creation button is used: the user-creation form lives
// below the (unbounded, internally scrolling) user list, so it is not
// guaranteed to be inside the initial viewport on a long-lived dev instance.
const PRIMARY_FINDERS = {
  doc: `(()=>{const label=[...document.querySelectorAll('label')].find(l=>l.querySelector('input[type=file]'));
    return document.querySelector('.upload-button')||label||document.querySelector('input[type=file]')||null;})()`,
  trash: `(()=>[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='恢复')||null)()`,
  org: `(()=>[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='创建工作组')||null)()`,
  approvals: `(()=>[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='通过')||null)()`,
  preview: `(()=>[...document.querySelectorAll('a')].find(a=>a.textContent?.trim()==='下载原始字节')||null)()`,
};

const PRIMARY_LABELS = {
  doc: "上传文件",
  trash: "恢复",
  org: "创建工作组",
  approvals: "通过",
  preview: "下载原始字节",
};

async function main() {
  // ---- fixtures (API session) ----
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "admin", password }),
  });
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith("fm_session=")).split(";")[0];
  const json = async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method, headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const tree = await json("GET", "/api/folders/tree");
  const rootId = (tree.body?.data ?? []).find((f) => f.id === "folder_root")?.id
    ?? (tree.body?.data ?? []).find((f) => !f.parentId)?.id;
  const me = (await json("GET", "/api/me")).body?.data;

  const uploadTo = async (folderId, name, content) => {
    const form = new FormData();
    form.set("folderId", folderId);
    form.set("file", new Blob([content]), name);
    form.set("idempotencyKey", "ux-visual-" + name + "-" + stamp);
    const res = await fetch(`${BASE}/api/files`, { method: "POST", headers: { Cookie: cookie }, body: form });
    return (await res.json()).data;
  };

  // /doc needs real rows (a11y), /preview needs a real file id, /trash needs a
  // row with a restore action: three files in one folder, one of them deleted.
  const visFolderId = (await json("POST", "/api/folders", { parentId: rootId, name: "UX-VIS-" + stamp })).body?.data?.id;
  await uploadTo(visFolderId, "vis-keep.txt", `visual keep ${stamp}\n`);
  const previewFile = await uploadTo(visFolderId, "vis-preview.txt", `visual preview ${stamp}\n`);
  const trashFile = await uploadTo(visFolderId, "vis-trash.txt", `visual trash ${stamp}\n`);
  await json("DELETE", `/api/files/${trashFile.fileId}`);

  // /approvals needs one genuinely pending decision so its primary action
  // (通过) exists on the page.
  const approvalFolderId = (await json("POST", "/api/folders", { parentId: rootId, name: "UX-VIS-APPROVAL-" + stamp })).body?.data?.id;
  await json("PUT", `/api/folders/${approvalFolderId}/approval-policy`, { approverId: me.id, enabled: true });
  const pendingFile = await uploadTo(approvalFolderId, "vis-pending.txt", `visual pending ${stamp}\n`);
  const lock = (await json("POST", `/api/files/${pendingFile.fileId}/lock`, { baseSeq: 1 })).body?.data?.lockToken;
  const submit = await json("POST", `/api/files/${pendingFile.fileId}/save`, {
    baseSeq: 1, lockToken: lock, data: Buffer.from(`visual pending v2 ${stamp}\n`).toString("base64"),
    idempotencyKey: "ux-visual-pending-" + stamp,
  });
  if (submit.status !== 202) throw new Error(`pending approval fixture failed: HTTP ${submit.status}`);

  const ROUTES = [
    { name: "doc", path: "/doc", wait: `()=>!!document.querySelector('table[role=grid]')` },
    { name: "trash", path: "/trash", wait: `()=>[...document.querySelectorAll('button')].some(b=>b.textContent?.trim()==='恢复')` },
    { name: "org", path: "/org", wait: `()=>!!document.querySelector('input[aria-label="新账号"]')` },
    { name: "approvals", path: "/approvals", wait: `()=>[...document.querySelectorAll('button')].some(b=>b.textContent?.trim()==='通过')` },
    { name: "preview", path: `/preview/${previewFile.fileId}`, wait: `()=>document.body.textContent?.includes('下载原始字节')` },
  ];

  mkdirSync(EVIDENCE_DIR, { recursive: true });

  const chrome = spawn("/usr/bin/google-chrome", [
    "--headless=new", `--remote-debugging-port=${PORT}`, "--no-sandbox",
    "--disable-dev-shm-usage", "--window-size=1920,1080", "about:blank",
  ], { stdio: "ignore" });

  let cdp = null;
  const evidence = [];
  let runError = null;
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

    // authenticate the browser session once through the real login form
    await cdp.navigate(`${BASE}/login`);
    await cdp.waitFor(`()=>!!document.querySelector('input[type=password]')`, 15000);
    await cdp.evaluate(`(()=>{
      const set=(el,v)=>{const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
      const fields=[...document.querySelectorAll('input')];
      const user=fields.find(f=>f.type==='text'||f.type==='email'||(!f.type&&f.offsetParent!==null));
      const pass=document.querySelector('input[type=password]');
      if(user)set(user,'admin');
      if(pass)set(pass,${JSON.stringify(password)});
      [...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='登录')?.click();return true;})()`);
    const session = await cdp.waitFor(`()=>location.pathname==='/doc'||location.pathname==='/first-sign-in'`, 20000);
    check("VIS-04 browser session established", Boolean(session), await cdp.evaluate(`(()=>location.pathname)()`));

    // ---- three-viewport capture loop: one Chrome session, reused navigation ----
    for (const vp of VIEWPORTS) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: false,
      });
      for (const route of ROUTES) {
        await cdp.navigate(BASE + route.path);
        const ready = await cdp.waitFor(route.wait, 20000);
        await delay(400);

        // no horizontal document overflow
        const overflow = await cdp.evaluate(`(()=>{
          const de=document.documentElement;
          const body=document.body;
          return {scrollWidth:Math.max(de.scrollWidth,body?body.scrollWidth:0),clientWidth:de.clientWidth};})()`);
        check(`VIS-04 ${route.name} ${vp.name}: no horizontal document overflow`,
          Boolean(overflow) && overflow.scrollWidth <= overflow.clientWidth + 1, JSON.stringify(overflow));

        // the primary action sits inside the viewport
        const element = await cdp.evaluate(`(()=>{
          const el=${PRIMARY_FINDERS[route.name]};
          if(!el)return {found:false};
          const r=el.getBoundingClientRect();
          const s=getComputedStyle(el);
          return {found:true,width:r.width,height:r.height,left:r.left,top:r.top,right:r.right,bottom:r.bottom,
                  visible:s.display!=='none'&&s.visibility!=='hidden'};})()`);
        const elementInView = Boolean(element) && element.found && element.visible
          && element.width > 0 && element.height > 0
          && element.left >= -1 && element.top >= -1
          && element.right <= vp.width + 1 && element.bottom <= vp.height + 1;
        check(`VIS-04 ${route.name} ${vp.name}: primary action inside the viewport`,
          elementInView, `${PRIMARY_LABELS[route.name]} ${JSON.stringify(element)}`);

        // the table and breadcrumb are reachable (not clipped to zero size)
        const surfaces = await cdp.evaluate(`(()=>{
          const measure=(el)=>{if(!el)return null;const r=el.getBoundingClientRect();
            return {width:r.width,height:r.height,visible:r.width>0&&r.height>0};};
          return {crumb:measure(document.querySelector('nav.breadcrumb')||document.querySelector('.breadcrumb')),
                  table:measure(document.querySelector('table[role=grid]')||document.querySelector('table'))};})()`);
        const reachable = surfaces && surfaces.crumb && surfaces.crumb.visible
          && surfaces.table && surfaces.table.visible;
        check(`VIS-04 ${route.name} ${vp.name}: table and breadcrumb reachable`,
          Boolean(reachable), `${JSON.stringify(surfaces)} ready=${Boolean(ready)}`);

        const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        const file = `${EVIDENCE_DIR}/${route.name}-${vp.name}.png`;
        writeFileSync(file, Buffer.from(shot.data, "base64"));
        evidence.push(file);
      }
    }

    // ---- a11y metadata on /doc (fixture folder guarantees real rows) ----
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.navigate(`${BASE}/doc?folder=${visFolderId}`);
    const gridReady = await cdp.waitFor(`()=>document.querySelectorAll('table[role=grid] tbody tr[data-id]').length>=1`, 20000);
    const grid = await cdp.evaluate(`(()=>{
      const t=document.querySelector('table[role=grid]');
      if(!t)return {found:false};
      return {found:true,label:t.getAttribute('aria-label')||'',rows:t.querySelectorAll('tbody tr[data-id]').length};})()`);
    check("VIS-11 /doc: grid exposes role=grid with aria-label",
      Boolean(gridReady) && Boolean(grid?.found) && grid.label.trim().length > 0, JSON.stringify(grid));

    const rows = await cdp.evaluate(`(()=>[...document.querySelectorAll('table[role=grid] tbody tr[data-id]')]
      .map(r=>({selected:r.getAttribute('aria-selected')})))()`);
    check("VIS-11 /doc: grid rows carry aria-selected",
      Array.isArray(rows) && rows.length >= 1
      && rows.every((r) => r.selected === "true" || r.selected === "false"), JSON.stringify(rows));

    const treeState = await cdp.evaluate(`(()=>{
      const trees=[...document.querySelectorAll('ul[role=tree]')];
      return {trees:trees.length,label:trees[0]?trees[0].getAttribute('aria-label')||'':'',
              items:document.querySelectorAll('ul[role=tree] li[role=treeitem]').length};})()`);
    check("VIS-11 /doc: tree exposes role=tree with treeitems",
      treeState && treeState.trees === 1 && treeState.items >= 1 && treeState.label.trim().length > 0,
      JSON.stringify(treeState));

    const shell = await cdp.evaluate(`(()=>({
      headers:document.querySelectorAll('header.header').length,
      navs:document.querySelectorAll('header.header nav').length,
      labels:[...document.querySelectorAll('header.header nav a')].map(a=>a.textContent?.trim())}))()`);
    const navOk = shell && shell.labels.length === NAV_LABELS.length
      && NAV_LABELS.every((label, i) => shell.labels[i] === label);
    check("VIS-11 /doc: single shell nav with the full label set",
      Boolean(shell) && shell.headers === 1 && shell.navs === 1 && navOk, JSON.stringify(shell));

    check("VIS-04 evidence screenshots written",
      evidence.length === VIEWPORTS.length * ROUTES.length
      && evidence.every((file) => existsSync(file) && statSync(file).size > 1024),
      `${evidence.length} files in ${EVIDENCE_DIR}`);
  } catch (err) {
    runError = err;
  } finally {
    cdp && cdp.close();
    chrome.kill("SIGKILL");
  }

  // ---- cleanup (always): decide/reject the pending fixture, then purge ----
  const cleanupErrors = [];
  const attempt = async (fn) => {
    try { await fn(); } catch (err) { cleanupErrors.push(String(err?.message ?? err)); }
  };
  await attempt(async () => {
    const mine = await json("GET", "/api/approvals?scope=mine");
    const pending = (mine.body?.data ?? []).find((a) => a.fileName === "vis-pending.txt" && a.state === "pending");
    if (pending) await json("POST", `/api/approvals/${pending.id}/reject`, { comment: "visual gate cleanup" });
  });
  await attempt(async () => {
    if (visFolderId) await json("DELETE", `/api/folders/${visFolderId}`);
    if (approvalFolderId) await json("DELETE", `/api/folders/${approvalFolderId}`);
    const trash = await json("GET", "/api/trash");
    for (const entry of trash.body?.data ?? []) {
      const name = String(entry.name ?? entry.oldName ?? "");
      if (name.includes("UX-VIS-" + stamp) || name.startsWith("vis-")) {
        await json("DELETE", "/api/trash/" + entry.id);
      }
    }
  });

  console.log(`SUMMARY pass=${results.length - results.filter((r) => !r.ok).length} total=${results.length}`);
  console.log(`EVIDENCE_FILES ${evidence.length} dir=${EVIDENCE_DIR}`);
  for (const file of evidence) console.log(`EVIDENCE ${file}`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length || cleanupErrors.length || runError) {
    if (failed.length) console.error("UX_VISUAL_FAILED: " + failed.map((f) => f.name).join(", "));
    if (runError) console.error("run error: " + runError.message);
    if (cleanupErrors.length) console.error("UX_VISUAL_CLEANUP_FAILED: " + cleanupErrors.join(" | "));
    process.exit(1);
  }
  console.log("UX_VISUAL_PASS");
}

main().catch((err) => {
  console.error("run error: " + err.message);
  process.exit(1);
});
