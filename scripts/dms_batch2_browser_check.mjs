#!/usr/bin/env node
// Read-only DMS batch-two UI regression against the remote dev server.
// Three viewport sizes; no metadata modifications, no fixture creation.
import {spawn} from "node:child_process";
import {setTimeout as sleep} from "node:timers/promises";
import {mkdirSync,writeFileSync} from "node:fs";
import {verifiedAdminSession} from "./qa_session.mjs";

const base="http://127.0.0.1:18091",port=9398;
const dir="/root/filesmanage/.validation/dms-batch2-visual";
function check(ok,label,details=""){
 console.log((ok?"PASS ":"FAIL ")+label+(details?" "+details:""));
 if(!ok)throw new Error(label);
}
class CDP{
 constructor(ws){
  this.ws=ws;this.sequence=0;this.pending=new Map();
  ws.addEventListener("message",event=>{
   const msg=JSON.parse(event.data);
   if(this.pending.has(msg.id)){
    const {resolve,reject}=this.pending.get(msg.id);this.pending.delete(msg.id);
    msg.error?reject(new Error(msg.error.message)):resolve(msg.result);
   }
  });
 }
 static async connect(url){
  const socket=new WebSocket(url);
  await new Promise((resolve,reject)=>{socket.addEventListener("open",resolve,{once:true});socket.addEventListener("error",reject,{once:true});});
  return new CDP(socket);
 }
 send(method,params={}){
  const id=++this.sequence;
  return new Promise((resolve,reject)=>{
   this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));
  });
 }
 async evaluate(expression){
  const data=await this.send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
  if(data.exceptionDetails)throw new Error("browser evaluation failed");
  return data.result.value;
 }
 async navigate(url){await this.send("Page.navigate",{url});await sleep(600);}
 async waitFor(predicate,timeout=15000){
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await this.evaluate("("+predicate+")()"))return true;await sleep(200);}
  return false;
 }
 close(){this.ws.close();}
}
const chrome=spawn("/usr/bin/google-chrome",[
 "--headless=new","--no-sandbox","--disable-dev-shm-usage",
 "--remote-debugging-port="+port,"--window-size=1920,1080","about:blank",
],{stdio:"ignore"});
let cdp;
try{
 const session=await verifiedAdminSession(base);
 const raw=await fetch(base+"/api/search?limit=1",{headers:{Cookie:session.cookie}});
 check(raw.ok,"sample search authorized");
 const files=(await raw.json()).data?.items??[];
 check(files.length>0,"at least one file available for read-only UI check");
 const fileId=files[0].id;
 let target;
 for(let i=0;i<55&&!target;i++){
  await sleep(200);
  try{
   const list=await (await fetch("http://127.0.0.1:"+port+"/json/list")).json();
   target=list.find(x=>x.type==="page");
  }catch{}
 }
 check(Boolean(target),"headless Chrome available");
 cdp=await CDP.connect(target.webSocketDebuggerUrl);
 await cdp.send("Page.enable");
 await cdp.send("Runtime.enable");
 await cdp.send("Network.enable");
 await cdp.send("Network.setCookie",{
  name:"fm_session",value:session.cookie.slice("fm_session=".length),
  domain:"127.0.0.1",path:"/",httpOnly:true,sameSite:"Strict",
 });
 mkdirSync(dir,{recursive:true});
 for(const viewport of [{name:"wide",width:1920,height:1080},{name:"desktop",width:1366,height:768},{name:"narrow",width:720,height:900}]){
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:viewport.width,height:viewport.height,deviceScaleFactor:1,mobile:false});
  await cdp.navigate(base+"/preview/"+encodeURIComponent(fileId));
  check(await cdp.waitFor("()=>!!document.querySelector('#file-tab-details')"),viewport.name+" file workbench loaded");
  await cdp.evaluate("(()=>{document.querySelector('#file-tab-details').click();return true;})()");
  check(await cdp.waitFor("()=>!!document.querySelector('.file-metadata-summary')"),viewport.name+" metadata view loaded");
  const meta=await cdp.evaluate("(()=>({section:!!document.querySelector('.file-metadata-section'),edit:!!document.querySelector('.file-metadata-bar button'),overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth}))()");
  check(meta.section&&meta.edit&&meta.overflow<=1,viewport.name+" metadata editor geometry",JSON.stringify(meta));
  const shot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  writeFileSync(dir+"/"+viewport.name+"-metadata.png",Buffer.from(shot.data,"base64"));
  await cdp.navigate(base+"/search");
  check(await cdp.waitFor("()=>!!document.querySelector('#search-category')&&!!document.querySelector('#search-tag')"),viewport.name+" classification search controls");
  const searchOverflow=await cdp.evaluate("(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)()");
  check(searchOverflow<=1,viewport.name+" search without horizontal overflow","overflow="+searchOverflow);
  await cdp.navigate(base+"/org?tab=permissions&view=document-audit");
  check(await cdp.waitFor("()=>!!document.querySelector('.document-activity .perm-audit-scroll')"),viewport.name+" document audit page loaded");
  const audit=await cdp.evaluate("(()=>({nav:!![...document.querySelectorAll('.perm-subnav button')].find(b=>b.textContent?.includes('文档活动审计')&&b.getAttribute('aria-current')==='page'),overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,filterCount:document.querySelectorAll('.document-audit-filter input').length}))()");
  check(audit.nav&&audit.filterCount===3&&audit.overflow<=1,viewport.name+" document audit geometry",JSON.stringify(audit));
  const auditShot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  writeFileSync(dir+"/"+viewport.name+"-audit.png",Buffer.from(auditShot.data,"base64"));
 }
 console.log("DMS_BATCH2_BROWSER_PASS");
}finally{
 cdp?.close();chrome.kill();
}
