#!/usr/bin/env node
// Real-browser acceptance for the 「项目」 workbench view, now backed by the API.
// Logs in, opens 项目 from the rail, then drives create → inline edit → view
// switches → archive, and checks layout at three widths. Cleans up after itself
// by soft-deleting the record it created.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";

const base = (process.argv[2] || "http://127.0.0.1:18091").replace(/\/+$/, "");
const password = readFileSync(process.argv[3] || ".secrets/admin.password", "utf8").trim();
const port = 18000 + (process.pid % 17000);
const profile = mkdtempSync(join(tmpdir(), "fm-projects-browser-"));
const NAME = "浏览器验收项目 " + Date.now();

const chrome = spawn("/usr/bin/google-chrome", [
  "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--window-size=1440,900", "about:blank",
], {stdio: "ignore", detached: true});

let ws;
let sequence = 0;
const pending = new Map();
function send(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, {resolve, reject});
    ws.send(JSON.stringify({id, method, params}));
  });
}
async function evalJS(expression) {
  const result = await send("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true});
  if (result.exceptionDetails) throw Error("browser exception: " + JSON.stringify(result.exceptionDetails).slice(0, 400));
  return result.result.value;
}
async function until(expression, label) {
  for (let i = 0; i < 120; i++) {
    if (await evalJS(expression)) return;
    await sleep(150);
  }
  const snapshot = await evalJS("({url:location.href,text:document.body.innerText.slice(0,600)})");
  throw Error(`wait timeout: ${label || expression}; ${JSON.stringify(snapshot)}`);
}
// React ignores synthetic input events unless the native setter is used.
const setValue = (selector, value) => `(()=>{const el=document.querySelector(${JSON.stringify(selector)});
 if(!el)return false;
 const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
 Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});
 el.dispatchEvent(new Event('input',{bubbles:true}));
 return true;})()`;

try {
  let tab;
  for (let i = 0; i < 80 && !tab; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      tab = list.find((t) => t.type === "page");
    } catch {}
    if (!tab) await sleep(150);
  }
  assert.ok(tab, "Chrome debugger available");
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, {once: true});
    ws.addEventListener("error", reject, {once: true});
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const ticket = pending.get(message.id);
    if (ticket) {
      pending.delete(message.id);
      message.error ? ticket.reject(Error(message.error.message)) : ticket.resolve(message.result);
    }
  });
  await send("Page.enable");
  await send("Runtime.enable");

  await send("Page.navigate", {url: base + "/login"});
  await until("location.pathname==='/login'", "login page");
  const login = await evalJS(`(async()=>{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
   credentials:'same-origin',body:JSON.stringify({login:'admin',password:${JSON.stringify(password)}})});return {status:r.status,ok:(await r.json()).ok}})()`);
  assert.equal(login.status, 200, "admin login");
  assert.equal(login.ok, true);

  // Open the workbench and click 「项目」 in the rail (the real user path).
  await send("Page.navigate", {url: base + "/workbench"});
  await until("location.pathname==='/workbench'&&!!document.querySelector('.cdw-rail-nav')", "workbench rail");
  const clicked = await evalJS(`(()=>{const items=[...document.querySelectorAll('.cdw-rail-item')];
   const hit=items.find(b=>b.textContent.includes('项目')&&!b.textContent.includes('我的'));
   if(!hit)return false;hit.click();return true;})()`);
  assert.ok(clicked, "项目 entry exists in the rail");
  await until("!!document.querySelector('.pj-shell')", "project view mounted");
  await until("!document.querySelector('.pj-shell .cdw-message')", "project list settled");

  // The list request must have succeeded; the error notice is the failure mode.
  assert.equal(await evalJS("document.querySelectorAll('.pj-shell .rare-notice, .pj-shell .cdw-error').length"), 0,
    "project view must not show an error notice (API reachable)");

  // Create through the drawer, the way a user does.
  await evalJS(`(()=>{const b=[...document.querySelectorAll('.pj-title-row button, .pj-shell button')]
    .find(x=>x.textContent.trim()==='＋ 新建项目');b.click();return true;})()`);
  await until("!!document.querySelector('.pj-dr-title')", "drawer opened");
  assert.ok(await evalJS(setValue(".pj-dr-title", NAME)), "project name input focusable");
  await evalJS(setValue(".pj-desc", "由 scripts/project_browser_check.mjs 创建，用于验收三视图与保存链路。"));
  const saved = await evalJS(`(()=>{const b=[...document.querySelectorAll('.pj-dr-foot button')]
    .find(x=>x.textContent.trim()==='保存');if(!b||b.disabled)return false;b.click();return true;})()`);
  assert.ok(saved, "save button enabled for a valid name");
  await until("!document.querySelector('.pj-drawer')", "drawer closed after save");
  await until(`[...document.querySelectorAll('.pj-card-title')].some(el=>el.textContent.includes(${JSON.stringify(NAME)}))`,
    "created project on the board");

  const serverRow = await evalJS(`(async()=>{const r=await fetch('/api/projects');const j=await r.json();
   const hit=(j.data.items||[]).find(p=>p.name===${JSON.stringify(NAME)});return hit?{id:hit.id,status:hit.status,archived:hit.archived}:null;})()`);
  assert.ok(serverRow?.id, "created project exists server-side (data is not frontend-only)");
  assert.equal(serverRow.archived, false);

  // Inline edit through the table view (status dropdown) must persist.
  await evalJS(`(()=>{const b=[...document.querySelectorAll('.pj-vt')].find(x=>x.textContent.trim()==='表格');b.click();return true;})()`);
  await until("!!document.querySelector('.pj-table')", "table view");
  assert.equal(await evalJS("document.querySelectorAll('.pj-table tbody tr').length>0"), true, "table renders rows");
  const changed = await evalJS(`(()=>{const rows=[...document.querySelectorAll('.pj-table tbody tr')];
   const row=rows.find(r=>r.textContent.includes(${JSON.stringify(NAME)}));if(!row)return false;
   const sel=row.querySelector('select');if(!sel)return false;
   const proto=HTMLSelectElement.prototype;
   Object.getOwnPropertyDescriptor(proto,'value').set.call(sel,'done');
   sel.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  assert.ok(changed, "status cell is an inline select");
  await until(`(async()=>{const r=await fetch('/api/projects');const j=await r.json();
   const hit=(j.data.items||[]).find(p=>p.name===${JSON.stringify(NAME)});return !!hit&&hit.status==='done';})()`,
    "inline status change persisted server-side");

  // Gantt view must place a bar for the created project.
  await evalJS(`(()=>{const b=[...document.querySelectorAll('.pj-vt')].find(x=>x.textContent.trim()==='甘特');b.click();return true;})()`);
  await until("!!document.querySelector('.pj-gantt')", "gantt view");
  assert.equal(await evalJS("document.querySelectorAll('.pj-gbar').length>0"), true, "gantt draws bars");

  // Layout: no horizontal overflow at desktop, laptop and narrow widths.
  for (const width of [1440, 1280, 1024]) {
    await send("Emulation.setDeviceMetricsOverride", {width, height: 900, deviceScaleFactor: 1, mobile: false});
    await sleep(220);
    const metrics = await evalJS(`(()=>{const shell=document.querySelector('.pj-shell');if(!shell)return null;
     const r=shell.getBoundingClientRect();
     return {docWidth:document.documentElement.scrollWidth,left:r.left,right:r.right,viewWidth:width};})()`);
    assert.ok(metrics, "project shell visible at " + width);
    assert.ok(metrics.docWidth <= width + 2, `horizontal overflow at ${width}: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.left >= -2 && metrics.right <= width + 2, `shell escapes viewport at ${width}: ${JSON.stringify(metrics)}`);
    console.log("PROJECT_LAYOUT_PASS", width);
  }
  await send("Emulation.clearDeviceMetricsOverride");

  // Archive from the drawer, then confirm it leaves the list and stays archived.
  await evalJS(`(()=>{const b=[...document.querySelectorAll('.pj-vt')].find(x=>x.textContent.trim()==='看板');b.click();return true;})()`);
  await until("!!document.querySelector('.pj-board')", "board again");
  await evalJS(`(()=>{const cards=[...document.querySelectorAll('.pj-card')];
   const card=cards.find(c=>c.textContent.includes(${JSON.stringify(NAME)}));card.click();return true;})()`);
  await until("!!document.querySelector('.pj-drawer')", "drawer reopened");
  // window.confirm must be auto-accepted for the archive confirmation.
  await evalJS("window.confirm=()=>true");
  const archived = await evalJS(`(()=>{const b=[...document.querySelectorAll('.pj-dr-foot button')]
    .find(x=>x.textContent.trim()==='归档');if(!b)return false;b.click();return true;})()`);
  assert.ok(archived, "archive action available for a saved project");
  await until("!document.querySelector('.pj-drawer')", "drawer closed after archive");
  await until(`(async()=>{const r=await fetch('/api/projects');const j=await r.json();
   return !(j.data.items||[]).some(p=>p.name===${JSON.stringify(NAME)});})()`, "archived project removed from list");
  const archivedRow = await evalJS(`(async()=>{const r=await fetch('/api/projects/${serverRow.id}');const j=await r.json();
   return j.data.project.archived;})()`);
  assert.equal(archivedRow, true, "archive is persisted, not just hidden in the browser");

  console.log("PROJECT_BROWSER_PASS id=" + serverRow.id + " name=" + NAME);
} finally {
  try { ws?.close(); } catch {}
  try { process.kill(-chrome.pid, "SIGKILL"); } catch { try { chrome.kill("SIGKILL"); } catch {} }
  try { rmSync(profile, {recursive: true, force: true}); } catch {}
}
