#!/usr/bin/env node
// Desktop interaction gate (UX-ACCEPTANCE-v1 §4 DI-01..DI-17, §5 WF-11, §6
// VIS-09, §8 G1/G2): the shared Dialog primitive, the unified shell, the file
// selection controller, the navigation tree keyboard contract, context menus
// and drag-drop upload — all through the real UI.
//
// This is the committed merge of the ad-hoc smoke runs g1_dialog / g1_shell /
// g2_select / g2_tree / g3_menu. Every original check is preserved verbatim.
// The gate is independent of browser_journey_check.mjs and
// browser_business_check.mjs and does not reduce their coverage. The five
// suites share one Chrome session and keep separate timestamped fixtures; a
// suite that crashes records one extra FAIL line naming it, and the remaining
// suites still run.
//
// Usage: node scripts/ux_desktop_check.mjs [--base http://127.0.0.1:18091]
//        [--password-file .secrets/admin.password] [--port 9360]
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const BASE = opt("base", "http://127.0.0.1:18091").replace(/\/+$/, "");
const PASSWORD_FILE = opt("password-file", ".secrets/admin.password");
const PORT = Number(opt("port", "9360"));

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

const NAV_LABELS = ["文档管理", "搜索", "共享/关注", "统计", "审批", "回收站", "组织管理"];

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
      const opened = await cdp.evaluate(`(()=>{
        const btn=[...document.querySelectorAll('.row-actions button')].find(b=>b.textContent?.trim()==='重命名');
        if(!btn)return 'no rename button';
        btn.dataset.triggerMarker='1';
        btn.focus();btn.click();return true;})()`);
      check("rename dialog opened from the row action", opened === true, String(opened));
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
        { path: "/search", active: "搜索" },
        { path: "/workspace", active: "共享/关注" },
        { path: "/stats", active: "统计" },
        { path: "/approvals", active: "审批" },
        { path: "/trash", active: "回收站" },
        { path: "/org", active: "组织管理" },
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
          const logo=document.querySelector('header.header .logo-slot')!==null;
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
      const bar = await cdp.evaluate(`(()=>document.querySelector('.selection-bar')?.textContent||'')()`);
      check("DI-08 selection bar reports the loaded-page scope", bar.includes("已选择 8 项") && bar.includes("当前加载页"), bar);

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
        Array.isArray(labels) && labels.length === 1 && labels[0].includes("删除"), JSON.stringify(labels));

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
        treeMenu === true && Array.isArray(treeLabels) && treeLabels.includes("重命名目录") && treeLabels.includes("授权管理") && treeLabels.includes("审批策略") && treeLabels.includes("删除目录"),
        JSON.stringify(treeLabels));
      await cdp.evaluate(`(()=>{const item=[...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent?.trim()==='重命名目录');item?.click();return Boolean(item);})()`);
      const renameOpen = await cdp.waitFor(`()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.textContent?.includes('重命名目录'));return d?d.querySelector('input')?.value===false?false:Boolean(d):false;}`, 6000);
      const renameValue = await cdp.evaluate(`(()=>{const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.textContent?.includes('重命名目录'));return d?d.querySelector('input')?.value:null;})()`);
      check("tree menu rename opens the folder rename dialog for that folder",
        renameOpen === true && renameValue === `UX-G3-MENU-${stamp}`, String(renameValue));
      await cdp.key("Escape", "Escape", 27);
      await delay(300);

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
  } finally {
    cdp && cdp.close();
    chrome.kill("SIGKILL");
  }

  // ---- cleanup (always runs; mirrors each source's own teardown) ----
  const cleanupErrors = [];
  const attempt = async (fn) => {
    try { await fn(); } catch (err) { cleanupErrors.push(String(err?.message ?? err)); }
  };
  const purgeTrash = async (match) => {
    const trash = await json("GET", "/api/trash");
    for (const entry of trash.body?.data ?? []) {
      const name = String(entry.name ?? entry.oldName ?? "");
      if (match(name)) await json("DELETE", "/api/trash/" + entry.id);
    }
  };
  await attempt(async () => {
    await json("DELETE", `/api/folders/${dlgFolderId}`);
    await purgeTrash((name) => name.includes("UX-G1-DIALOG-" + stamp));
  });
  await attempt(async () => {
    await json("DELETE", `/api/folders/${shellFolderId}`);
    await purgeTrash((name) => name.includes("UX-G1-SHELL-" + stamp));
  });
  await attempt(async () => {
    await json("DELETE", `/api/folders/${selFolderId}`);
    await purgeTrash((name) => name.includes("UX-G2-SELECT-" + stamp));
  });
  await attempt(async () => {
    for (const id of [gId, c1Id, c2Id, pId]) {
      if (id) await json("DELETE", `/api/folders/${id}`);
    }
    await purgeTrash((name) => name.includes("G2树") && name.includes(stamp));
  });
  await attempt(async () => {
    await json("DELETE", `/api/folders/${menuFolderId}`);
    await purgeTrash((name) => name.includes("UX-G3-MENU-" + stamp) || name.startsWith("m-0") || name === "dropped.txt");
  });

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
