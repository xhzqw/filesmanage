#!/usr/bin/env node
// Desktop interaction gate (UX-ACCEPTANCE-v1 §4 DI-01..DI-19, §5 WF-11, §6
// VIS-09/VIS-10, §8 G1/G2): the shared Dialog primitive, the unified shell, the
// file selection controller, the navigation tree keyboard contract, context
// menus, drag-drop upload and third-party editor keyboard/theme scoping — all
// through the real UI.
//
// This is the committed merge of the ad-hoc smoke runs g1_dialog / g1_shell /
// g2_select / g2_tree / g3_menu. Every original check is preserved verbatim.
// The gate is independent of browser_journey_check.mjs and
// browser_business_check.mjs and does not reduce their coverage. The suites
// share one Chrome session except PAGED and EDITORS, which drive their own
// (PAGED for a clean fixture tree, EDITORS for the software-WebGL flags the
// CAD canvas needs); every suite keeps separate timestamped fixtures, and a
// suite that crashes records one extra FAIL line naming it while the remaining
// suites still run.
//
// Usage: FILESMANAGE_UX_FIXTURE_DB=filesmanage_ux_test DATABASE_URL=postgres://.../filesmanage_ux_test
//        node scripts/ux_desktop_check.mjs --isolated-fixtures --base http://127.0.0.1:18092
//        [--password-file .secrets/admin.password] [--port 9360]
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {assertIsolatedFixtures} from "./ux_fixture_guard.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const BASE = opt("base", "http://127.0.0.1:18091").replace(/\/+$/, "");
const PASSWORD_FILE = opt("password-file", ".secrets/admin.password");
const PORT = Number(opt("port", "9360"));

assertIsolatedFixtures({base:BASE,args,explicitBase:args.includes("--base")});

const password = readFileSync(PASSWORD_FILE, "utf8").trim();
const stamp = String(Date.now());

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`);
};

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
    if (res.exceptionDetails) throw new Error("evaluate threw: " + JSON.stringify(res.exceptionDetails).slice(0, 250) + " EXPR=" + expression.slice(0, 160));
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
    await delay(1200);
  }
  async key(key, code, vk, modifiers = 0) {
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
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
  async login() {
    await this.evaluate(`(()=>{
      const set=(el,v)=>{const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
      const fields=[...document.querySelectorAll('input')];
      const user=fields.find(f=>f.type==='text'||f.type==='email'||(!f.type&&f.offsetParent!==null));
      const pass=document.querySelector('input[type=password]');
      if(user)set(user,'admin');
      if(pass)set(pass,${JSON.stringify(password)});
      const btn=[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='登录');
      btn?.click();return true;})()`);
    return this.waitFor(`()=>location.pathname==='/doc'||location.pathname==='/first-sign-in'`, 20000);
  }
  close() { this.ws.close(); }
}

const CTRL = 2, SHIFT = 8;

const NAV_LABELS = ["文档管理", "全局搜索", "共享/关注", "统计", "审批", "回收站", "组织与权限"];

// The shell login check must exercise a real logged-out login page: the
// browser session from the previous suite is revoked first.
async function logoutThroughUi(cdp) {
  await cdp.navigate(`${BASE}/doc`);
  const path = await cdp.evaluate(`(()=>location.pathname)()`);
  if (path === "/login") return true;
  const exitReady = await cdp.waitFor(`()=>[...document.querySelectorAll('header.header button')].some(b=>b.textContent?.trim()==='退出')`, 15000);
  if (!exitReady) return false;
  const clicked = await cdp.evaluate(`(()=>{
    const btn=[...document.querySelectorAll('header.header button')].find(b=>b.textContent?.trim()==='退出');
    if(!btn)return false;btn.click();return true;})()`);
  if (!clicked) return false;
  return Boolean(await cdp.waitFor(`()=>location.pathname==='/login'`, 15000));
}

// ================= PAGED suite (ADR-UX-07, DI-07/WF-10 above the 300-folder threshold) =================
async function pagedSuite(cookie) {
  const stamp = String(Date.now());
  const json = async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method, headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  let chrome = null;
  let cdp = null;
  const tree = await json("GET", "/api/folders/tree");
  const root = (tree.body?.data ?? []).find((f) => !f.parentId);

  // ---- API: children paging + shape ----
  let r = await json("GET", "/api/folders/children?limit=200");
  const roots = r.body?.data ?? {};
  check("children returns visible roots with hints",
    r.status === 200 && Array.isArray(roots.items) && roots.items.length > 0
    && roots.items.every((f) => typeof f.hasChildren === "boolean" && typeof f.canSelect === "boolean" && f.id && f.name),
    JSON.stringify({ n: roots.items.length, first: roots.items[0] }));
  check("children nextCursor empty on the last page", roots.nextCursor === "", String(roots.nextCursor));

  // a known parent with children: the seeded root
  r = await json("GET", `/api/folders/children?parentId=${root.id}&limit=1`);
  const page1 = r.body?.data ?? {};
  check("children honors the limit and returns a cursor",
    r.status === 200 && page1.items.length === 1 && typeof page1.nextCursor === "string" && page1.nextCursor.length > 0,
    JSON.stringify({ n: page1.items.length, cursor: String(page1.nextCursor).slice(0, 12) }));

  // cursor completeness: walk all children of the root, no duplicates
  const seen = new Set();
  let cursor = "";
  let pages = 0;
  for (;;) {
    const q = cursor ? `?parentId=${root.id}&limit=7&cursor=${encodeURIComponent(cursor)}` : `?parentId=${root.id}&limit=7`;
    const res = await json("GET", "/api/folders/children" + q);
    const data = res.body?.data ?? {};
    for (const item of data.items ?? []) {
      if (seen.has(item.id)) {
        check("children cursor walk has no duplicates", false, item.id);
        break;
      }
      seen.add(item.id);
    }
    pages++;
    if (!data.nextCursor) break;
    cursor = data.nextCursor;
    if (pages > 200) { check("children cursor walk terminates", false, "too many pages"); break; }
  }
  const full = await json("GET", `/api/folders/children?parentId=${root.id}&limit=200`);
  check("children cursor walk returns every child exactly once",
    seen.size === (full.body?.data?.items ?? []).length && pages > 1,
    JSON.stringify({ walked: seen.size, full: (full.body?.data?.items ?? []).length, pages }));

  // hidden/missing parity
  const missing = await json("GET", "/api/folders/children?parentId=folder_missing");
  check("children on a missing parent answers 404 E_NOT_FOUND",
    missing.status === 404 && missing.body?.error?.code === "E_NOT_FOUND", JSON.stringify(missing.body));

  // ---- API: search ----
  r = await json("GET", `/api/folders/search?q=${encodeURIComponent(root.name)}&limit=5`);
  const found = r.body?.data ?? {};
  check("search matches by name with a visible path",
    r.status === 200 && (found.items ?? []).some((f) => f.name === root.name && typeof f.path === "string"),
    JSON.stringify((found.items ?? []).slice(0, 2)));
  const blank = await json("GET", "/api/folders/search?q=%20%20");
  check("search rejects a blank query", blank.status === 400 && blank.body?.error?.code === "E_BAD", JSON.stringify(blank.body));

  // ---- UI: seed >300 folders so the tree switches to paged mode ----
  const bigRoot = (await json("POST", "/api/folders", { name: `PG-BIG-${stamp}`, parentId: root.id })).body?.data?.id;
  const TOTAL = 305;
  for (let i = 0; i < TOTAL; i++) {
    await json("POST", "/api/folders", { name: `PG-L${String(i).padStart(4, "0")}-${stamp}`, parentId: bigRoot });
  }
  const mid = (await json("POST", "/api/folders", { name: `PG-MID-${stamp}`, parentId: bigRoot })).body?.data?.id;
  for (let i = 0; i < 3; i++) {
    await json("POST", "/api/folders", { name: `PG-LEAF${i}-${stamp}`, parentId: mid });
  }
  check("fixture subtree seeded", TOTAL + 5 > 300, `children=${TOTAL}`);

  chrome = spawn("/usr/bin/google-chrome", [
    "--headless=new", `--remote-debugging-port=${PORT}`, "--no-sandbox",
    "--disable-gpu", "--window-size=1440,900", "about:blank",
  ], { stdio: "ignore" });
  try {
    await delay(1500);
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = targets.find((t) => t.type === "page");
    cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.bringToFront");
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

    await cdp.navigate(`${BASE}/login`);
    await cdp.evaluate(`(()=>{
      const set=(el,v)=>{const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
      const fields=[...document.querySelectorAll('input')];
      const user=fields.find(f=>f.type==='text'||f.type==='email'||(!f.type&&f.offsetParent!==null));
      const pass=document.querySelector('input[type=password]');
      if(user)set(user,'admin');
      if(pass)set(pass,${JSON.stringify(password)});
      [...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='登录')?.click();return true;})()`);
    await cdp.waitFor(`()=>location.pathname==='/doc'||location.pathname==='/first-sign-in'`);
    await cdp.navigate(`${BASE}/doc?folder=${bigRoot}`);
    const treeReady = await cdp.waitFor(`()=>document.querySelector('ul[role=tree]')!==null&&document.querySelectorAll('li[role=treeitem]').length>0`, 30000);
    check("paged tree renders its first level", Boolean(treeReady), String(treeReady));
    // the fixture root must be visible; expanding it loads its children on demand
    const bigVisible = await cdp.waitFor(`()=>[...document.querySelectorAll('li[role=treeitem]')].some(li=>li.getAttribute('data-folder-id')===${JSON.stringify(bigRoot)})`, 30000);
    check("fixture root reachable in the paged tree", bigVisible === true, String(bigVisible));
    const expanded = await cdp.evaluate(`(()=>{
      const li=document.querySelector('li[data-folder-id="${bigRoot}"]');
      const btn=li?.querySelector('button');
      if(!btn)return 'no-chevron';
      if(li.getAttribute('aria-expanded')!=='true')btn.click();
      return 'clicked';})()`);
    await delay(500);
    const expandedState = await cdp.evaluate(`(()=>document.querySelector('li[data-folder-id="${bigRoot}"]')?.getAttribute('aria-expanded'))()`);
    const firstPage = await cdp.waitFor(`()=>document.querySelectorAll('li[data-folder-id]').length>=100`, 30000);
    check("DI-07 expanding loads the first page of children",
      expanded !== "no-chevron" && expandedState === "true" && firstPage === true,
      `aria-expanded=${expandedState} rows=${await cdp.evaluate(`(()=>document.querySelectorAll('li[data-folder-id]').length)()`)}`);
    // 加载更多 appends the rest
    const moreBtn = await cdp.waitFor(`()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent?.trim()==='加载更多');return b?true:false;}`, 15000);
    check("a truncated level offers 加载更多", moreBtn === true, String(moreBtn));
    if (moreBtn) {
      await cdp.evaluate(`(()=>{[...document.querySelectorAll('button')].find(x=>x.textContent?.trim()==='加载更多')?.click();return true;})()`);
      const allLoaded = await cdp.waitFor(`()=>document.querySelectorAll('li[data-folder-id]').length>=${TOTAL}`, 30000);
      check("加载更多 appends without duplicates",
        allLoaded === true && (await cdp.evaluate(`(()=>{const ids=[...document.querySelectorAll('li[data-folder-id]')].map(li=>li.getAttribute('data-folder-id'));return ids.length===new Set(ids).size;})()`)) === true,
        String(await cdp.evaluate(`(()=>document.querySelectorAll('li[data-folder-id]').length)()`)));
    }
    // tree search finds the fixture and navigates
    const searchBox = await cdp.waitFor(`()=>document.querySelector('.tree-search, input[type=search]')!==null`, 10000);
    check("paged tree exposes a search box", Boolean(searchBox), String(searchBox));
    await cdp.evaluate(`(()=>{
      const input=document.querySelector('.tree-search, input[type=search]');
      const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      set.call(input,${JSON.stringify(`PG-MID-${stamp}`)});
      input.dispatchEvent(new Event('input',{bubbles:true}));
      return true;})()`);
    const searchHit = await cdp.waitFor(`()=>[...document.querySelectorAll('.tree-results a')].some(r=>r.textContent?.includes(${JSON.stringify(`PG-MID-${stamp}`)}))?true:false`, 15000);
    check("DI-07 tree search finds a folder by name", searchHit === true, String(searchHit));
    if (searchHit) {
      await cdp.evaluate(`(()=>{const row=[...document.querySelectorAll('.tree-results a')].find(r=>r.textContent?.includes(${JSON.stringify(`PG-MID-${stamp}`)}));row?.click();return Boolean(row);})()`);
      const navigated = await cdp.waitFor(`()=>location.search.includes(${JSON.stringify(mid)})`, 15000);
      check("selecting a search result navigates to the folder", navigated === true, String(navigated));
    }
  } finally {
    cdp && cdp.close();
    chrome && chrome.kill("SIGKILL");
    // Cleanup is crash-safe: a mid-suite failure must not leak 305 folders into
    // the shared dev tree (the /folders/tree endpoint caps at 500).
    if (bigRoot) {
      const deleted = await json("DELETE", `/api/folders/${bigRoot}`);
      const trashId = deleted.body?.data?.trashId;
      if (deleted.status !== 200 || !trashId) throw Error("PAGED cleanup could not prove ownership of trash ID");
      const purged = await json("DELETE", "/api/trash/" + encodeURIComponent(trashId));
      if (purged.status !== 200) throw Error("PAGED cleanup purge failed");
    }
  }
}

// ================= EDITORS suite (DI-19 / VIS-10) =================
// Third-party editor scoping. DI-19: keyboard operations inside the DOCX
// editor and the CAD viewer must not be intercepted by workspace shortcuts
// (DESKTOP-INTERACTION-v1 §4 scope priority: ONLYOFFICE / CAD viewer outrank
// the explorer and the shell) — asserted by proving the explorer handler is
// live on /doc and that neither editor page even renders the table it is
// bound to. VIS-10: the ONLYOFFICE iframe is a separate document the theme
// cannot reach, and no app CSS rule targets iframe/canvas/webgl.
//
// The suite runs its own Chrome with software-WebGL flags (the shared gate
// Chrome carries no GL flags, so the three.js canvas could not mount there)
// and keeps its fixtures in one folder deleted in its finally block, like
// PAGED. The DOCX and STL fixtures are real byte streams — the office session
// gate and the CAD derivative pipeline inspect the bytes, so a fake payload
// would be dishonest. When ONLYOFFICE or WebGL is unavailable in the target
// environment the affected assertion prints a SKIP line with the page state
// instead of a fake pass.
async function editorsSuite(cookie) {
  const suiteStamp = String(Date.now());
  const json = async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method, headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const tree = await json("GET", "/api/folders/tree");
  const root = (tree.body?.data ?? []).find((f) => !f.parentId);
  const folderId = (await json("POST", "/api/folders", { name: `UX-G4-EDITORS-${suiteStamp}`, parentId: root?.id })).body?.data?.id;
  const upload = async (name, content) => {
    const form = new FormData();
    form.set("folderId", folderId);
    form.set("file", new Blob([content]), name);
    form.set("idempotencyKey", "ux-editors-" + name + "-" + suiteStamp);
    const res = await fetch(`${BASE}/api/files`, { method: "POST", headers: { Cookie: cookie }, body: form });
    return (await res.json()).data;
  };
  let chrome = null;
  let cdp = null;
  try {
    // Two plain files give the /doc baseline a multi-row table; the DOCX and
    // STL are the editor fixtures.
    const plainA = await upload(`e-${suiteStamp}-a.txt`, `explorer a ${suiteStamp}\n`);
    const plainB = await upload(`e-${suiteStamp}-b.txt`, `explorer b ${suiteStamp}\n`);
    const docx = await upload(`e-${suiteStamp}.docx`, minimalDocx(`键盘作用域 ${suiteStamp}`));
    const stl = await upload(`e-${suiteStamp}.stl`, stlTetrahedron());
    check("EDITORS fixtures uploaded (real DOCX package + real STL mesh)",
      Boolean(plainA?.fileId && plainB?.fileId && docx?.fileId && stl?.fileId),
      JSON.stringify({ plainA: plainA?.fileId, plainB: plainB?.fileId, docx: docx?.fileId, stl: stl?.fileId }));
    if (!plainA?.fileId || !plainB?.fileId || !docx?.fileId || !stl?.fileId) return;
    await json("POST", `/api/files/${stl.fileId}/derivative`, {});

    chrome = spawn("/usr/bin/google-chrome", [
      "--headless=new", `--remote-debugging-port=${PORT + 1}`, "--no-sandbox",
      "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
      "--window-size=1440,900", "about:blank",
    ], { stdio: "ignore" });
    await delay(1500);
    const targets = await (await fetch(`http://127.0.0.1:${PORT + 1}/json/list`)).json();
    const page = targets.find((t) => t.type === "page");
    cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Page.bringToFront");
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await cdp.send("Network.setCookie", { name: "fm_session", value: cookie.slice(cookie.indexOf("=") + 1), domain: new URL(BASE).hostname, path: "/" });

    // ---- DI-19 baseline: the explorer handler is live on /doc ----
    await cdp.navigate(`${BASE}/doc?folder=${folderId}`);
    const rows = await cdp.waitFor(`()=>document.querySelectorAll('tbody tr[data-id]').length>=3`, 20000);
    check("DI-19 baseline: fixture rows listed on /doc", Boolean(rows), String(rows));
    if (rows) {
      await cdp.evaluate(`(()=>{const r=[...document.querySelectorAll('tbody tr[data-id]')];r[0]?.click();r[0]?.focus();return true;})()`);
      await cdp.key("ArrowDown", "ArrowDown", 40);
      const moved = await cdp.evaluate(`(()=>{const r=[...document.querySelectorAll('tbody tr[data-id]')];return {focus:r.indexOf(document.activeElement),selected:r.filter(x=>x.getAttribute('aria-selected')==='true').length};})()`);
      check("DI-19 baseline: ArrowDown moves the explorer selection on /doc",
        moved.focus === 1 && moved.selected === 1, JSON.stringify(moved));
    }

    // ---- DI-19 / VIS-10: the DOCX editor page ----
    await cdp.navigate(`${BASE}/office/${docx.fileId}`);
    const shellReady = await cdp.waitFor(`()=>document.querySelector('header.header')!==null&&document.querySelectorAll('header.header').length===1`, 15000);
    const crumbReady = await cdp.waitFor(`()=>{const c=document.querySelector('.breadcrumb');return c&&c.textContent?.includes(${JSON.stringify(`e-${suiteStamp}.docx`)})?c.textContent:false;}`, 15000);
    const office = await cdp.evaluate(`(()=>{
      const links=[...document.querySelectorAll('header.header nav a')].map(a=>a.textContent?.trim());
      const product=document.querySelector('header.header .product')?.textContent?.trim()||'';
      const closeBtn=[...document.querySelectorAll('header.header button')].some(b=>b.textContent?.trim()==='结束编辑');
      const exit=[...document.querySelectorAll('header.header button')].some(b=>b.textContent?.trim()==='退出');
      return {headers:document.querySelectorAll('header.header').length,links,product,closeBtn,exit,
              holder:document.querySelector('#placeholder')!==null,
              loading:[...document.querySelectorAll('.empty')].some(e=>e.textContent?.includes('正在启动文档编辑器')),
              failed:document.querySelectorAll('.notice.error').length,
              iframes:document.querySelectorAll('#placeholder iframe').length,
              tbody:document.querySelectorAll('tbody').length};})()`);
    const navOk = office.links.length === NAV_LABELS.length && NAV_LABELS.every((label, i) => office.links[i] === label);
    check("VIS-09 /office/:id: one shared shell, full nav, own close action",
      shellReady === true && office.headers === 1 && navOk && office.exit === true && office.closeBtn === true && office.product === "文档编辑",
      JSON.stringify(office));
    check("VIS-09 /office/:id: editor container and file context rendered",
      Boolean(crumbReady) && office.holder === true, JSON.stringify({ crumb: crumbReady, holder: office.holder }));
    check("VIS-09 /office/:id: session state surfaced through the shared shell language",
      office.loading === true || office.failed > 0 || office.iframes > 0,
      JSON.stringify({ loading: office.loading, failed: office.failed, iframes: office.iframes }));
    check("DI-19 /office/:id: no explorer table exists to intercept keys", office.tbody === 0, String(office.tbody));
    await cdp.evaluate(`(()=>{if(document.activeElement&&document.activeElement.blur)document.activeElement.blur();return true;})()`);
    await cdp.key("ArrowDown", "ArrowDown", 40);
    await cdp.key("Delete", "Delete", 46);
    await cdp.key("F2", "F2", 113);
    await cdp.key("a", "KeyA", 65, CTRL);
    await delay(300);
    const officeKeys = await cdp.evaluate(`(()=>({path:location.pathname,
      dialogs:[...document.querySelectorAll('dialog.dialog')].filter(d=>d.open).length,
      menus:document.querySelectorAll('[role=menu]').length,
      selected:document.querySelectorAll('[aria-selected="true"]').length,
      rename:document.querySelectorAll('#rename-input').length}))()`);
    check("DI-19 explorer keys inside /office/:id select nothing and open nothing",
      officeKeys.path === `/office/${docx.fileId}` && officeKeys.dialogs === 0 && officeKeys.menus === 0
      && officeKeys.selected === 0 && officeKeys.rename === 0,
      JSON.stringify(officeKeys));

    const frame = await cdp.waitFor(`()=>{
      const f=document.querySelector('#placeholder iframe');
      if(!f)return false;
      return {src:(f.getAttribute('src')||'').slice(0,120),crossOrigin:f.contentDocument===null};}`, 45000);
    if (frame) {
      check("VIS-10 /office/:id: the editor iframe is a separate document", frame.crossOrigin === true, JSON.stringify(frame));
      if (!frame.crossOrigin) {
        const inside = await cdp.evaluate(`(()=>{
          const doc=document.querySelector('#placeholder iframe')?.contentDocument;
          if(!doc)return 'no-document';
          const hits=[];
          for(const sheet of doc.styleSheets){
            let rules;try{rules=sheet.cssRules}catch{continue}
            for(const rule of rules){
              if(rule.selectorText&&/\\.(office-holder|viewer-stage|header)\\b/.test(rule.selectorText))hits.push(rule.selectorText);
            }
          }
          return hits;})()`);
        check("VIS-10 /office/:id: same-origin iframe untouched by the app stylesheet", Array.isArray(inside) && inside.length === 0, JSON.stringify(inside));
      }
    } else {
      const why = await cdp.evaluate(`(()=>({notice:[...document.querySelectorAll('.notice.error,.empty')].map(e=>e.textContent?.trim()).join(' | ').slice(0,200)}))()`);
      console.log(`SKIP VIS-10 docx-iframe :: the ONLYOFFICE iframe did not mount within 45s (document server unreachable or slow boot); page state: ${JSON.stringify(why)}`);
    }
    const themed = await cssThemeHits(cdp);
    check("VIS-10 /office/:id: no app CSS rule targets iframe/canvas/webgl", themed.length === 0, JSON.stringify(themed));

    // CAD files must launch a real viewer inside the ordinary preview workbench.
    await cdp.navigate(`${BASE}/preview/${stl.fileId}`);
    const inlineCad=await cdp.waitFor(`()=>Boolean(document.querySelector('.file-workbench-preview-surface .cad-embedded .cad-viewport'))`,15000);
    const inlineState=await cdp.evaluate(`(()=>({path:location.pathname,
      headers:document.querySelectorAll('header.header').length,
      rail:Boolean(document.querySelector('.file-workbench-sidebar')),
      placeholder:document.body.textContent.includes('模型已就绪，可以打开 3D 查看器'),
      stage:Boolean(document.querySelector('.file-workbench-preview-surface .cad-embedded .cad-viewport'))}))()`);
    check("VIS-10 CAD opens automatically in the file preview workbench",
      inlineCad===true&&inlineState.path===`/preview/${stl.fileId}`&&
      inlineState.headers===1&&inlineState.rail&&inlineState.stage&&!inlineState.placeholder,
      JSON.stringify(inlineState));
    const inlineCanvas=await cdp.waitFor(`()=>{const canvas=document.querySelector('.file-workbench-preview-surface .viewer-stage canvas');
      return canvas&&canvas.width>0&&canvas.height>0?{w:canvas.width,h:canvas.height}:false;}`,45000);
    if(inlineCanvas){
      check("VIS-10 CAD model canvas mounts without a manual click",inlineCanvas.w>0&&inlineCanvas.h>0,JSON.stringify(inlineCanvas));
    }else{
      console.log("SKIP VIS-10 inline CAD canvas :: no usable WebGL canvas within 45s");
    }

    // ---- DI-19 / VIS-10: the CAD model page ----
    await cdp.navigate(`${BASE}/model/${stl.fileId}`);
    const modelShell = await cdp.waitFor(`()=>document.querySelector('header.header')!==null&&document.querySelectorAll('header.header').length===1`, 15000);
    const model = await cdp.evaluate(`(()=>{
      const links=[...document.querySelectorAll('header.header nav a')].map(a=>a.textContent?.trim());
      const back=[...document.querySelectorAll('header.header button')].some(b=>b.textContent?.trim()==='返回文件');
      return {headers:document.querySelectorAll('header.header').length,links,back,tbody:document.querySelectorAll('tbody').length};})()`);
    const modelNavOk = model.links.length === NAV_LABELS.length && NAV_LABELS.every((label, i) => model.links[i] === label);
    check("VIS-09 /model/:id: one shared shell, full nav, own back action",
      modelShell === true && model.headers === 1 && modelNavOk && model.back === true, JSON.stringify(model));
    check("DI-19 /model/:id: no explorer table exists to intercept keys", model.tbody === 0, String(model.tbody));
    await cdp.evaluate(`(()=>{if(document.activeElement&&document.activeElement.blur)document.activeElement.blur();return true;})()`);
    await cdp.key("ArrowDown", "ArrowDown", 40);
    await cdp.key("Delete", "Delete", 46);
    await cdp.key("a", "KeyA", 65, CTRL);
    await delay(300);
    const modelKeys = await cdp.evaluate(`(()=>({path:location.pathname,
      dialogs:[...document.querySelectorAll('dialog.dialog')].filter(d=>d.open).length,
      menus:document.querySelectorAll('[role=menu]').length,
      selected:document.querySelectorAll('[aria-selected="true"]').length}))()`);
    check("DI-19 explorer keys inside /model/:id change nothing",
      modelKeys.path === `/model/${stl.fileId}` && modelKeys.dialogs === 0 && modelKeys.menus === 0 && modelKeys.selected === 0,
      JSON.stringify(modelKeys));

    const canvas = await cdp.waitFor(`()=>{const c=document.querySelector('.viewer-stage canvas');return c?{w:c.width,h:c.height,tabIndex:c.tabIndex}:false;}`, 45000);
    if (canvas) {
      check("VIS-10 /model/:id: the three.js canvas mounts", canvas.w > 0 && canvas.h > 0, JSON.stringify(canvas));
      const controls = await cdp.evaluate(`(()=>{
        const bar=document.querySelector('.toolbar[role=group][aria-label="视图控制"]');
        if(!bar)return null;
        const btns=[...bar.querySelectorAll('button')];
        return {labels:btns.map(b=>b.textContent?.trim()),
                real:btns.every(b=>b.tagName==='BUTTON'&&b.type==='button'),
                reach:btns.map(b=>{b.focus();return document.activeElement===b;}),
                tabIndex:document.querySelector('.viewer-stage canvas').tabIndex};})()`);
      check("VIS-10 /model/:id: viewer controls are real, keyboard-reachable buttons",
        Boolean(controls) && controls.real && controls.labels.length === 4 && controls.labels[0] === "重置视角" && controls.reach.every(Boolean),
        JSON.stringify(controls));
      check("VIS-10 /model/:id: the canvas stays out of the tab order (pointer-driven)",
        controls && controls.tabIndex === -1, String(controls && controls.tabIndex));
      await cdp.evaluate(`(()=>{const bar=document.querySelector('.toolbar[role=group][aria-label="视图控制"]');bar.querySelectorAll('button')[0].focus();return true;})()`);
      await cdp.key("Tab", "Tab", 9);
      const tabbed = await cdp.evaluate(`(()=>{const bar=document.querySelector('.toolbar[role=group][aria-label="视图控制"]');return document.activeElement===bar.querySelectorAll('button')[1];})()`);
      check("DI-19 /model/:id: Tab moves focus along the viewer controls in order", tabbed === true, String(tabbed));
      await cdp.evaluate(`(()=>{const bar=document.querySelector('.toolbar[role=group][aria-label="视图控制"]');const b=bar.querySelectorAll('button');b[b.length-1].focus();return true;})()`);
      await cdp.key("Tab", "Tab", 9);
      const left = await cdp.evaluate(`(()=>{const bar=document.querySelector('.toolbar[role=group][aria-label="视图控制"]');return {inside:bar.contains(document.activeElement),onCanvas:document.activeElement===document.querySelector('.viewer-stage canvas'),active:document.activeElement?document.activeElement.tagName:'none'};})()`);
      check("DI-19 /model/:id: Tab leaves the viewer controls (the canvas is skipped)",
        left.inside === false && left.onCanvas === false, JSON.stringify(left));
    } else {
      const why = await cdp.evaluate(`(()=>({notice:[...document.querySelectorAll('.notice.error,.empty')].map(e=>e.textContent?.trim()).join(' | ').slice(0,200),canvas:document.querySelectorAll('.viewer-stage canvas').length,webgl:(()=>{try{return Boolean(document.createElement('canvas').getContext('webgl'))}catch{return false}})()}))()`);
      console.log(`SKIP VIS-10 cad-canvas :: the three.js canvas did not mount within 45s; page state: ${JSON.stringify(why)}`);
    }
    const modelThemed = await cssThemeHits(cdp);
    check("VIS-10 /model/:id: no app CSS rule targets canvas/webgl", modelThemed.length === 0, JSON.stringify(modelThemed));
  } finally {
    cdp && cdp.close();
    chrome && chrome.kill("SIGKILL");
    // Crash-safe fixture cleanup (PAGED discipline): a mid-suite failure must
    // not leak the folder or its files into the shared dev tree.
    if (folderId) {
      const deleted = await json("DELETE", `/api/folders/${folderId}`);
      const trashId = deleted.body?.data?.trashId;
      if (deleted.status !== 200 || !trashId) throw Error("EDITORS cleanup could not prove ownership of trash ID");
      const purged = await json("DELETE", "/api/trash/" + encodeURIComponent(trashId));
      if (purged.status !== 200) throw Error("EDITORS cleanup purge failed");
    }
  }
}

// Every app stylesheet rule whose selector names an iframe/canvas/webgl
// target. VIS-10 forbids the theme from reaching editor content or the CAD
// canvas; container rules (.office-holder/.viewer-stage style the wrapper
// divs, never the embedded document) do not match these keywords.
async function cssThemeHits(cdp) {
  return cdp.evaluate(`(()=>{
    const hits=[];
    for(const sheet of document.styleSheets){
      let rules;try{rules=sheet.cssRules}catch{continue}
      for(const rule of rules){
        const sel=rule.selectorText;
        if(sel&&/iframe|canvas|webgl/i.test(sel))hits.push(sel);
      }
    }
    return hits;})()`);
}

// A real minimal DOCX container (stored zip, OOXML parts) — the same package
// rb_rollback_e2e.py builds with Python's zipfile, written with the zipStore
// helper mc_multiasset_check.mjs and mod03_meta_check.mjs also carry. The
// office session gate and the editor both inspect real bytes.
function minimalDocx(text) {
  return zipStore([
    ["[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>'],
    ["_rels/.rels",
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>'],
    ["word/document.xml",
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body><w:p><w:r><w:t>' + text + '</w:t></w:r></w:p></w:body></w:document>'],
  ]);
}

// A real ASCII STL tetrahedron with outward facet normals: enough geometry
// for the viewer to mount a scene (4 facets).
function stlTetrahedron() {
  const facets = [
    [[0, 0, -1], [[0, 0, 0], [0, 10, 0], [10, 0, 0]]],
    [[0, -1, 0], [[0, 0, 0], [10, 0, 0], [0, 0, 10]]],
    [[-1, 0, 0], [[0, 0, 0], [0, 0, 10], [0, 10, 0]]],
    [[0.5773502691896258, 0.5773502691896258, 0.5773502691896258], [[10, 0, 0], [0, 10, 0], [0, 0, 10]]],
  ];
  const body = facets.map(([normal, vertices]) =>
    ` facet normal ${normal.join(" ")}\n  outer loop\n` +
    vertices.map((v) => `   vertex ${v.join(" ")}\n`).join("") +
    "  endloop\n endfacet\n").join("");
  return `solid ux-editors\n${body}endsolid ux-editors\n`;
}

function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

// Minimal stored (uncompressed) zip writer: enough for an OOXML package.
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

async function main() {
  // ---- fixtures (one API session, independent of the browser session) ----
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
  const mkFolder = async (name) => (await json("POST", "/api/folders", { parentId: rootId, name })).body?.data?.id;
  const upload = async (folderId, name, content) => {
    const form = new FormData();
    form.set("folderId", folderId);
    form.set("file", new Blob([content]), name);
    form.set("idempotencyKey", "ux-desktop-" + name + "-" + stamp);
    const res = await fetch(`${BASE}/api/files`, { method: "POST", headers: { Cookie: cookie }, body: form });
    return (await res.json()).data;
  };

  // DIALOG suite: two files, one plain text and one binary.
  const dlgFolderId = await mkFolder("UX-G1-DIALOG-" + stamp);
  await upload(dlgFolderId, "g1-plain.txt", `对话框验证 ${stamp}\n`);
  await upload(dlgFolderId, "g1-binary.bin", "binary\x00payload");
  // SHELL suite: one text file so /preview/:id renders.
  const shellFolderId = await mkFolder("UX-G1-SHELL-" + stamp);
  const shellFile = await upload(shellFolderId, "shell.txt", `shell ${stamp}\n`);
  // SELECT suite: exactly eight files for deterministic ranges.
  const selFolderId = await mkFolder("UX-G2-SELECT-" + stamp);
  const selNames = [];
  for (let i = 1; i <= 8; i++) {
    const name = `g2-${String(i).padStart(2, "0")}.txt`;
    selNames.push(name);
    await upload(selFolderId, name, `row ${i} ${stamp}\n`);
  }
  // TREE suite: a three-level subtree under the seeded root.
  const mkTree = async (name, parentId) => (await json("POST", "/api/folders", { name, parentId })).body?.data?.id;
  const pId = await mkTree(`G2树父-${stamp}`, rootId);
  const c1Id = await mkTree(`G2树子一-${stamp}`, pId);
  const c2Id = await mkTree(`G2树子二-${stamp}`, pId);
  const gId = await mkTree(`G2树孙-${stamp}`, c1Id);
  // PW suite (PRECISION-WORKBENCH-V2-SPEC): three files whose extensions pick
  // three different type icons, plus one empty folder for the empty state.
  const pwFolderId = await mkFolder("UX-G4-PW-" + stamp);
  await upload(pwFolderId, "pw-01.txt", `pw text ${stamp}\n`);
  await upload(pwFolderId, "pw-02.png", `pw image ${stamp}\n`);
  await upload(pwFolderId, "pw-03.dat", `pw binary ${stamp}\n`);
  const pwEmptyFolderId = await mkFolder("UX-G4-PW-EMPTY-" + stamp);
  // MENU suite: three files for the context-menu scope rules.
  const menuFolderId = await mkFolder("UX-G3-MENU-" + stamp);
  for (let i = 1; i <= 3; i++) {
    await upload(menuFolderId, `m-${String(i).padStart(2, "0")}.txt`, `menu ${i} ${stamp}\n`);
  }

  const chrome = spawn("/usr/bin/google-chrome", [
    "--headless=new", `--remote-debugging-port=${PORT}`, "--no-sandbox",
    "--disable-gpu", "--window-size=1440,900", "about:blank",
  ], { stdio: "ignore" });

  let cdp = null;
  const runSuite = async (label, fn) => {
    try { await fn(); }
    catch (err) { check(`${label} suite completed`, false, String(err?.message ?? err)); }
  };

  try {
    await delay(1500);
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = targets.find((t) => t.type === "page");
    cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.bringToFront");
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

    // ================= DIALOG suite (g1_dialog_smoke.mjs, 16 checks) =================
    await runSuite("DIALOG", async () => {
      await cdp.navigate(`${BASE}/login`);
      await cdp.waitFor(`()=>!!document.querySelector('input[type=password]')`, 15000);
      const loggedIn = await cdp.login();
      check("login through the UI", Boolean(loggedIn), String(loggedIn));

      await cdp.navigate(`${BASE}/doc?folder=${dlgFolderId}`);
      const rowsReady = await cdp.waitFor(`()=>document.querySelectorAll('.row-actions').length>=2`);
      check("test folder files listed", Boolean(rowsReady), String(rowsReady));

      // ---- rename dialog: real modal, focus inside, trap, escape, focus restore ----
      // Renaming is now owned by the file action Menu (no inline row button).
      const trigger = await cdp.evaluate(`(()=>{
        const row=[...document.querySelectorAll('tbody tr[data-id]')].find(r=>r.textContent?.includes('g1-plain.txt'));
        const btn=row?.querySelector('.more-trigger');
        if(!btn)return 'no row action trigger';
        btn.dataset.triggerMarker='1';btn.focus();btn.click();return true;})()`);
      const menuReady = await cdp.waitFor(`()=>[...document.querySelectorAll('[role="menuitem"]')].some(
        b=>b.querySelector('.menu-label')?.textContent?.trim()==='重命名')`,5000);
      const selectedRename = menuReady && await cdp.evaluate(`(()=>{
        const item=[...document.querySelectorAll('[role="menuitem"]')].find(
          b=>b.querySelector('.menu-label')?.textContent?.trim()==='重命名');
        if(!item)return false;item.click();return true;})()`);
      const opened = Boolean(trigger===true&&menuReady&&selectedRename&&await cdp.waitFor(
        `()=>document.querySelector('dialog.dialog:modal .dialog-title')?.textContent==='重命名文件'`,5000));
      check("rename dialog opened from the row action menu", opened, JSON.stringify({trigger,menuReady,selectedRename}));
      const modal = await cdp.evaluate(`(()=>{
        const d=document.querySelector('dialog.dialog');
        if(!d)return 'no dialog element';
        return {open:d.open,modal:d.matches(':modal'),focusInside:d.contains(document.activeElement),
                title:document.querySelector('.dialog-title')?.textContent||''};})()`);
      check("DI-09 rename dialog is a real modal", modal && modal.open && modal.modal,
        JSON.stringify(modal));
      check("DI-09 focus moved into the dialog", modal && modal.focusInside, JSON.stringify(modal));
      check("dialog exposes its title to a11y", modal && modal.title === "重命名文件", JSON.stringify(modal));
      const inert = await cdp.evaluate(`(()=>{
        const d=document.querySelector('dialog.dialog');
        const outside=document.querySelector('.header button')||document.querySelector('.toolbar button');
        if(!outside)return {ok:false,why:'no background control'};
        outside.focus();
        const a=document.activeElement;
        return {ok:d.contains(a),inside:d.contains(a),tag:a?a.tagName:'none'};})()`);
      check("DI-09 background is inert while modal", inert && inert.ok === true, JSON.stringify(inert));
      await cdp.key("Escape", "Escape", 27);
      await delay(300);
      const restored = await cdp.evaluate(`(()=>{
        const d=document.querySelector('dialog.dialog');
        const active=document.activeElement;
        const marker=document.querySelector('[data-trigger-marker]');
        return {dialogGone:!d||!d.open,backOnTrigger:active?.dataset?.triggerMarker==='1',
                active:active?(active.tagName+'.'+active.className):'none',
                markerExists:Boolean(marker),markerText:marker?marker.textContent?.trim():''};})()`);
      check("DI-09/DI-10 escape closes and focus returns to the trigger",
        restored && restored.dialogGone && restored.backOnTrigger, JSON.stringify(restored));

      // ---- editor dialog: dirty guard, keep editing, escape confirm, discard ----
      await cdp.waitFor(`()=>!document.querySelector('dialog.dialog')?.open`);
      // A click that lands on a node React is about to replace never reaches the
      // delegated root listener, so the open action is retried against a fresh
      // query until the editor dialog actually appears.
      let editOpened = false;
      for (let attempt = 0; attempt < 5 && !editOpened; attempt++) {
        editOpened = await cdp.evaluate(`(()=>{
          const rows=[...document.querySelectorAll('.row-actions')];
          const row=rows.find(r=>r.closest('tr')?.textContent?.includes('g1-plain.txt'));
          const btn=[...row.querySelectorAll('button')].find(b=>b.textContent?.trim()==='编辑');
          if(!btn)return false;
          btn.dataset.triggerMarker='1';
          btn.focus();btn.click();return true;})()`);
        if (editOpened) {
          editOpened = await cdp.waitFor(`()=>[...document.querySelectorAll('dialog.dialog')].some(d=>d.open&&d.textContent?.includes('编辑 g1-plain.txt'))`, 4000);
        }
        if (!editOpened) await delay(400);
      }
      check("editor dialog opened", editOpened === true, String(editOpened));
      const editorReady = await cdp.waitFor(`()=>document.querySelector('dialog.dialog textarea#editor-content')!==null`);
      check("editor content loaded", Boolean(editorReady), String(editorReady));
      if (!editorReady) {
        const dump = await cdp.evaluate(`(()=>{
          const dialogs=[...document.querySelectorAll('dialog.dialog')].map(d=>({open:d.open,title:d.querySelector('.dialog-title')?.textContent,text:(d.textContent||'').slice(0,200),hasTextarea:Boolean(d.querySelector('textarea'))}));
          const editingRow=[...document.querySelectorAll('.row-actions')].some(r=>r.closest('tr')?.textContent?.includes('g1-plain.txt'));
          return {dialogs,editingRow,path:location.pathname,rows:document.querySelectorAll('tbody tr[data-id]').length};})()`);
        console.log("EDITOR_DUMP " + JSON.stringify(dump));
      }
      const typed = await cdp.evaluate(`(()=>{
        const ta=document.querySelector('dialog.dialog textarea#editor-content');
        const s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
        s.call(ta,ta.value+'\\n编辑追加一行');
        ta.dispatchEvent(new Event('input',{bubbles:true}));
        return ta.value.includes('编辑追加一行');})()`);
      check("editor accepts typing", typed === true, String(typed));
      const asked = await cdp.evaluate(`(()=>{
        const btn=[...document.querySelectorAll('dialog.dialog button')].find(b=>b.textContent?.trim()==='关闭');
        btn?.click();return true;})()`);
      await delay(250);
      const confirmShown = await cdp.evaluate(`(()=>[...document.querySelectorAll('dialog.dialog p')].some(p=>p.textContent?.includes('有未保存的修改')))()`);
      check("DI-10 dirty close asks first", asked === true && confirmShown === true, String(confirmShown));
      const kept = await cdp.evaluate(`(()=>{
        const btn=[...document.querySelectorAll('dialog.dialog button')].find(b=>b.textContent?.trim()==='继续编辑');
        btn?.click();
        const ta=document.querySelector('dialog.dialog textarea#editor-content');
        const d=document.querySelector('dialog.dialog');
        return d.open&&ta.value.includes('编辑追加一行');})()`);
      check("keep editing preserves the draft", kept === true, String(kept));
      await cdp.key("Escape", "Escape", 27);
      await delay(250);
      const confirmAgain = await cdp.evaluate(`(()=>[...document.querySelectorAll('dialog.dialog p')].some(p=>p.textContent?.includes('有未保存的修改')))()`);
      check("escape re-asks with a dirty draft", confirmAgain === true, String(confirmAgain));
      const discarded = await cdp.evaluate(`(()=>{
        const btn=[...document.querySelectorAll('dialog.dialog button')].find(b=>b.textContent?.trim()==='放弃修改');
        btn?.click();return true;})()`);
      await delay(300);
      const closed = await cdp.evaluate(`(()=>{
        const d=document.querySelector('dialog.dialog');
        const active=document.activeElement;
        return {gone:!d||!d.open,backOnTrigger:active?.dataset?.triggerMarker==='1'};})()`);
      check("discard closes and restores focus to the trigger",
        discarded === true && closed && closed.gone && closed.backOnTrigger, JSON.stringify(closed));

      // ---- binary file: safe editor gate blocks with a reason ----
      const binOpened = await cdp.evaluate(`(()=>{
        const rows=[...document.querySelectorAll('.row-actions')];
        const row=rows.find(r=>r.closest('tr')?.textContent?.includes('g1-binary.bin'));
        const btn=[...row.querySelectorAll('button')].find(b=>b.textContent?.trim()==='编辑');
        if(!btn)return 'no edit button';
        btn.click();return true;})()`);
      const blocked = await cdp.waitFor(`()=>{
        const d=document.querySelector('dialog.dialog');
        if(!d||!d.open)return false;
        const reason=[...d.querySelectorAll('p')].some(p=>p.textContent?.includes('不是可识别的纯文本'));
        const submit=[...d.querySelectorAll('button')].some(b=>b.textContent?.trim()==='保存新版本'||b.textContent?.trim()==='提交审批');
        return reason&&!submit;}`);
      check("SAFE-01 binary file cannot be edited", binOpened === true && Boolean(blocked),
        `opened=${binOpened} blocked=${blocked}`);
    });

    // ================= SHELL suite (g1_shell_smoke.mjs, 19 checks) =================
    await runSuite("SHELL", async () => {
      const loggedOut = await logoutThroughUi(cdp);
      await cdp.navigate(`${BASE}/login`);
      await cdp.waitFor(`()=>!!document.querySelector('input[type=password]')`, 15000);
      const loggedIn = await cdp.login();
      check("login through the UI", Boolean(loggedOut && loggedIn), `loggedOut=${loggedOut} loggedIn=${Boolean(loggedIn)}`);

      const routes = [
        { path: "/doc", active: "文档管理" },
        { path: "/search", active: "全局搜索" },
        { path: "/workspace", active: "共享/关注" },
        { path: "/stats", active: "统计" },
        { path: "/approvals", active: "审批" },
        { path: "/trash", active: "回收站" },
        { path: "/org", active: "组织与权限" },
        { path: `/preview/${shellFile.fileId}`, active: null },
      ];
      for (const route of routes) {
        await cdp.navigate(BASE + route.path);
        const ready = await cdp.waitFor(`()=>document.querySelector('header.header')!==null&&document.querySelectorAll('header.header').length===1`, 15000);
        const state = await cdp.evaluate(`(()=>{
          const headers=document.querySelectorAll('header.header').length;
          const links=[...document.querySelectorAll('header.header nav a')].map(a=>a.textContent?.trim());
          const active=[...document.querySelectorAll('header.header nav a.active')].map(a=>a.textContent?.trim());
          const brand=document.querySelector('header.header .brand')?.textContent?.includes('中晟生物科技');
          const account=document.querySelector('header.header .account')?.textContent?.trim()||'';
          const exit=[...document.querySelectorAll('header.header button')].some(b=>b.textContent?.trim()==='退出');
          const logoImg=document.querySelector('header.header .brand img.brand-logo');
          const logo=logoImg!==null&&logoImg.naturalWidth>0&&logoImg.getBoundingClientRect().width>0;
          return {headers,links,active,brand,account,exit,logo};})()`);
        const navOk = state && state.links.length === NAV_LABELS.length &&
          NAV_LABELS.every((label, i) => state.links[i] === label);
        check(`VIS-09 ${route.path}: single shell, full nav, client-side links`,
          ready === true && state.headers === 1 && navOk &&
          state.brand === true && state.exit === true && state.logo === true,
          JSON.stringify(state));
        check(`VIS-09 ${route.path}: current page marked in nav`,
          route.active === null ? state && state.active.length === 0
            : state && state.active.length === 1 && state.active[0] === route.active,
          JSON.stringify(state.active));
      }

      // identity is the session user everywhere (no page-private account slot)
      const identity = await cdp.evaluate(`(()=>document.querySelector('header.header .account')?.textContent?.trim()||'')()`);
      check("VIS-09 identity slot shows the session user", identity.length > 0, identity);

      // nav click stays client-side (no document reload)
      const clientSide = await cdp.evaluate(`(()=>{
        const before=performance.now();
        const link=[...document.querySelectorAll('header.header nav a')].find(a=>a.textContent?.trim()==='回收站');
        link?.click();return true;})()`);
      await cdp.waitFor(`()=>location.pathname==='/trash'`, 10000);
      const afterNav = await cdp.evaluate(`(()=>({path:location.pathname,headers:document.querySelectorAll('header.header').length}))()`);
      check("VIS-09 nav navigates without a full reload", clientSide === true && afterNav.path === "/trash" && afterNav.headers === 1, JSON.stringify(afterNav));
    });

    // ================= SELECT suite (g2_select_smoke.mjs, 21 checks) =================
    await runSuite("SELECT", async () => {
      await cdp.navigate(`${BASE}/doc?folder=${selFolderId}`);
      const rowsReady = await cdp.waitFor(`()=>document.querySelectorAll('tbody tr[data-id]').length>=8`);
      check("test rows listed", Boolean(rowsReady), String(rowsReady));
      await cdp.evaluate(`(()=>{const s=document.querySelector('select[aria-label="排序方式"]');const set=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;set.call(s,'name_asc');s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
      await cdp.waitFor(`()=>document.querySelectorAll('tbody tr[data-id]').length>=8`);
      await delay(400);
      const order = await cdp.evaluate(`(()=>[...document.querySelectorAll('tbody tr[data-id]')].map(r=>r.querySelector('.file-name')?.textContent))()`);
      check("deterministic visible order established",
        Array.isArray(order) && order.length === 8 && order[0] === selNames[0] && order[7] === selNames[7],
        JSON.stringify(order));

      const selectedNames = () => cdp.evaluate(`(()=>[...document.querySelectorAll('tbody tr[data-id]')].filter(r=>r.getAttribute('aria-selected')==='true').map(r=>r.querySelector('.file-name')?.textContent))()`);
      const rowCount = () => cdp.evaluate(`(()=>document.querySelectorAll('tbody tr[data-id]').length)()`);
      const clickRow = (i) => cdp.evaluate(`(()=>{const rows=[...document.querySelectorAll('tbody tr[data-id]')];rows[${i}]?.click();return true;})()`);
      const ctrlClickRow = (i) => cdp.evaluate(`(()=>{const rows=[...document.querySelectorAll('tbody tr[data-id]')];rows[${i}]?.dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}));return true;})()`);
      const shiftClickRow = (i) => cdp.evaluate(`(()=>{const rows=[...document.querySelectorAll('tbody tr[data-id]')];rows[${i}]?.dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:true}));return true;})()`);
      const focusRow = (i) => cdp.evaluate(`(()=>{const rows=[...document.querySelectorAll('tbody tr[data-id]')];rows[${i}]?.focus();return document.activeElement===rows[${i}];})()`);

      // DI-01: single click selects and never navigates
      await clickRow(0);
      let sel = await selectedNames();
      const pathAfterClick = await cdp.evaluate(`(()=>location.pathname)()`);
      check("DI-01 single click selects without navigating",
        sel.length === 1 && sel[0] === order[0] && pathAfterClick === "/doc", JSON.stringify({ sel, pathAfterClick }));

      // DI-03: ctrl toggles membership
      await ctrlClickRow(2);
      await ctrlClickRow(4);
      sel = await selectedNames();
      check("DI-03 ctrl+click extends the selection",
        sel.length === 3 && sel.includes(order[2]) && sel.includes(order[4]), JSON.stringify(sel));
      await ctrlClickRow(2);
      sel = await selectedNames();
      check("DI-03 ctrl+click on a selected row removes it",
        sel.length === 2 && !sel.includes(order[2]), JSON.stringify(sel));

      // DI-04: shift ranges over the visible order, then a re-sort clears it
      await clickRow(0);
      await shiftClickRow(5);
      sel = await selectedNames();
      check("DI-04 shift+click selects the visible range",
        sel.length === 6 && sel[0] === order[0] && sel[5] === order[5], JSON.stringify(sel));
      await cdp.evaluate(`(()=>{const s=document.querySelector('select[aria-label="排序方式"]');const set=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;set.call(s,'size_desc');s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
      await delay(600);
      sel = await selectedNames();
      check("DI-04 re-sort clears the stale selection", sel.length === 0, JSON.stringify(sel));
      await cdp.evaluate(`(()=>{const s=document.querySelector('select[aria-label="排序方式"]');const set=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;set.call(s,'name_asc');s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
      await cdp.waitFor(`()=>document.querySelectorAll('tbody tr[data-id]').length>=8`);
      await delay(400);
      await clickRow(0);
      await focusRow(0);
      await cdp.key("ArrowDown", "ArrowDown", 40);
      sel = await selectedNames();
      const focusedName = await cdp.evaluate(`(()=>document.activeElement?.querySelector('.file-name')?.textContent)()`);
      check("DI-06 ArrowDown moves focus and selects",
        sel.length === 1 && focusedName === order[1], JSON.stringify({ sel, focusedName }));
      await cdp.key(" ", "Space", 32);
      sel = await selectedNames();
      check("DI-06 Space toggles the focused row off", sel.length === 0, JSON.stringify(sel));
      await cdp.key("End", "End", 35);
      sel = await selectedNames();
      check("DI-06 End focuses the last row", sel.length === 1 && sel[0] === order[7], JSON.stringify(sel));
      await cdp.key("Home", "Home", 36);
      sel = await selectedNames();
      check("DI-06 Home focuses the first row", sel.length === 1 && sel[0] === order[0], JSON.stringify(sel));

      // DI-08: Ctrl+A selects only the loaded page
      await cdp.key("a", "KeyA", 65, CTRL);
      sel = await selectedNames();
      const total = await rowCount();
      check("DI-08 Ctrl+A selects the loaded page", sel.length === total && total === 8, `selected=${sel.length} rows=${total}`);
      const bar = await cdp.evaluate(`(()=>document.querySelector('footer.status-bar')?.textContent||'')()`);
      check("DI-08 status bar reports the loaded-page scope", bar.includes("已选 8 项") && bar.includes("共 8 个文件"), bar);

      // DI-07: F2 rename scope; Delete inside the input must not delete the file
      await cdp.key("Escape", "Escape", 27);
      await clickRow(0);
      await cdp.key("F2", "F2", 113);
      const renameOpen = await cdp.evaluate(`(()=>{const d=document.querySelector('dialog.dialog');return Boolean(d?.open)&&document.querySelector('#rename-input')?.value===${JSON.stringify(order[0])};})()`);
      check("DI-07 F2 opens rename for the single selection", renameOpen === true, String(renameOpen));
      const typed = await cdp.evaluate(`(()=>{const input=document.querySelector('#rename-input');input.focus();const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;set.call(input,input.value+'-x');input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
      await cdp.key("Delete", "Delete", 46);
      await delay(300);
      const deleteDialogLeak = await cdp.evaluate(`(()=>[...document.querySelectorAll('dialog.dialog')].some(d=>d.open&&d.textContent?.includes('删除确认')))()`);
      check("DI-05/DI-07 Delete inside the input does not reach the explorer",
        typed === true && deleteDialogLeak === false, String(deleteDialogLeak));
      await cdp.key("Escape", "Escape", 27);
      await delay(300);
      const renameClosed = await cdp.evaluate(`(()=>!document.querySelector('#rename-input'))()`);
      check("rename dialog closes on Escape", renameClosed === true, String(renameClosed));

      // Delete opens the confirmation with the impact list
      sel = await selectedNames();
      check("single selection still focused for the delete key", sel.length === 1 && sel[0] === order[0], JSON.stringify(sel));
      await focusRow(0);
      await cdp.key("Delete", "Delete", 46);
      const deleteReady = await cdp.waitFor(`()=>[...document.querySelectorAll('dialog.dialog')].some(d=>d.open&&d.textContent?.includes('删除确认'))`);
      check("delete confirmation dialog opened", Boolean(deleteReady), String(deleteReady));
      const deleteDialog = await cdp.evaluate(`(()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.textContent?.includes('删除确认'));return d?{open:d.open,lists:d.querySelectorAll('.delete-list li').length,text:d.textContent?.includes(${JSON.stringify(order[0])})}:null;})()`);
      check("DI-07 Delete opens the confirmation with the impact list",
        sel.length === 1 && deleteDialog && deleteDialog.open && deleteDialog.lists >= 1 && deleteDialog.text,
        JSON.stringify(deleteDialog));
      await cdp.evaluate(`(()=>{[...document.querySelectorAll('dialog.dialog button')].find(b=>b.textContent?.trim()==='取消')?.click();return true;})()`);
      await delay(300);

      // Row action buttons must not disturb the selection (stopPropagation)
      await ctrlClickRow(3);
      sel = await selectedNames();
      await cdp.evaluate(`(()=>{const rows=[...document.querySelectorAll('tbody tr[data-id]')];const row=rows.find(r=>r.querySelector('.file-name')?.textContent===${JSON.stringify(selNames[3])});const edit=[...row.querySelectorAll('.row-actions button')].find(b=>b.textContent?.trim()==='编辑');edit?.click();return Boolean(edit);})()`);
      await delay(400);
      const editorOpen = await cdp.evaluate(`(()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.textContent?.includes('编辑'));return Boolean(d?.open);})()`);
      const selAfterAction = await selectedNames();
      check("row action buttons do not change the selection",
        sel.length === 2 && editorOpen === true && selAfterAction.length === 2, JSON.stringify({ sel, selAfterAction, editorOpen }));
      await cdp.key("Escape", "Escape", 27);
      await delay(300);

      // DI-02: double click opens exactly once
      await cdp.evaluate(`(()=>{const rows=[...document.querySelectorAll('tbody tr[data-id]')];const row=rows.find(r=>r.querySelector('.file-name')?.textContent===${JSON.stringify(selNames[2])});row?.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));return true;})()`);
      await cdp.waitFor(`()=>location.pathname.startsWith('/preview/')`, 10000);
      const previewState = await cdp.evaluate(`(()=>({path:location.pathname,headers:document.querySelectorAll('header.header').length}))()`);
      check("DI-02 double click opens the preview once", previewState.path.startsWith("/preview/") && previewState.headers === 1, JSON.stringify(previewState));
    });

    // ================= TREE suite (g2_tree_smoke.mjs, 21 checks) =================
    await runSuite("TREE", async () => {
      check("subtree created", Boolean(pId && c1Id && c2Id && gId), JSON.stringify({ pId, c1Id, c2Id, gId }));

      await cdp.navigate(`${BASE}/doc?folder=${pId}`);
      const treeReady = await cdp.waitFor(`()=>document.querySelector('ul[role=tree]')!==null&&document.querySelector('li[data-folder-id="${pId}"]')!==null`);
      check("tree rendered with ARIA roles", Boolean(treeReady), String(treeReady));

      const treeState = () => cdp.evaluate(`(()=>{
        const item=(id)=>document.querySelector('li[data-folder-id="'+id+'"]');
        const state=(id)=>{const li=item(id);if(!li)return null;return {expanded:li.getAttribute('aria-expanded'),current:li.getAttribute('aria-current'),tabIndex:li.tabIndex};};
        return {
          parent:state(${JSON.stringify(pId)}),
          c1:state(${JSON.stringify(c1Id)}),
          c2:state(${JSON.stringify(c2Id)}),
          gVisible:Boolean(item(${JSON.stringify(gId)})),
          roles:{tree:document.querySelectorAll('ul[role=tree]').length,groups:document.querySelectorAll('ul[role=group]').length},
        };})()`);

      let state = await treeState();
      check("DI-12 selected folder marked with aria-current",
        state && state.parent && state.parent.current === "page", JSON.stringify(state.parent));
      check("DI-12 collapsed parent reports aria-expanded=false",
        state && state.parent && state.parent.expanded === "false", JSON.stringify(state.parent));
      check("grandchild hidden until the parent expands", state && state.gVisible === false, JSON.stringify(state));

      // DI-12: chevron expands without navigating; the name navigates
      const chevronNav = await cdp.evaluate(`(()=>{
        const before=location.pathname+location.search;
        const li=document.querySelector('li[data-folder-id="${pId}"]');
        const btn=li.querySelector('button');
        btn.click();
        return {before,after:location.pathname+location.search};})()`);
      await cdp.waitFor(`()=>document.querySelector('li[data-folder-id="${c1Id}"]')!==null`);
      check("DI-12 chevron expands without navigating",
        chevronNav.before === chevronNav.after && chevronNav.after.includes(pId), JSON.stringify(chevronNav));
      state = await treeState();
      check("DI-12 expanded parent reports aria-expanded=true",
        state && state.parent && state.parent.expanded === "true", JSON.stringify(state.parent));
      const nameNav = await cdp.evaluate(`(()=>{
        const li=document.querySelector('li[data-folder-id="${c1Id}"]');
        li.querySelector('a').click();return true;})()`);
      await cdp.waitFor(`()=>location.search.includes('${c1Id}')`, 10000);
      check("DI-12 clicking the node name navigates", nameNav === true && (await cdp.evaluate(`(()=>location.search.includes(${JSON.stringify(c1Id)}))()`)) === true,
        await cdp.evaluate(`(()=>location.pathname+location.search)()`));

      // DI-13: keyboard roaming over the flattened visible order
      await cdp.navigate(`${BASE}/doc?folder=${pId}`);
      await cdp.waitFor(`()=>document.querySelector('li[data-folder-id="${pId}"]')!==null`);
      const focusItem = (id) => cdp.evaluate(`(()=>{const li=document.querySelector('li[data-folder-id="${id}"]');li?.focus();return document.activeElement===li;})()`);
      const activeId = () => cdp.evaluate(`(()=>document.activeElement?.getAttribute?.('data-folder-id')||null)()`);
      const visibleIds = () => cdp.evaluate(`(()=>[...document.querySelectorAll('li[role=treeitem]')].map(li=>li.getAttribute('data-folder-id')))()`);
      const expandedOf = (id) => cdp.evaluate(`(()=>document.querySelector('li[data-folder-id="${id}"]')?.getAttribute('aria-expanded'))()`);

      // expand the parent so its children join the visible order
      await cdp.evaluate(`(()=>{const li=document.querySelector('li[data-folder-id="${pId}"]');li.querySelector('button').click();return true;})()`);
      await cdp.waitFor(`()=>document.querySelector('li[data-folder-id="${c1Id}"]')!==null`);
      let vis = await visibleIds();
      check("children join the visible order after expanding", vis.includes(c1Id) && vis.includes(c2Id), JSON.stringify(vis.slice(0, 6)));

      await focusItem(pId);
      await cdp.key("ArrowDown", "ArrowDown", 40);
      check("DI-13 ArrowDown moves focus to the next visible node",
        (await activeId()) === vis[vis.indexOf(pId) + 1], `${await activeId()} expected=${vis[vis.indexOf(pId) + 1]}`);

      await focusItem(c1Id);
      await cdp.key("ArrowRight", "ArrowRight", 39);
      await cdp.waitFor(`()=>document.querySelector('li[data-folder-id="${gId}"]')!==null`);
      check("DI-13 ArrowRight expands a collapsed parent", (await expandedOf(c1Id)) === "true", await expandedOf(c1Id));
      await cdp.key("ArrowDown", "ArrowDown", 40);
      check("DI-13 ArrowDown steps into the first child", (await activeId()) === gId, await activeId());
      await cdp.key("ArrowLeft", "ArrowLeft", 37);
      check("DI-13 ArrowLeft on a leaf moves to the parent", (await activeId()) === c1Id, await activeId());
      check("DI-13 ArrowLeft on a leaf does not collapse the parent", (await expandedOf(c1Id)) === "true", await expandedOf(c1Id));
      await cdp.key("ArrowLeft", "ArrowLeft", 37);
      check("DI-13 ArrowLeft on an expanded parent collapses it", (await expandedOf(c1Id)) === "false", await expandedOf(c1Id));
      check("DI-13 collapsing hides the subtree",
        (await cdp.evaluate(`(()=>!document.querySelector('li[data-folder-id="${gId}"]'))()`)) === true, "grandchild gone");

      vis = await visibleIds();
      await cdp.key("End", "End", 35);
      check("DI-13 End moves focus to the last visible node", (await activeId()) === vis[vis.length - 1],
        `${await activeId()} expected=${vis[vis.length - 1]}`);
      await cdp.key("Home", "Home", 36);
      check("DI-13 Home moves focus to the first visible node", (await activeId()) === vis[0],
        `${await activeId()} expected=${vis[0]}`);
      await focusItem(pId);
      await cdp.key("Enter", "Enter", 13);
      await cdp.waitFor(`()=>location.search.includes('${pId}')`, 10000);
      check("DI-13 Enter navigates to the focused folder",
        (await cdp.evaluate(`(()=>location.search.includes(${JSON.stringify(pId)}))()`)) === true,
        await cdp.evaluate(`(()=>location.pathname+location.search)()`));

      // DI-15: the breadcrumb walks real visible ancestors
      await cdp.navigate(`${BASE}/doc?folder=${gId}`);
      const crumb = await cdp.waitFor(`()=>{const nav=document.querySelector('nav.breadcrumb');return nav&&nav.textContent?.includes(${JSON.stringify(`G2树孙-${stamp}`)})?nav.textContent:false;}`);
      check("DI-15 breadcrumb shows the full visible ancestor chain",
        Boolean(crumb) && crumb.includes(`G2树父-${stamp}`) && crumb.includes(`G2树子一-${stamp}`) && crumb.includes(`G2树孙-${stamp}`),
        String(crumb));
      const crumbNav = await cdp.evaluate(`(()=>{
        const nav=document.querySelector('nav.breadcrumb');
        const link=[...nav.querySelectorAll('a')].find(a=>a.textContent?.includes(${JSON.stringify(`G2树父-${stamp}`)}));
        link?.click();return Boolean(link);})()`);
      await cdp.waitFor(`()=>location.search.includes('${pId}')`, 10000);
      check("DI-15 breadcrumb ancestor link navigates", crumbNav === true,
        await cdp.evaluate(`(()=>location.pathname+location.search)()`));
    });

    // ================= MENU suite (g3_menu_smoke.mjs, 12 checks) =================
    await runSuite("PAGED", () => pagedSuite(cookie));
    await runSuite("MENU", async () => {
      await cdp.navigate(`${BASE}/doc?folder=${menuFolderId}`);
      const rowsReady = await cdp.waitFor(`()=>document.querySelectorAll('tbody tr[data-id]').length>=3`);
      check("test rows listed", Boolean(rowsReady), String(rowsReady));

      const selectedNames = () => cdp.evaluate(`(()=>[...document.querySelectorAll('tbody tr[data-id]')].filter(r=>r.getAttribute('aria-selected')==='true').map(r=>r.querySelector('.file-name')?.textContent))()`);
      const menuLabels = () => cdp.evaluate(`(()=>{const m=document.querySelector('[role=menu]');return m?[...m.querySelectorAll('[role=menuitem]')].map(b=>b.textContent?.replace(/\\s+/g,' ').trim()):null;})()`);

      // DI-03: ctrl+click two rows, then right-click a selected row keeps the selection
      await cdp.evaluate(`(()=>{const rows=[...document.querySelectorAll('tbody tr[data-id]')];rows[0]?.click();return true;})()`);
      await cdp.evaluate(`(()=>{const rows=[...document.querySelectorAll('tbody tr[data-id]')];rows[1]?.dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}));return true;})()`);
      let sel = await selectedNames();
      check("DI-03 two rows selected", sel.length === 2, JSON.stringify(sel));
      await cdp.evaluate(`(()=>{const rows=[...document.querySelectorAll('tbody tr[data-id]')];rows[1]?.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:100}));return true;})()`);
      const menuForSelection = await cdp.waitFor(`()=>document.querySelector('[role=menu]')!==null`, 5000);
      const labels = await menuLabels();
      sel = await selectedNames();
      check("DI-05 right-click on a selected row keeps the whole selection",
        menuForSelection === true && sel.length === 2, JSON.stringify({ sel, labels }));
      check("DI-03/WF-11 multi-selection menu only offers set-wide actions",
        Array.isArray(labels) && labels.length === 2
        && labels.some((l) => l.startsWith("移动到…")) && labels.some((l) => l.startsWith("删除"))
        && !labels.some((l) => /^(打开|编辑|重命名|下载)/.test(l)), JSON.stringify(labels));

      // DI-05: right-click an unselected row makes it the single selection
      await cdp.key("Escape", "Escape", 27);
      await delay(250);
      await cdp.evaluate(`(()=>{const rows=[...document.querySelectorAll('tbody tr[data-id]')];rows[2]?.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:120,clientY:140}));return true;})()`);
      await delay(300);
      sel = await selectedNames();
      const labels2 = await menuLabels();
      check("DI-05 right-click on an unselected row becomes a single selection",
        sel.length === 1 && Array.isArray(labels2) && labels2.length === 6
        && labels2.every(l => /打开|编辑|重命名|移动到…|下载|删除/.test(l)), JSON.stringify({ sel, labels2 }));

      // menu keyboard: Escape closes and focus returns to the row
      await cdp.key("Escape", "Escape", 27);
      await delay(300);
      const closed = await cdp.evaluate(`(()=>({menuGone:!document.querySelector('[role=menu]'),active:document.activeElement?.getAttribute?.('data-id')||document.activeElement?.tagName}))()`);
      check("DI-10 menu Escape closes without leaking focus", closed.menuGone === true, JSON.stringify(closed));

      // keyboard menu entry: Shift+F10 on the focused row
      await cdp.evaluate(`(()=>{const rows=[...document.querySelectorAll('tbody tr[data-id]')];rows[0]?.focus();return true;})()`);
      await cdp.key("F10", "F10", 121, SHIFT);
      const kbMenu = await cdp.waitFor(`()=>document.querySelector('[role=menu]')!==null`, 5000);
      check("DI-05 Shift+F10 opens the row menu", kbMenu === true, String(kbMenu));
      await cdp.key("Escape", "Escape", 27);
      await delay(250);

      // tree node menu: rename reuses the FolderActions dialog for that folder
      await cdp.evaluate(`(()=>{const li=document.querySelector('li[data-folder-id="${menuFolderId}"]');li?.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:80,clientY:300}));return Boolean(li);})()`);
      const treeMenu = await cdp.waitFor(`()=>document.querySelector('[role=menu]')!==null`, 5000);
      const treeLabels = await cdp.evaluate(`(()=>{const m=document.querySelector('[role=menu]');return m?[...m.querySelectorAll('[role=menuitem]')].map(b=>b.textContent?.trim()):null;})()`);
      check("tree node menu opens with admin entries",
        treeMenu === true && Array.isArray(treeLabels) && treeLabels.includes("重命名目录") && treeLabels.includes("授权管理") && !treeLabels.includes("审批策略") && treeLabels.includes("删除目录"),
        JSON.stringify(treeLabels));
      await cdp.evaluate(`(()=>{const item=[...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent?.trim()==='重命名目录');item?.click();return Boolean(item);})()`);
      const renameOpen = await cdp.waitFor(`()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.textContent?.includes('重命名目录'));return d?d.querySelector('input')?.value===false?false:Boolean(d):false;}`, 6000);
      const renameValue = await cdp.evaluate(`(()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.textContent?.includes('重命名目录'));return d?d.querySelector('input')?.value:null;})()`);
      check("tree menu rename opens the folder rename dialog for that folder",
        renameOpen === true && renameValue === `UX-G3-MENU-${stamp}`, String(renameValue));
      await cdp.key("Escape", "Escape", 27);
      await delay(300);


      // Quick direct grants must stay on /doc, use the modal top layer,
      // and never silently replace full organization permission management.
      const grantsBefore=await cdp.evaluate('location.pathname+location.search');
      await cdp.evaluate(`(()=>{const button=[...document.querySelectorAll('.folder-actions button')].find(x=>x.textContent?.trim()==='授权管理');button?.click();return !!button;})()`);
      const quickOpen=await cdp.waitFor(`()=>!!document.querySelector('dialog.quick-grants-dialog[open] .quick-grants-form')`,6000);
      const quickGeometry=await cdp.evaluate(`(()=>{
        const d=document.querySelector('dialog.quick-grants-dialog[open]');
        if(!d)return null;
        const r=d.getBoundingClientRect();
        return {width:r.width,viewport:innerWidth,checkboxes:d.querySelectorAll('.quick-grants-actions-grid input[type=checkbox]').length,
          noRouteChange:location.pathname+location.search===${JSON.stringify(grantsBefore)},
          readOnlyAtOpen:!d.querySelector('.quick-grants-review')};
      })()`);
      check("directory authorization opens a bounded quick modal without navigation",
        quickOpen===true&&quickGeometry?.checkboxes===9&&quickGeometry?.width<=quickGeometry?.viewport
        &&quickGeometry?.noRouteChange&&quickGeometry?.readOnlyAtOpen,JSON.stringify(quickGeometry));
      await cdp.evaluate(`(()=>{const btn=document.querySelector('.quick-grants-fields .rare-select');btn?.click();return !!btn;})()`);
      const grantSelect=await cdp.waitFor(`()=>!!document.querySelector('dialog.quick-grants-dialog .rare-select-menu')`,3000);
      check("quick authorization RareSelect stays inside modal top layer",grantSelect===true,String(grantSelect));
      await cdp.evaluate(`(()=>{document.querySelector('dialog.quick-grants-dialog .dialog-close')?.click();return true;})()`);
      const grantsClosed=await cdp.waitFor(`()=>!document.querySelector('dialog.quick-grants-dialog[open]')`,3500);
      check("closing quick authorization preserves document location",grantsClosed===true
        &&await cdp.evaluate(`location.pathname+location.search===${JSON.stringify(grantsBefore)}`),String(grantsClosed));
      // DI-17: synthetic drop with a real DataTransfer uploads into the folder
      const dropped = await cdp.evaluate(`(async ()=>{
        const dt=new DataTransfer();
        dt.items.add(new File(['dropped '+${JSON.stringify(stamp)}+'\\n'],'dropped.txt',{type:'text/plain'}));
        const zone=document.querySelector('.dropzone');
        if(!zone)return 'no-zone';
        zone.dispatchEvent(new DragEvent('dragenter',{bubbles:true,dataTransfer:dt}));
        zone.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:dt}));
        return 'dropped';})()`);
      const queueShown = await cdp.waitFor(`()=>document.querySelector('.upload-queue')!==null`, 8000);
      check("DI-17 drop creates a queue entry", dropped === "dropped" && queueShown === true, `${dropped} queue=${queueShown}`);
      const committed = await cdp.waitFor(`()=>{const item=[...document.querySelectorAll('.upload-item')].find(li=>li.textContent?.includes('dropped.txt'));return item&&item.className.includes('committed')?item.textContent:false;}`, 20000);
      check("DI-17 queued upload commits", Boolean(committed), String(committed));
      const rowBack = await cdp.waitFor(`()=>[...document.querySelectorAll('tbody tr[data-id]')].some(r=>r.textContent?.includes('dropped.txt'))`, 20000);
      check("DI-17 committed upload appears in the file table", Boolean(rowBack), String(rowBack));
    });

    // ========== PW suite (PRECISION-WORKBENCH-V2-SPEC §3-§6) ==========
    // Every check below drives the feature the way a user does; nothing here
    // re-implements app logic, it only observes geometry, classes and state.
    await runSuite("PW", async () => {
      await cdp.navigate(`${BASE}/doc?folder=${pwFolderId}`);
      const pwReady = await cdp.waitFor(`()=>document.querySelectorAll('tbody tr[data-id]').length>=3`, 20000);
      check("PW-00 fixture folder renders its three files", Boolean(pwReady), String(pwReady));

      // ---- PW-01: V3 docked shell geometry (8px gaps for rounded cards) ----
      const shell = await cdp.evaluate(`(()=>{
        const header=document.querySelector('header.header');
        const sidebar=document.querySelector('aside.sidebar');
        const panels=document.querySelector('.panels');
        const cs=getComputedStyle(header);
        return {header:cs.height,headerBorder:cs.borderBottomWidth,
                sidebar:sidebar.getBoundingClientRect().width,
                panelsPad:getComputedStyle(panels).padding,
                panelsGap:getComputedStyle(panels).gap};})()`);
      check("PW-01 V3 header is 40px and panels have the consistent 8px gap",
        shell.header === "40px" && shell.headerBorder === "1px" && Math.round(shell.sidebar) === 240
        && shell.panelsPad === "0px" && shell.panelsGap === "8px",
        JSON.stringify(shell));

      // ---- PW-02: the six-column fixed grid never overflows ----
      const grid = await cdp.evaluate(`(()=>{
        const table=document.querySelector('table.file-table');
        const box=document.querySelector('.table');
        const tr=document.querySelector('tbody tr[data-id]');
        return {cols:table.querySelectorAll('colgroup col').length,
                layout:getComputedStyle(table).tableLayout,
                row:getComputedStyle(tr).height,
                overflowX:box.scrollWidth-box.clientWidth,
                sticky:getComputedStyle(table.querySelector('thead th')).position};})()`);
      check("PW-02 fixed 6-column grid, 26px ultra rows, sticky header, no horizontal overflow",
        grid.cols === 6 && grid.layout === "fixed" && grid.row === "26px"
        && grid.sticky === "sticky" && grid.overflowX <= 1,
        JSON.stringify(grid));


      // ---- PW-02b: sidebar-constrained pane keeps the file controls in bounds ----
      // Reproduce a narrow document pane on a desktop viewport without changing
      // the viewport itself. Viewport-only @media rules cannot pass this check.
      const paneLayout = await cdp.evaluate(`(()=>{
        const panels=document.querySelector('.panels');
        const pane=document.querySelector('.work-body');
        const toolbar=document.querySelector('.file-toolbar');
        const context=document.querySelector('.folder-context-bar');
        const grid=document.querySelector('.work-body>.table');
        const original=panels.style.cssText;
        panels.style.width='720px';
        panels.style.flex='none';
        const within=(child,host)=>{
          const a=child.getBoundingClientRect(),b=host.getBoundingClientRect();
          return a.left>=b.left-1&&a.right<=b.right+1
            &&a.top>=b.top-1&&a.bottom<=b.bottom+1;
        };
        try{
          const children=[...toolbar.querySelectorAll('.toolbar-actions,.toolbar-views,.rare-select-root,.filter-search-wrap')];
          const actions=context.querySelector('.folder-actions-slot');
          return {paneWidth:Math.round(pane.getBoundingClientRect().width),
                  toolbarInside:within(toolbar,pane),
                  controlsInside:children.every(child=>within(child,toolbar)),
                  actionsInside:!actions||within(actions,context),
                  tableOverflow:grid.scrollWidth-grid.clientWidth};
        }finally{panels.style.cssText=original;}
      })()`);
      check("PW-02b narrow file pane keeps toolbars, Rare selects and grid inside their panels",
        paneLayout.paneWidth < 560 && paneLayout.toolbarInside
        && paneLayout.controlsInside && paneLayout.actionsInside && paneLayout.tableOverflow <= 1,
        JSON.stringify(paneLayout));

      // ---- PW-03: ultra-compact 26px density locked by default and persisted ----
      const rowHeight = async () => cdp.evaluate(`(()=>{
        const tr=document.querySelector('tbody tr[data-id]');
        return getComputedStyle(tr).height;})()`);
      const ultra = await rowHeight();
      await cdp.navigate(`${BASE}/doc?folder=${pwFolderId}`);
      await cdp.waitFor(`()=>document.querySelectorAll('tbody tr[data-id]').length>=3`, 20000);
      const ultraAfterReload = await rowHeight();
      check("PW-03 ultra-compact 26px row height locked and persisted across reload",
        ultra === "26px" && ultraAfterReload === "26px",
        JSON.stringify({ ultra, ultraAfterReload }));

      // ---- PW-04: the status bar aggregates the selection ----
      await cdp.evaluate(`(()=>{const rows=[...document.querySelectorAll('tbody tr[data-id]')];rows[0].click();rows[1].dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}));return true;})()`);
      await delay(150);
      const bar = await cdp.evaluate(`(()=>{const b=document.querySelector('.status-bar');return {text:b?.textContent?.replace(/\s+/g,' ').trim()??null,height:getComputedStyle(b).height};})()`);
      check("PW-04 status bar reports the selected count and the 24px dock height",
        /已选 2 项/.test(bar.text ?? "") && bar.height === "24px",
        JSON.stringify(bar));

      // ---- PW-05: the laser rail tracks the selected tree row ----
      const railAt = async () => cdp.evaluate(`(()=>{
        const sel=document.querySelector('li[data-folder-id] .tree-row.on');
        const rail=document.querySelector('.spring-rail');
        if(!sel||!rail)return null;
        return {rail:rail.getBoundingClientRect().top,row:sel.getBoundingClientRect().top,
                width:getComputedStyle(rail).width,host:Boolean(rail.closest('.spring-rail-host'))};})()`);
      const rail1 = await railAt();
      await cdp.evaluate(`(()=>{const rows=[...document.querySelectorAll('ul.tree li[data-folder-id]')];const other=rows.find(r=>!r.querySelector('.tree-row.on'));other?.querySelector('a')?.click();return Boolean(other);})()`);
      await delay(700);
      const rail2 = await railAt();
      check("PW-05 SpringActiveRail is a 2px bar pinned to the selected row and it moves",
        rail1 !== null && rail2 !== null && rail1.width === "2px" && rail1.host === true
        && Math.abs(rail1.rail - rail1.row) <= 2 && Math.abs(rail2.rail - rail2.row) <= 2
        && Math.abs(rail2.rail - rail1.rail) > 4,
        JSON.stringify({ rail1, rail2 }));

      // ---- PW-06: guide rails are dashed, not solid ----
      const rails = await cdp.evaluate(`(()=>{
        const row=[...document.querySelectorAll('ul.tree li[data-depth]')].find(li=>li.getAttribute('data-depth')!=='0');
        if(!row)return null;
        const cs=getComputedStyle(row.querySelector('.tree-row'),'::before');
        return {style:cs.borderLeftStyle,width:cs.borderLeftWidth,color:cs.borderLeftColor};})()`);
      check("PW-06 tree guide rail is a 1px dashed line",
        rails !== null && rails.style === "dashed" && rails.width === "1px",
        JSON.stringify(rails));

      // ---- PW-07: the chevron rotates when expanded ----
      const chevron = await cdp.evaluate(`(()=>{
        const btn=document.querySelector('ul.tree li[aria-expanded="true"] button[aria-expanded="true"]');
        if(!btn)return {expanded:false};
        return {expanded:true,transform:getComputedStyle(btn).transform};})()`);
      check("PW-07 expanded chevron carries aria-expanded and a 90deg rotation",
        chevron.expanded === true && /matrix\(-?0,\s*-?1/.test(chevron.transform ?? ""),
        JSON.stringify(chevron));

      // ---- PW-08: CommandSpotlight ----
      await cdp.key("k", "KeyK", 75, CTRL);
      const opened = await cdp.waitFor(`()=>document.querySelector('.command-panel')!==null`, 5000);
      check("PW-08a Ctrl+K opens the command palette", Boolean(opened), String(opened));
      await cdp.evaluate(`(()=>{const i=document.querySelector('.command-input');const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;set.call(i,'pw-02');i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
      const filtered = await cdp.waitFor(`()=>{const rows=[...document.querySelectorAll('.command-row')];return rows.length>0&&rows.every(r=>r.textContent?.includes('pw-02'));}`, 8000);
      check("PW-08b typing narrows the palette to the matching file", Boolean(filtered), String(filtered));
      await cdp.key("Escape", "Escape", 27);
      const closed = await cdp.waitFor(`()=>document.querySelector('.command-panel')===null`, 5000);
      check("PW-08c Escape closes the palette", Boolean(closed), String(closed));

      // ---- PW-09: hold-to-confirm starts on press and cancels on release ----
      await cdp.navigate(`${BASE}/doc?folder=${pwFolderId}`);
      await cdp.waitFor(`()=>document.querySelectorAll('tbody tr[data-id]').length>=3`, 20000);
      const deleteTrigger=await cdp.evaluate(`(()=>{
        const row=[...document.querySelectorAll('tbody tr[data-id]')].find(r=>r.textContent?.includes('pw-01.txt'));
        const button=row?.querySelector('.more-trigger');if(!button)return false;
        button.click();return true;})()`);
      const deleteMenu=await cdp.waitFor(`()=>[...document.querySelectorAll('[role="menuitem"]')].some(b=>b.querySelector('.menu-label')?.textContent?.trim()==='删除')`,5000);
      const deleteSelected=deleteMenu&&await cdp.evaluate(`(()=>{
        const button=[...document.querySelectorAll('[role="menuitem"]')].find(b=>b.querySelector('.menu-label')?.textContent?.trim()==='删除');
        button?.click();return Boolean(button);})()`);
      const deleteOpen=deleteTrigger&&deleteSelected&&await cdp.waitFor(
        `()=>[...document.querySelectorAll('dialog.dialog')].some(x=>x.open&&x.textContent?.includes('删除确认'))`,8000);
      check("PW-09a delete confirmation dialog opens", Boolean(deleteOpen), String(deleteOpen));
      const armed = await cdp.evaluate(`(()=>{const b=document.querySelector('dialog.dialog .micro-hold');b?.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true}));return {found:Boolean(b),armed:b?.getAttribute('data-armed'),width:getComputedStyle(b).width,height:getComputedStyle(b).height};})()`);
      await delay(120);
      const cancelled = await cdp.evaluate(`(()=>{const b=document.querySelector('dialog.dialog .micro-hold');b?.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true}));const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.textContent?.includes('删除确认'));return {armed:b?.getAttribute('data-armed'),stillOpen:Boolean(d)};})()`);
      check("PW-09b hold-to-confirm is a 64x26 control that cancels on release",
        armed.found === true && armed.armed === "true" && armed.width === "64px" && armed.height === "26px"
        && cancelled.armed === "false" && cancelled.stillOpen === true,
        JSON.stringify({ armed, cancelled }));
      await cdp.evaluate(`(()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.textContent?.includes('删除确认'));[...d.querySelectorAll('button')].find(b=>b.textContent?.trim()==='取消')?.click();return true;})()`);

      // ---- PW-10: the empty state is a 16px wireframe glyph, not a 3D folder ----
      await cdp.navigate(`${BASE}/doc?folder=${pwEmptyFolderId}`);
      const empty = await cdp.waitFor(`()=>document.querySelector('.empty-mark')!==null`, 20000);
      const emptyShape = await cdp.evaluate(`(()=>{const m=document.querySelector('.empty-mark');return m?{w:m.getBoundingClientRect().width,hidden:m.getAttribute('aria-hidden'),toy:Boolean(document.querySelector('.rare-folder-wrap'))}:null;})()`);
      check("PW-10 empty state is a 16px aria-hidden wireframe glyph with no 3D folder",
        Boolean(empty) && emptyShape?.w === 16 && emptyShape?.hidden === "true" && emptyShape?.toy === false,
        JSON.stringify(emptyShape));

      // ---- PW-11: Keyboard traverses the actual toolbar controls, then grid ----
      await cdp.navigate(`${BASE}/doc?folder=${pwFolderId}`);
      await cdp.waitFor(`()=>document.querySelectorAll('tbody tr[data-id]').length>=3`, 20000);
      await cdp.evaluate(`(()=>{document.querySelector('select[aria-label="排序方式"]')?.focus();return true;})()`);
      const focusSteps=[];
      for(let step=0;step<3;step++){
        await cdp.key("Tab", "Tab", 9);
        focusSteps.push(await cdp.evaluate(`(()=>{
          const a=document.activeElement;
          return {label:a?.getAttribute('aria-label'),row:Boolean(a?.closest?.('tbody tr[data-id]'))};})()`));
      }
      check("PW-11 Tab reaches type and search filters before the first grid row",
        focusSteps[0]?.label==="文件类型筛选"&&
        focusSteps[1]?.label==="当前目录内过滤"&&focusSteps[2]?.row===true,
        JSON.stringify(focusSteps));

      // ---- PW-12: the header select-all box stays out of the tab order ----
      const selectAll = await cdp.evaluate(`(()=>{const i=document.querySelector('thead input[type=checkbox]');return i?i.getAttribute('tabindex'):null;})()`);
      check("PW-12 header select-all checkbox is tabIndex -1 (Ctrl+A is the keyboard path)",
        selectAll === "-1", String(selectAll));
    });

    // ================= EDITORS suite (DI-19 / VIS-10) =================
    await runSuite("EDITORS", () => editorsSuite(cookie));
  } finally {
    cdp && cdp.close();
    chrome.kill("SIGKILL");
  }

  // ---- cleanup (always runs; mirrors each source's own teardown) ----
  const cleanupErrors = [];
  const attempt = async (fn) => {
    try { await fn(); } catch (err) { cleanupErrors.push(String(err?.message ?? err)); }
  };
  const removeFixture = async (folderId) => {
    if (!folderId) return;
    const deleted = await json("DELETE", `/api/folders/${encodeURIComponent(folderId)}`);
    if (deleted.status === 404) return; // already deleted by its own test
    const trashId = deleted.body?.data?.trashId;
    if (deleted.status !== 200 || typeof trashId !== "string" || !trashId.startsWith("trash_")) {
      throw Error("fixture cleanup refused: delete did not return an owned trashId");
    }
    const purged = await json("DELETE", "/api/trash/" + encodeURIComponent(trashId));
    if (purged.status !== 200) throw Error("fixture cleanup purge failed: " + purged.status);
  };
  for (const id of [dlgFolderId,shellFolderId,selFolderId,gId,c1Id,c2Id,pId,
                    pwFolderId,pwEmptyFolderId,menuFolderId]) {
    await attempt(()=>removeFixture(id));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`SUMMARY pass=${results.length - failed.length} total=${results.length}`);
  if (failed.length || cleanupErrors.length) {
    if (failed.length) console.error("UX_DESKTOP_FAILED: " + failed.map((f) => f.name).join(", "));
    if (cleanupErrors.length) console.error("UX_DESKTOP_CLEANUP_FAILED: " + cleanupErrors.join(" | "));
    process.exit(1);
  }
  console.log("UX_DESKTOP_PASS");
}

main().catch((err) => {
  console.error("run error: " + err.message);
  process.exit(1);
});
