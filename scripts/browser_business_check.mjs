#!/usr/bin/env node
// Business surfaces over the real browser (SPEC: every real business operation
// is front-to-back connected, with explicit loading/error/empty/permission
// feedback).
//
// Walks the business pages in headless Chrome and performs one real action on
// each: search returns real rows with safe <mark> snippets; stats render real
// aggregates; organization management creates a user and disables it through
// the form; the approval inbox lists a genuinely pending approval (created
// through the API beforehand) and approving it through the UI commits.
//
// Usage: node scripts/browser_business_check.mjs [--base http://127.0.0.1:18091]
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
const PORT = Number(opt("port", "9345"));

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

async function main() {
  // ---- prepare a genuinely pending approval through the API ----
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
  const root = (tree.body?.data ?? []).find((f) => !f.parentId);
  const folder = await json("POST", "/api/folders", { parentId: root.id, name: "业务门禁-" + stamp });
  const folderId = folder.body?.data?.id;
  const me = await json("GET", "/api/me");
  const adminId = me.body?.data?.id;
  await json("PUT", `/api/folders/${folderId}/approval-policy`, { approverId: adminId, enabled: true });

  const boundary = "----BusinessGate";
  const content = `业务门禁待审内容 ${stamp}`;
  const form = new FormData();
  form.set("folderId", folderId);
  form.set("file", new Blob([content]), `business-${stamp}.txt`);
  const uploaded = await fetch(`${BASE}/api/files`, { method: "POST", headers: { Cookie: cookie }, body: form });
  const fileId = (await uploaded.json())?.data?.fileId;
  // Save under the policy -> the save pends and shows up in the inbox.
  await json("POST", `/api/files/${fileId}/lock`, { BaseSeq: 1 });
  const lock = await json("POST", `/api/files/${fileId}/lock`, { BaseSeq: 1 });
  const lockToken = lock.body?.data?.lockToken;
  const dataUrl = "data:text/plain;base64," + Buffer.from(`业务门禁改后内容 ${stamp}`).toString("base64");
  const saved = await json("POST", `/api/files/${fileId}/save`,
    { Data: dataUrl, BaseSeq: 1, LockToken: lockToken, IdempotencyKey: `business-${stamp}` });
  check("pending approval prepared", saved.status === 202, `HTTP ${saved.status}`);

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

    // 1. login through the UI
    await cdp.navigate(`${BASE}/login`);
    const loggedIn = await cdp.login();
    check("real login", Boolean(loggedIn), "reached /doc");

    // 2. search page: a real query returns real rows
    await cdp.navigate(`${BASE}/search`);
    const searchReady = await cdp.waitFor(`()=>!!document.querySelector('#search-q')`, 15000);
    check("search page renders its form", Boolean(searchReady), "#search-q present");
    if (searchReady) {
      await cdp.evaluate(`(()=>{const el=document.querySelector('#search-q');
        const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
        s.call(el,'业务门禁');el.dispatchEvent(new Event('input',{bubbles:true}));
        const btn=[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='检索');btn?.click();return true;})()`);
      const rows = await cdp.waitFor(
        `()=>[...document.querySelectorAll('tbody tr')].some(tr=>tr.textContent?.includes('business-${stamp}.txt'))`, 20000);
      check("search returns the real file", Boolean(rows), "row visible");
      const snippet = await cdp.evaluate(
        `(()=>{const m=document.querySelector('mark');return m?m.textContent:null;})()`);
      check("search snippet uses safe <mark>",
            typeof snippet === "string" && snippet.length > 0, JSON.stringify(snippet));
    }

    // 3. stats page renders real aggregates
    await cdp.navigate(`${BASE}/stats`);
    const stats = await cdp.waitFor(
      `()=>{const t=document.body.textContent||'';return /文件数|总文件|统计/.test(t)&&/\\d/.test(t);}`, 20000);
    check("stats page renders real aggregates", Boolean(stats), "numbers present");

    // 4. organization: create a user through the form, then disable it
    await cdp.navigate(`${BASE}/org`);
    const orgReady = await cdp.waitFor(`()=>!!document.querySelector('input[aria-label="新账号"]')`, 15000);
    check("organization page renders its form", Boolean(orgReady), "create-user form present");
    if (orgReady) {
      const probeLogin = `bizprobe${stamp}`;
      const created = await cdp.evaluate(`(async()=>{
        const set=(el,v)=>{const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
        set(document.querySelector('input[aria-label="新账号"]'),${JSON.stringify(probeLogin)});
        set(document.querySelector('input[aria-label="姓名"]'),'业务探针');
        set(document.querySelector('input[aria-label="初始密码"]'),'Biz-Probe-Pw-9f2c71ad40b6');
        const btn=[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='创建用户');
        if(!btn||btn.disabled)return 'button-disabled';
        btn.click();
        // The create flow now confirms in a real dialog (no window.prompt).
        const confirmReady=await new Promise(resolve=>{
          const deadline=Date.now()+8000;
          const timer=setInterval(()=>{
            const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.textContent?.includes('确认创建'));
            if(d){clearInterval(timer);resolve(d);}
            else if(Date.now()>deadline){clearInterval(timer);resolve(null);}
          },150);
        });
        if(!confirmReady)return 'no-confirm-dialog';
        [...confirmReady.querySelectorAll('button')].find(b=>b.textContent?.trim()==='确认创建')?.click();
        await new Promise(r=>setTimeout(r,2500));
        return document.body.textContent?.includes(${JSON.stringify(probeLogin)})?'created':'not-visible';
      })()`);
      check("user created through the UI", created === "created", String(created));
      // Disable the new user through its row button.
      const disabled = await cdp.evaluate(`(async()=>{
        const row=[...document.querySelectorAll('tr')].find(tr=>tr.textContent?.includes(${JSON.stringify(probeLogin)}));
        if(!row)return 'no-row';
        const btn=[...row.querySelectorAll('button')].find(b=>b.textContent?.trim()==='禁用');
        if(!btn)return 'no-disable-button';
        btn.click();
        // Disabling is a destructive action with its own confirmation dialog.
        const confirmReady=await new Promise(resolve=>{
          const deadline=Date.now()+8000;
          const timer=setInterval(()=>{
            const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.textContent?.includes('确认禁用'));
            if(d){clearInterval(timer);resolve(d);}
            else if(Date.now()>deadline){clearInterval(timer);resolve(null);}
          },150);
        });
        if(!confirmReady)return 'no-confirm-dialog';
        [...confirmReady.querySelectorAll('button')].find(b=>b.textContent?.trim()==='确认禁用')?.click();
        await new Promise(r=>setTimeout(r,2500));
        const row2=[...document.querySelectorAll('tr')].find(tr=>tr.textContent?.includes(${JSON.stringify(probeLogin)}));
        return row2?.textContent?.includes('启用')?'disabled':'not-disabled';
      })()`);
      check("user disabled through the UI", disabled === "disabled", String(disabled));
    }

    // 5. approvals: the pending row is listed and approving it through the UI commits
    await cdp.navigate(`${BASE}/approvals`);
    const pendingRow = await cdp.waitFor(
      `()=>[...document.querySelectorAll('tbody tr')].some(tr=>tr.textContent?.includes('business-${stamp}.txt'))`, 20000);
    check("approval inbox lists the pending change", Boolean(pendingRow), "row visible");
    if (pendingRow) {
      const approved = await cdp.evaluate(`(async()=>{
        const row=[...document.querySelectorAll('tbody tr')].find(tr=>tr.textContent?.includes('business-${stamp}.txt'));
        if(!row)return 'no-row';
        const btn=[...row.querySelectorAll('button')].find(b=>b.textContent?.trim()==='通过');
        if(!btn)return 'no-approve-button';
        btn.click();
        await new Promise(r=>setTimeout(r,3000));
        const text=document.body.textContent||'';
        return /已通过/.test(text)?'approved':('msg='+text.slice(0,60));
      })()`);
      check("approving through the UI commits", approved === "approved", String(approved));
      // The committed content must now be the approved bytes.
      const meta = await json("GET", `/api/files/${fileId}`);
      const versionSeq = meta.body?.data?.file?.currentVersionSeq;
      const bytes = await fetch(`${BASE}/api/files/${fileId}/bytes`, { headers: { Cookie: cookie } });
      const text = await bytes.text();
      check("approved content is the new current version",
            versionSeq === 2 && text === `业务门禁改后内容 ${stamp}`,
            `v${versionSeq} sha-ok=${text === `业务门禁改后内容 ${stamp}`}`);
    }
  } finally {
    cdp && cdp.close();
    chrome.kill("SIGKILL");
  }

  // cleanup: remove the drill folder (soft delete) and the probe user stays disabled
  await json("DELETE", `/api/folders/${folderId}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`SUMMARY pass=${results.length - failed.length} total=${results.length}`);
  if (failed.length) {
    console.error("BROWSER_BUSINESS_FAILED: " + failed.map((f) => f.name).join(", "));
    process.exit(1);
  }
  console.log("BROWSER_BUSINESS_PASS");
}

main().catch((err) => {
  console.error("run error: " + err.message);
  process.exit(1);
});
