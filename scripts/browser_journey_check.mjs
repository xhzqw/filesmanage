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
      // The upload queue shows the file name first; the table row lands after
      // the committed reload, so wait for the row itself, not the page text.
      const uploaded = await cdp.waitFor(
        `()=>[...document.querySelectorAll('tbody tr')].some(tr=>tr.textContent?.includes('journey-${stamp}.txt'))`, 30000);
      check("file uploaded through the UI", Boolean(uploaded), "row visible in the table");
    } else {
      check("file uploaded through the UI", false, "no upload input");
    }

    // Same-name upload is never an implicit overwrite. The queue exposes an
    // explicit CAS-confirmed replacement with the original file ID preserved.
    if(inputPresent){
      writeFileSync(uploadPath,`已替换的旅程内容 ${stamp}`);
      await cdp.setFileInputFiles("input[type=file]",uploadPath);
      const conflict=await cdp.waitFor(`()=>[...document.querySelectorAll('.upload-item.failed')].some(li=>li.textContent?.includes('journey-${stamp}.txt'))`,30000);
      check("same-name upload requires explicit resolution",Boolean(conflict),"failed queue row rather than silent overwrite");
      if(conflict)await cdp.evaluate(`(()=>{
       const li=[...document.querySelectorAll('.upload-item.failed')].find(item=>item.textContent?.includes('journey-${stamp}.txt'));
       [...(li?.querySelectorAll('button')??[])].find(b=>b.textContent?.includes('替换为新版本'))?.click();
      })()`);
      const ready=conflict&&await cdp.waitFor(`()=>[...document.querySelectorAll('[aria-label="确认替换现有文件"]')].some(el=>el.textContent?.includes('v1'))`,9000);
      check("replacement confirmation names original version",Boolean(ready),"user must confirm v1 replacement");
      if(ready)await cdp.evaluate(`(()=>{
       const area=document.querySelector('[aria-label="确认替换现有文件"]');
       [...(area?.querySelectorAll('button')??[])].find(b=>b.textContent?.includes('确认替换'))?.click();
      })()`);
      const replaced=ready&&await cdp.waitFor(`()=>[...document.querySelectorAll('.upload-item.committed')].some(li=>li.textContent?.includes('journey-${stamp}.txt')&&li.textContent?.includes('v2'))`,30000);
      check("replacement creates v2 through real upload queue",Boolean(replaced),"new immutable version");
      const historical=replaced&&await cdp.evaluate(`(async()=>{
       const files=await(await fetch('/api/files?folder=folder_root&limit=200')).json();
       const file=files.data?.items?.find(f=>f.name==='journey-${stamp}.txt');
       if(!file)return false;
       const meta=await(await fetch('/api/files/'+file.id)).json();
       const history=await(await fetch('/api/files/'+file.id+'/history')).json();
       return meta.data?.versions?.length===2&&history.data?.items?.some(row=>row.eventType==='file.replace'&&row.details?.baseSeq===1&&row.details?.versionSeq===2);
      })()`);
      check("replacement is traceable to stable file ID",Boolean(historical),"v1 and v2 retained with file.replace event");
    }

    // 7. open the preview page from the row (DESKTOP-INTERACTION-v1: the file
    // name is no longer a single-click navigation link; the row offers an
    // explicit 打开 action and double-click instead)
    // The live resource event can invalidate the first post-upload table page;
    // wait for the committed row to be present after reconciliation.
    await delay(800);
    await cdp.waitFor(`()=>[...document.querySelectorAll('tbody tr')].some(tr=>tr.textContent?.includes('journey-${stamp}.txt'))`,15000);
    const rowSurface = await cdp.evaluate(`(()=>{
      const row=[...document.querySelectorAll('tbody tr')].find(tr=>tr.textContent?.includes('journey-${stamp}.txt'));
      if(!row)return 'no-row';
      const nameLink=[...row.querySelectorAll('a')].some(a=>a.textContent?.includes('journey-${stamp}.txt'));
      const open=[...row.querySelectorAll('button')].some(b=>b.textContent?.trim()==='打开');
      return {nameLink,open};
    })()`);
    check("file row exposes an explicit open action, not a name link",
      rowSurface && rowSurface.nameLink === false && rowSurface.open === true, JSON.stringify(rowSurface));
    await cdp.evaluate(`(()=>{
      const row=[...document.querySelectorAll('tbody tr')].find(tr=>tr.textContent?.includes('journey-${stamp}.txt'));
      const open=[...row.querySelectorAll('button')].find(b=>b.textContent?.trim()==='打开');
      open?.click();return true;})()`);
    await cdp.waitFor(`()=>location.pathname.startsWith('/preview/')`, 15000);
    await delay(1200);
    // The workspace is content-first. Metadata and review panels must not
    // replace or remount the right-side viewer when selected.
    const layout = await cdp.evaluate(`(()=>{
      const root=document.querySelector('.file-workbench-layout');
      const left=document.querySelector('.file-workbench-sidebar');
      const right=document.querySelector('.file-workbench-preview-surface');
      if(!root||!left||!right)return null;
      const box=root.getBoundingClientRect(),stage=right.getBoundingClientRect();
      return {ratio:stage.width/Math.max(1,box.width),height:stage.height,nav:!!left.querySelector('.file-workbench-nav')};
    })()`);
    check("file preview opens a large right-side persistent canvas",
      !!layout&&layout.ratio>=.65&&layout.height>220&&layout.nav,JSON.stringify(layout));
    await cdp.evaluate(`(()=>{
      window.__journeyViewer=document.querySelector('.file-workbench-preview-surface .file-text-stage');
      const button=[...document.querySelectorAll('.file-workbench-nav-item')].find(b=>b.textContent?.includes('文件信息'));
      button?.click();
    })()`);
    await delay(300);
    const details=await cdp.evaluate(`(()=>{
      const viewer=document.querySelector('.file-workbench-preview-surface .file-text-stage');
      const panel=document.querySelector('.file-sidebar-context.file-details-panel');
      return {shown:!!panel&&panel.textContent?.includes('SHA-256'),stable:viewer===window.__journeyViewer,canvas:!!document.querySelector('.file-workbench-preview-surface')};
    })()`);
    check("file metadata stays in left pane without remounting preview",
      !!details&&details.shown&&details.stable&&details.canvas,JSON.stringify(details));
    await cdp.evaluate(`(()=>{
      [...document.querySelectorAll('.file-workbench-nav-item')].find(b=>b.textContent?.trim()==='预览')?.click();
    })()`);

    // Browser-only print is a proper file action: the workbench opens without
    // downloading the original file, and the server separately authorizes
    // both preview+print against the current immutable source digest.
    const printOpened = await cdp.evaluate(`(()=>{
      const action=[...document.querySelectorAll('.file-workbench-actions button')].find(b=>b.textContent?.trim()==='打印');
      action?.click();return !!action;
    })()`);
    const printPanel = await cdp.waitFor(`()=>Boolean(
      document.querySelector('dialog.document-print-dialog[open] .document-print-options')
    )`, 8000);
    check("file preview exposes RareUI print workbench", Boolean(printOpened&&printPanel), "print options panel visible in modal");
    const printPrepared = await cdp.evaluate(`(async()=>{
      const id=location.pathname.split('/').pop();
      const preview=await(await fetch('/api/files/'+encodeURIComponent(id)+'/preview',{credentials:'same-origin'})).json();
      const response=await fetch('/api/files/'+encodeURIComponent(id)+'/print/prepare',{
       method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
       body:JSON.stringify({expectedSha256:preview.data?.sha256})
      });
      const body=await response.json();
      return response.status===200&&body.data?.sha256===preview.data?.sha256&&body.data?.versionSeq>=1;
    })()`);
    check("browser print API pins digest and audits intention", Boolean(printPrepared), "print+preview ACL authorized");
    await cdp.clickText("取消");
    const printClosed=await cdp.waitFor(`()=>!document.querySelector('dialog.document-print-dialog[open]')`,3000);
    check("print workbench closes without navigation", Boolean(printClosed), "still on file preview");
    await cdp.navigate(`${BASE}/doc`);
    await cdp.waitFor(`()=>document.body.textContent?.includes('journey-${stamp}.txt')`, 20000);

    // Batch browser print uses the existing file selection and a single
    // workbench, never automatically launching N popup windows.
    // Batch actions only apply to 2+ files; create a second isolated fixture.
    const batchUploadPath = `/tmp/journey-batch-${stamp}.txt`;
    writeFileSync(batchUploadPath,`批量打印测试 ${stamp}`);
    const batchPickerReady=await cdp.waitFor(`()=>Boolean(document.querySelector('input[type=file]'))`,20000);
    check("batch upload picker restored after navigation",Boolean(batchPickerReady),"async folder hydration finished");
    if(batchPickerReady)await cdp.setFileInputFiles("input[type=file]",batchUploadPath);
    const secondUploaded=await cdp.waitFor(`()=>[...document.querySelectorAll('tbody tr')].some(tr=>tr.textContent?.includes('journey-batch-${stamp}.txt'))`,30000);
    check("batch print secondary file uploaded",Boolean(secondUploaded),"second isolated fixture");
    const batchSelectable=await cdp.waitFor(`()=>['journey-${stamp}.txt','journey-batch-${stamp}.txt'].every(name=>
      [...document.querySelectorAll('tbody tr')].some(row=>row.textContent?.includes(name)&&row.querySelector('input[type=checkbox]')))`,12000);
    if(batchSelectable){
     await cdp.evaluate(`(()=>{
      for(const name of ['journey-${stamp}.txt','journey-batch-${stamp}.txt']){
       const row=[...document.querySelectorAll('tbody tr')].find(r=>r.textContent?.includes(name));
       const input=row?.querySelector('input[type=checkbox]');
       if(input&&!input.checked)input.click();
      }
      return true;})()`);
    }
    const opened=batchSelectable&&await cdp.evaluate(`(()=>{
     const row=[...document.querySelectorAll('tbody tr')].find(r=>r.textContent?.includes('journey-${stamp}.txt'));
     const more=row?.querySelector('button.more-trigger');
     if(!more)return false;more.click();return true;})()`);
    const available=opened&&await cdp.waitFor(`()=>[...document.querySelectorAll('[role=menuitem]')].some(b=>b.querySelector('.menu-label')?.textContent==='批量打印')`,5000);
    if(available)await cdp.evaluate(`(()=>{
     [...document.querySelectorAll('[role=menuitem]')].find(b=>b.querySelector('.menu-label')?.textContent==='批量打印')?.click();
     return true;})()`);
    const batchDialog=await cdp.waitFor(`()=>Boolean(document.querySelector('dialog.batch-print-dialog[open]')?.querySelector('[aria-label="批量打印纸张"]'))`,5000);
    check("selected files open browser batch print workbench",Boolean(batchDialog),"two files, one dialog");
    if(batchDialog){
     const watermarkUI=await cdp.evaluate(`(()=>{
      const dialog=document.querySelector('dialog.batch-print-dialog[open]');
      dialog?.querySelector('input[type=checkbox]')?.click();
      return Boolean(dialog?.textContent?.includes('水印文字'));})()`);
     check("batch print exposes optional text/image watermark",Boolean(watermarkUI),"watermark input available");
     await cdp.evaluate(`(()=>{
      const dialog=document.querySelector('dialog.batch-print-dialog[open]');
      [...(dialog?.querySelectorAll('button')??[])].find(b=>b.textContent?.trim()==='关闭')?.click();return true;})()`);
    }else check("batch print exposes optional text/image watermark",false,"batch dialog unavailable");
    await cdp.waitFor(`()=>!document.querySelector('dialog.batch-print-dialog[open]')`,3000);
    if(batchSelectable)await cdp.evaluate(`(()=>{
     for(const name of ['journey-${stamp}.txt','journey-batch-${stamp}.txt']){
      const row=[...document.querySelectorAll('tbody tr')].find(r=>r.textContent?.includes(name));
      const input=row?.querySelector('input[type=checkbox]');
      if(input?.checked)input.click();
     }
     return true;})()`);

    // 8. the download endpoint round-trips the exact bytes (session-authenticated)
    const download = await cdp.evaluate(`(async()=>{
      const res=await fetch('/api/files?folder=folder_root&limit=200',{credentials:'same-origin'});
      const body=await res.json();
      const item=(body.data?.items??[]).find(f=>f.name==='journey-${stamp}.txt');
      if(!item)return 'not-listed';
      const bytes=await fetch('/api/files/'+item.id+'/bytes',{credentials:'same-origin'});
      const text=await bytes.text();
      return text==='已替换的旅程内容 ${stamp}'?'exact':'mismatch:'+text.slice(0,20);
    })()`);
    check("download round-trips the exact bytes", download === "exact", String(download));

    // 9. delete through the shared file action menu and native modal.
    // The old inline Delete button was removed to avoid a popup clipped by
    // the horizontally scrollable grid. Exercise the real menuitem path.
    const deleted = await cdp.evaluate(`(async()=>{
      const row=[...document.querySelectorAll('tbody tr')].find(tr=>tr.textContent?.includes('journey-${stamp}.txt'));
      if(!row)return 'no-row';
      const btn=row.querySelector('button.more-trigger');
      if(!btn)return 'no-file-action-trigger';
      btn.click();
      const menuItem=await new Promise(resolve=>{
        const deadline=Date.now()+3000;
        const timer=setInterval(()=>{
          const menu=document.querySelector('[role="menu"][aria-label="文件操作菜单"]');
          const item=[...(menu?.querySelectorAll('[role="menuitem"]')??[])]
           .find(b=>b.querySelector('.menu-label')?.textContent==='删除');
          if(item){clearInterval(timer);resolve(item);}
          else if(Date.now()>deadline){clearInterval(timer);resolve(null);}
        },60);
      });
      if(!menuItem)return 'no-delete-menuitem';
      menuItem.click();
      await new Promise(r=>setTimeout(r,450));
      const dialog=[...document.querySelectorAll('dialog.dialog')].find(d=>d.open&&d.textContent?.includes('删除确认'));
      if(!dialog)return 'no-confirm-dialog';
      const confirm=[...dialog.querySelectorAll('button')].find(b=>b.textContent?.trim()==='确认删除');
      if(!confirm)return 'no-confirm-button';
      confirm.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:42,pointerType:'mouse',button:0}));
      await new Promise(r=>setTimeout(r,1100));
      confirm.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:42,pointerType:'mouse',button:0}));
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
      // The restore dialog defaults to the original parent and confirms there.
      const dialogReady=await new Promise(resolve=>{
        const deadline=Date.now()+15000;
        const timer=setInterval(()=>{
          const d=[...document.querySelectorAll('dialog.dialog')].find(x=>x.open&&x.textContent?.includes('恢复 —'));
          if(d&&d.textContent?.includes('确认恢复')){clearInterval(timer);resolve(d);}
          else if(Date.now()>deadline){clearInterval(timer);resolve(null);}
        },200);
      });
      if(!dialogReady)return 'no-restore-dialog';
      const confirm=[...dialogReady.querySelectorAll('button')].find(b=>b.textContent?.trim()==='确认恢复');
      if(!confirm)return 'no-confirm-button';
      confirm.click();
      await new Promise(r=>setTimeout(r,3000));
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
    // Logout is in the account menu, not a permanent standalone button.
    const accountOpened = await cdp.evaluate(`(()=>{
      const trigger=document.querySelector('button[aria-label="当前登录用户"]');
      trigger?.click();return !!trigger;
    })()`);
    if(accountOpened)await cdp.waitFor(`()=>Boolean(document.querySelector('[role="menu"][aria-label="账户操作菜单"]'))`,4000);
    const loggedOut = await cdp.evaluate(`(()=>{
      const menu=document.querySelector('[role="menu"][aria-label="账户操作菜单"]');
      const item=[...(menu?.querySelectorAll('[role="menuitem"]')??[])].find(b=>b.textContent?.includes('退出系统'));
      item?.click();return !!item;
    })()`);
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
      const secondary=(body.data?.items??[]).find(f=>f.name==='journey-batch-${stamp}.txt');
      if(secondary)await fetch('/api/files/'+secondary.id,{method:'DELETE',credentials:'same-origin'});
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
