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
 "--user-data-dir="+profile,"--window-size=1440,900","about:blank"],{stdio:"ignore"});
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
 const controls=await evalJS(`(()=>{const buttons=[...document.querySelectorAll('.cdw-rail-item')];
 const obligation=buttons.find(b=>b.textContent.includes('责任待办'));obligation?.click();
 const active=document.querySelector('.cdw-rail-item.is-current')?.textContent;
 const create=[...document.querySelectorAll('.cdw-inbox-actions button')].find(b=>b.textContent.includes('派发任务'));
 create?.click();
 return {active,createVisible:!!document.querySelector('.cdw-form'),headline:document.querySelector('.cdw-detail h2')?.textContent};
 })()`);
 assert.match(controls.active||"",/责任待办/);
 assert.equal(controls.createVisible,true,"admin should be able to open task creation form");
 assert.match(controls.headline||"",/派发单文件任务/);
 console.log("CDW_BROWSER_PASS auth=inbox, responsive=1440/1024/780, filter, create-form");
}finally{
 try{ws?.close();}catch{}
 chrome.kill("SIGTERM");
 rmSync(profile,{recursive:true,force:true});
}
