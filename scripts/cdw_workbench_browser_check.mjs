#!/usr/bin/env node
// Read-only authenticated Chrome geometry and navigation smoke for CDW.
// No tasks are created and no business document is edited.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {readFileSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";

const base=(process.argv[2]||"http://127.0.0.1:18091").replace(/\/+$/,"");
const password=readFileSync(process.argv[3]||".secrets/admin.password","utf8").trim();
const port=18000+process.pid%17000,profile=mkdtempSync(join(tmpdir(),"fm-cdw-browser-"));
const chrome=spawn("/usr/bin/google-chrome",[
 "--headless=new","--no-sandbox","--disable-dev-shm-usage","--remote-debugging-port="+port,
 "--user-data-dir="+profile,"--window-size=1440,900","about:blank"],{stdio:"ignore",detached:true});
let ws,sequence=0;
const pending=new Map();
function send(method,params={}){
 const id=++sequence;
 return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
}
async function evalJS(expression){
 const result=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
 if(result.exceptionDetails)throw Error("browser script exception: "+JSON.stringify(result.exceptionDetails).slice(0,280));
 return result.result.value;
}
async function until(expression){
 for(let i=0;i<90;i++){if(await evalJS(expression))return;await sleep(170);}
 throw Error("browser wait timeout: "+expression+"; got "+JSON.stringify(await evalJS("({route:location.pathname,html:document.body.innerText.slice(0,350)})")));
}
try{
 let tab;
 for(let i=0;i<70&&!tab;i++){
  try{tab=(await(await fetch("http://127.0.0.1:"+port+"/json/list")).json()).find(t=>t.type==="page");}catch{}
  if(!tab)await sleep(150);
 }
 assert.ok(tab,"Chrome debugger must be available");
 ws=new WebSocket(tab.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true});});
 ws.addEventListener("message",event=>{const message=JSON.parse(event.data),ticket=pending.get(message.id);
  if(ticket){pending.delete(message.id);message.error?ticket.reject(Error(message.error.message)):ticket.resolve(message.result);}
 });
 await send("Page.enable");await send("Runtime.enable");
 await send("Page.navigate",{url:base+"/login"});
 await until("location.pathname==='/login'");
 const login=await evalJS(`(async()=>{const res=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',
 body:JSON.stringify({login:'admin',password:${JSON.stringify(password)}})});return {status:res.status,ok:(await res.json()).ok}})()`);
 assert.equal(login.status,200,"isolated Chrome read-only admin login");
 assert.equal(login.ok,true,"admin credentials work");
 await send("Page.navigate",{url:base+"/workbench"});
 await until("location.pathname==='/workbench'&&!!document.querySelector('.cdw-layout')");
 await until("!document.querySelector('.cdw-message') && !!document.querySelector('.cdw-inbox-heading')");
 const inbox=await evalJS("(async()=>{const r=await fetch('/api/workbench/inbox?limit=5');return {status:r.status,data:(await r.json()).data}})()");
 assert.equal(inbox.status,200,"authenticated CDW inbox responds 200");
 assert.ok(Array.isArray(inbox.data?.items),"CDW inbox contains items array");
 const gates=await evalJS("(async()=>{const r=await fetch('/api/workbench/review-gates/inbox?limit=5');return {status:r.status,data:(await r.json()).data}})()");
 assert.equal(gates.status,200,"review gate inbox must authorize current session");
 assert.ok(Array.isArray(gates.data?.items),"review inbox must return items array");
 for(const width of [1440,1024,780]){
  await send("Emulation.setDeviceMetricsOverride",{width,height:850,deviceScaleFactor:1,mobile:false});
  await sleep(150);
  const layout=await evalJS(`(()=>{const body=document.documentElement;
   const outer=document.querySelector('.cdw-layout').getBoundingClientRect();
   const panes=['.cdw-rail','.cdw-inbox','.cdw-detail'].map(selector=>{
    const el=document.querySelector(selector),rect=el.getBoundingClientRect();
    return {selector,left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight};
   });
   return {viewport:innerWidth,bodyWidth:body.scrollWidth,layoutRight:outer.right,panes}
  })()`);
  assert.ok(layout.bodyWidth<=width+2,"horizontal page overflow at "+width+": "+JSON.stringify(layout));
  assert.ok(layout.panes.every(p=>p.right<=width+2&&p.left>=-2),"panes overflow at "+width+": "+JSON.stringify(layout));
  assert.ok(layout.panes.every(p=>p.bottom<=851),"panes extend below viewport at "+width);
  console.log("CDW_LAYOUT_PASS",width,layout.panes.map(p=>p.selector+":"+Math.round(p.right-p.left)).join(" "));
 }
 await evalJS("(()=>{const button=[...document.querySelectorAll('.cdw-rail-item')].find(b=>b.textContent.includes('待我验收'));button?.click();return true;})()");
 await until("document.querySelector('.cdw-rail-item.is-current')?.textContent?.includes('待我验收')");
 await evalJS("(()=>{const button=[...document.querySelectorAll('.cdw-rail-item')].find(b=>b.textContent.includes('责任待办'));button?.click();return true;})()");
 await until("document.querySelector('.cdw-rail-item.is-current')?.textContent?.includes('责任待办')");
 await evalJS("(()=>{const create=[...document.querySelectorAll('.cdw-inbox-actions button')].find(b=>b.textContent.includes('派发任务'));create?.click();return true;})()");
 await until("!!document.querySelector('.cdw-form') && document.querySelector('.cdw-detail h2')?.textContent?.includes('派发单文件任务')");
 const overrideControl="document.querySelector('.cdw-form-permission button[aria-pressed]')";
 await until(overrideControl+"?.getAttribute('aria-pressed')==='false'");
 await evalJS("(()=>{"+overrideControl+".click();return true})()");
 await until(overrideControl+"?.getAttribute('aria-pressed')==='true'");
 await evalJS("(()=>{"+overrideControl+".click();return true})()");
 await until(overrideControl+"?.getAttribute('aria-pressed')==='false'");
 console.log("CDW_G6_TEMPLATE_OPT_IN_BROWSER_PASS default=off toggles=on/off no-write");

 const formal=await evalJS("(async()=>{const r=await fetch('/api/workbench/formal-approvals/inbox?limit=5');return {status:r.status,data:(await r.json()).data}})()");
 assert.equal(formal.status,200,"G7 formal approval inbox authorizes admin session");
 assert.ok(Array.isArray(formal.data?.items),"G7 formal approval inbox is live");
 const ready=await evalJS("(async()=>{const r=await fetch('/api/workbench/formal-approvals/ready');return {status:r.status,data:(await r.json()).data}})()");
 assert.equal(ready.status,200,"G7 eligible frozen deliveries query is real");
 assert.ok(Array.isArray(ready.data?.items),"G7 frozen delivery candidates are an array");
 const controlled=await evalJS("(async()=>{const r=await fetch('/api/workbench/controlled/candidates');return {status:r.status,data:(await r.json()).data}})()");
 assert.equal(controlled.status,200,"G8 approved controlled candidates API authorizes admin session");
 assert.ok(Array.isArray(controlled.data?.items),"G8 approved candidate registry is live");

 await evalJS("(()=>{const button=[...document.querySelectorAll('.cdw-rail-item')].find(b=>b.textContent.includes('正式审批'));button?.click();return true;})()");
 await until("document.querySelector('.cdw-rail-item.is-current')?.textContent?.includes('正式审批')");
 assert.equal(await evalJS("[...document.querySelectorAll('.cdw-inbox-actions button')].some(b=>b.textContent.includes('发起审批'))"),true,
  "G7 formal approval initiation is an actionable navigation control");
 await evalJS("(()=>{const button=[...document.querySelectorAll('.cdw-inbox-actions button')].find(b=>b.textContent.includes('发起审批'));button?.click();return true;})()");
 await until("document.querySelector('.cdw-detail h2')?.textContent?.includes('从已验收交付稿发起')");
 assert.equal(await evalJS("!!document.querySelector('.cdw-form select, .cdw-form .rare-select')"),true,
  "G7 connects frozen delivery candidate selector");
 console.log("CDW_G7_FORMAL_BROWSER_PASS inbox+eligible-deliveries+initiation=live-no-write");

 await evalJS("(()=>{const button=[...document.querySelectorAll('.cdw-rail-item')].find(b=>b.textContent.includes('发行准备'));button?.click();return true;})()");
 await until("document.querySelector('.cdw-rail-item.is-current')?.textContent?.includes('发行准备')");
 assert.equal(await evalJS("[...document.querySelectorAll('.cdw-inbox-actions button')].some(b=>b.textContent.includes('派发任务'))"),false,
  "G8 release register must not display unrelated task-creation action");
 if(controlled.data.items.length){
  const found=await evalJS("(()=>{const node=document.querySelector('.cdw-task-row');node?.click();return !!node})()");
  assert.equal(found,true,"G8 real approved candidate selectable");
  await until("!!document.querySelector('.cdw-review-digest code')");
  const digest=await evalJS("document.querySelector('.cdw-review-digest code')?.textContent.trim()");
  assert.equal(digest.length,64,"G8 source SHA is rendered from approved immutable candidate");
 }
 const controlledLayout=await evalJS("({width:innerWidth,scrollWidth:document.documentElement.scrollWidth})");
 assert.ok(controlledLayout.scrollWidth<=controlledLayout.width+2,"G8 narrow canvas has no page overflow");
 console.log("CDW_G8_PREPARE_BROWSER_PASS candidate-registry+tab+live-source-sha=read-only");
 await evalJS("(()=>{const button=[...document.querySelectorAll('.cdw-rail-item')].find(b=>b.textContent.includes('责任待办'));button?.click();return true;})()");
 await until("document.querySelector('.cdw-rail-item.is-current')?.textContent?.includes('责任待办')");
 const obligations=await evalJS("(async()=>{const r=await fetch('/api/workbench/inbox?limit=100');return {status:r.status,data:(await r.json()).data}})()");
 assert.equal(obligations.status,200,"G11 obligation inbox must use real authenticated data");
 const obligationRows=obligations.data.items.filter(item=>item.kind==='obligation');
 const eligibleIndex=obligationRows.findIndex(item=>['manage','integrate','report'].includes(item.obligationKind));
 if(eligibleIndex>=0){
  await evalJS("(()=>{const node=[...document.querySelectorAll('.cdw-task-row')]["+eligibleIndex+"];node?.click()})()");
  await until("!!document.querySelector('.cdw-detail .cdw-review-form')");
  assert.equal(await evalJS("!!document.querySelector('.cdw-detail textarea')"),true,
   "G11 rendered live accountability statement input");
 }
 console.log("CDW_G11_ACCOUNTABILITY_BROWSER_PASS authenticated-inbox+real-obligation-form-when-present");
 console.log("CDW_BROWSER_PASS auth=tasks+review-inbox, responsive=1440/1024/780, review-filter, create-form");
}finally{
 try{ws?.close();}catch{}
 try{process.kill(-chrome.pid,"SIGTERM")}catch{chrome.kill("SIGTERM")}
 if(chrome.exitCode===null&&chrome.signalCode===null)await Promise.race([new Promise(resolve=>chrome.once("exit",resolve)),sleep(2400)]);
 for(let attempt=0;attempt<15;attempt++){
  try{rmSync(profile,{recursive:true,force:true,maxRetries:4,retryDelay:150});break;}
  catch(error){if(attempt===14)throw error;await sleep(270);}
 }
}
