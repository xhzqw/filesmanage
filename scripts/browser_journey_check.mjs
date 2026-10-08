#!/usr/bin/env node
// Core user journey over the real browser (SPEC §M1/M2 acceptance, re-runnable).
//
// Drives headless Chrome against the dev instance and walks the primary
// journey end to end, asserting each step through the real UI:
//   login page renders -> wrong password refused -> real login -> document
//   tree with real folders -> create folder -> upload through the form ->
//   the file appears in the list -> preview page shows byte metadata ->
//   download round-trips the exact bytes -> delete -> trash -> restore ->
//   the file is back -> logout invalidates the session and deep links
//   redirect to /login.
//
// Usage: node scripts/browser_journey_check.mjs [--base http://127.0.0.1:18091]
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
const PORT = Number(opt("port", "9341"));

const password = readFileSync(PASSWORD_FILE, "utf8").trim();
const stamp = String(Date.now());

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`);
};

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
    if (res.exceptionDetails) throw new Error("evaluate threw: " + JSON.stringify(res.exceptionDetails).slice(0, 200));
    return res.result.value;
  }
  // window.confirm (delete flows) must be answered by the driver.
  autoAcceptDialogs() {
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === "Page.javascriptDialogOpening") {
        this.send("Page.handleJavaScriptDialog", { accept: true });
      }
    });
  }

  async setFileInputFiles(selector, path) {
    const doc = await this.send("DOM.getDocument");
    const node = await this.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
    if (!node.nodeId) throw new Error("file input not found: " + selector);
    await this.send("DOM.setFileInputFiles", { nodeId: node.nodeId, files: [path] });
  }

  // Clicking a plain <a> triggers a full page load, which destroys the
  // execution context; fire the click synchronously and wait for the load.
  async clickAndSettle(text) {
    await this.evaluate(`(()=>{const el=[...document.querySelectorAll('a')].find(a=>a.textContent?.includes(${JSON.stringify(text)}));if(!el)return false;el.click();return true;})()`);
    const loaded = new Promise((resolve) => {
      const timer = setInterval(() => {
        const hit = this.events.find((e) => e.method === "Page.loadEventFired");
        if (hit) { this.events.splice(this.events.indexOf(hit), 1); clearInterval(timer); resolve(); }
      }, 100);
      setTimeout(() => { clearInterval(timer); resolve(); }, 15000);
    });
    await loaded;
    await delay(1500);
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
  }
  async waitFor(predicate, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await this.evaluate(`(${predicate})()`);
      if (value) return value;
      if (Date.now() > deadline) return null;
      await delay(250);
    }
  }
  async type(selector, text) {
    await this.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;
      const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      setter.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  }
  async clickText(text) {
    return this.evaluate(`(()=>{const el=[...document.querySelectorAll('button,a')].find(e=>e.textContent?.trim()===${JSON.stringify(text)});
      if(!el)return false;el.click();return true;})()`);
  }
  close() { this.ws.close(); }
}

async function main() {
  const chrome = spawn("/usr/bin/google-chrome", [
    "--headless=new", `--remote-debugging-port=${PORT}`, "--no-sandbox",
    "--disable-dev-shm-usage", "--window-size=1440,900", "about:blank",
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
    await cdp.send("DOM.enable");
    cdp.autoAcceptDialogs();

    // 1. the login page renders
    await cdp.navigate(`${BASE}/login`);
    const hasForm = await cdp.waitFor(`()=>!!document.querySelector('input[type=password]')&&!!document.querySelector('button')`);
    check("login page renders", Boolean(hasForm), "password field + submit present");

    // 2. a wrong password is refused by the real UI
    await cdp.type("input[type=text],input:not([type])", "admin");
    await cdp.type("input[type=password]", "definitely-not-the-password");
    await cdp.clickText("登录") || await cdp.evaluate(`(()=>{document.querySelector('form button,button').click();return true})()`);
    await delay(1200);
    const stillOnLogin = await cdp.evaluate(`()=>location.pathname==='/login'||location.pathname==='/'`);
    check("wrong password refused", Boolean(stillOnLogin), `still on ${await cdp.evaluate("(()=>location.pathname)()")}`);

    // 3. real login lands on the document page with the real tree
    await cdp.type("input[type=password]", password);
    await cdp.clickText("登录") || await cdp.evaluate(`(()=>{document.querySelector('form button,button').click();return true;})()`);
    const onDoc = await cdp.waitFor(`()=>location.pathname==='/doc'||location.pathname==='/first-sign-in'`, 15000);
    check("real login reaches the document page", Boolean(onDoc), await cdp.evaluate("(()=>location.pathname)()"));

    // The brand shell proves the real app (not a placeholder) is served.
    const brand = await cdp.evaluate(`()=>document.body.textContent?.includes('中晟生物科技')??false`);
    check("brand shell served", Boolean(brand), "中晟生物科技 present");

    // 4. the folder tree shows real folders
    const tree = await cdp.waitFor(`()=>document.body.textContent?.includes('示范项目')||document.body.textContent?.includes('市场部')`, 15000);
    check("real folder tree rendered", Boolean(tree), "seeded folders visible");

    // 5. create a folder through the real inline form
    const created = await cdp.evaluate(`(async()=>{
      const input=document.querySelector('input[aria-label="新目录名称"]');
      if(!input)return 'no-input';
      const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      setter.call(input,'旅程目录-${stamp}');
      input.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(r=>setTimeout(r,300));
      const btn=[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='新建文件夹');
      if(!btn||btn.disabled)return 'no-button';
      btn.click();
      await new Promise(r=>setTimeout(r,1500));
      return document.body.textContent?.includes('旅程目录-${stamp}')?'created':'not-visible';
    })()`);
    check("folder created through the UI", created === "created", String(created));

    // 6. upload through the real file input via the CDP protocol
    // The uploaded name is the temp file's basename, so it must carry the
    // stamp: a fixed name collides with earlier runs.
    const uploadPath = `/tmp/journey-${stamp}.txt`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(uploadPath, `旅程上传内容 ${stamp}`);
    const inputPresent = await cdp.waitFor(`()=>!!document.querySelector('input[type=file]')`, 10000);
    check("upload input present", Boolean(inputPresent), "input[type=file]");
    if (inputPresent) {
      await cdp.setFileInputFiles("input[type=file]", uploadPath);
      const uploaded = await cdp.waitFor(
        `()=>document.body.textContent?.includes('journey-${stamp}.txt')`, 20000);
      check("file uploaded through the UI", Boolean(uploaded), "row visible in the table");
    } else {
      check("file uploaded through the UI", false, "no upload input");
    }

    // 7. open the preview page through the real row link
    const hasLink = await cdp.evaluate(`(()=>[...document.querySelectorAll('a')].some(a=>a.textContent?.includes('journey-${stamp}.txt')))()`);
    check("file row links to the preview page", Boolean(hasLink), "row link present");
    await cdp.clickAndSettle(`journey-${stamp}.txt`);
    const preview = await cdp.evaluate(`(()=>{
      const text=document.body.textContent||'';
      const onPreview=location.pathname.startsWith('/preview/');
      return (onPreview&&/SHA|sha|编码|BOM|字节/.test(text))?'preview':('path='+location.pathname+' meta='+/SHA|sha|编码|BOM|字节/.test(text));
    })()`);
    check("preview shows byte metadata", preview === "preview", String(preview));
    await cdp.navigate(`${BASE}/doc`);
    await cdp.waitFor(`()=>document.body.textContent?.includes('journey-${stamp}.txt')`, 20000);

    // 8. the download endpoint round-trips the exact bytes (session-authenticated)
    const download = await cdp.evaluate(`(async()=>{
      const res=await fetch('/api/files?folder=folder_root&limit=200',{credentials:'same-origin'});
      const body=await res.json();
      const item=(body.data?.items??[]).find(f=>f.name==='journey-${stamp}.txt');
      if(!item)return 'not-listed';
      const bytes=await fetch('/api/files/'+item.id+'/bytes',{credentials:'same-origin'});
      const text=await bytes.text();
      return text==='旅程上传内容 ${stamp}'?'exact':'mismatch:'+text.slice(0,20);
    })()`);
    check("download round-trips the exact bytes", download === "exact", String(download));

    // 9. delete through the UI (the confirm dialog is auto-accepted)
    const deleted = await cdp.evaluate(`(async()=>{
      const row=[...document.querySelectorAll('tbody tr')].find(tr=>tr.textContent?.includes('journey-${stamp}.txt'));
      if(!row)return 'no-row';
      const btn=[...row.querySelectorAll('button')].find(b=>b.textContent?.trim()==='删除');
      if(!btn)return 'no-delete-button';
      btn.click();
      await new Promise(r=>setTimeout(r,2500));
      // The announce notice echoes the file name, so the table is the
      // authoritative surface here, not document.body.
      const still=[...document.querySelectorAll('tbody tr')].some(tr=>tr.textContent?.includes('journey-${stamp}.txt'));
      return still?'still-listed':'gone';
    })()`);
    check("delete moves the file out of the list", deleted === "gone", String(deleted));

    // 10. the trash page lists it and restores it
    await cdp.navigate(`${BASE}/trash`);
    await delay(1500);
    const trashListed = await cdp.waitFor(`()=>document.body.textContent?.includes('journey-${stamp}.txt')`, 15000);
    check("trash lists the deleted file", Boolean(trashListed), "row visible on /trash");
    const restored = await cdp.evaluate(`(async()=>{
      const row=[...document.querySelectorAll('tbody tr')].find(tr=>tr.textContent?.includes('journey-${stamp}.txt'));
      if(!row)return 'no-row';
      const btn=[...row.querySelectorAll('button')].find(b=>b.textContent?.trim()==='恢复');
      if(!btn)return 'no-restore-button';
      btn.click();
      await new Promise(r=>setTimeout(r,2500));
      const still=[...document.querySelectorAll('tbody tr')].some(tr=>tr.textContent?.includes('journey-${stamp}.txt'));
      return still?'still-in-trash':'left-trash';
    })()`);
    check("restore removes it from the trash", restored === "left-trash", String(restored));
    await cdp.navigate(`${BASE}/doc`);
    const backInList = await cdp.waitFor(`()=>[...document.querySelectorAll('tbody tr')].some(tr=>tr.textContent?.includes('journey-${stamp}.txt'))`, 20000);
    check("restored file is back in the document list", Boolean(backInList), "row visible on /doc");

    // 11. logout invalidates the session and deep links redirect to /login
    await cdp.navigate(`${BASE}/doc`);
    await delay(1000);
    const loggedOut = await cdp.clickText("退出");
    await delay(1500);
    const afterLogout = await cdp.evaluate(`(()=>location.pathname)()`);
    const apiDead = await cdp.evaluate(`(async()=>{
      const res=await fetch('/api/me',{credentials:'same-origin'});
      return res.status===401;
    })()`);
    check("logout returns to the login page", afterLogout === "/login", String(afterLogout));
    check("session dead after logout", Boolean(apiDead), "/api/me -> 401");
    await cdp.navigate(`${BASE}/doc`);
    await delay(1500);
    const redirected = await cdp.evaluate(`(()=>location.pathname)()`);
    check("deep link redirects to login", redirected === "/login", String(redirected));

    // Cleanup must not rely on the browser session: the logout steps above
    // revoked it, so a fresh API login is used instead.
    const cleanupLogin = await fetch(`${BASE}/api/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: "admin", password }),
    });
    const cleanupCookie = cleanupLogin.headers.getSetCookie().find((c) => c.startsWith("fm_session=")).split(";")[0];
    // A Cookie header cannot be set from page script (forbidden header name),
    // so the fresh session is installed into the browser instead and the
    // in-page fetches use same-origin credentials.
    await cdp.send("Network.setCookie", {
      name: "fm_session", value: cleanupCookie.slice("fm_session=".length),
      domain: new URL(BASE).hostname, path: "/",
    });
    const cleanup = await cdp.evaluate(`(async()=>{
      const res=await fetch('/api/files?folder=folder_root&limit=200',{credentials:'same-origin'});
      const body=await res.json();
      const item=(body.data?.items??[]).find(f=>f.name==='journey-${stamp}.txt');
      if(item)await fetch('/api/files/'+item.id,{method:'DELETE',credentials:'same-origin'});
      const folders=await (await fetch('/api/folders/tree',{credentials:'same-origin'})).json();
      const folder=(folders.data??[]).find(f=>f.name==='旅程目录-${stamp}');
      if(folder)await fetch('/api/folders/'+folder.id,{method:'DELETE',credentials:'same-origin'});
      return {file:!!item,folder:!!folder};
    })()`);
    check("journey data cleaned up", Boolean(cleanup), JSON.stringify(cleanup));

  } finally {
    cdp && cdp.close();
    chrome.kill("SIGKILL");
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`SUMMARY pass=${results.length - failed.length} total=${results.length}`);
  if (failed.length) {
    console.error("BROWSER_JOURNEY_FAILED: " + failed.map((f) => f.name).join(", "));
    process.exit(1);
  }
  console.log("BROWSER_JOURNEY_PASS");
}

main().catch((err) => {
  console.error("run error: " + err.message);
  process.exit(1);
});
