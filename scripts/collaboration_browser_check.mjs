#!/usr/bin/env node
// Read-only collaboration regression for the remote dev service.
// Verifies desktop split, narrow stacked layout, semantic state, and
// unclickable unavailable entries without mutating any user data.
import {spawn} from "node:child_process";
import {setTimeout as sleep} from "node:timers/promises";
import {mkdirSync,writeFileSync} from "node:fs";
import {verifiedAdminSession} from "./qa_session.mjs";

const BASE="http://127.0.0.1:18091",PORT=9397;
const SHOTS="/root/repository77/.validation/collaboration-visual";
const check=(ok,description,details="")=>{
 console.log((ok?"PASS ":"FAIL ")+description+(details?" "+details:""));
 if(!ok)throw new Error(description);
};
class CDP {
 constructor(socket){
  this.ws=socket;this.id=0;this.pending=new Map();
  socket.addEventListener("message",event=>{
   const msg=JSON.parse(event.data);
   if(this.pending.has(msg.id)){
    const {resolve,reject}=this.pending.get(msg.id);this.pending.delete(msg.id);
    msg.error?reject(new Error(msg.error.message)):resolve(msg.result);
   }
  });
 }
 static async connect(url){
  const ws=new WebSocket(url);
  await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true});});
  return new CDP(ws);
 }
 send(method,params={}){
  const id=++this.id;
  return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));});
 }
 async evaluate(expression){
  const result=await this.send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails)throw new Error("browser evaluate failed");
  return result.result.value;
 }
 async navigate(url){await this.send("Page.navigate",{url});await sleep(650);}
 async waitFor(predicate,timeout=15000){
  const until=Date.now()+timeout;
  while(Date.now()<until){if(await this.evaluate("("+predicate+")()"))return true;await sleep(200);}
  return false;
 }
 close(){this.ws.close();}
}
const chrome=spawn("/usr/bin/google-chrome",[
 "--headless=new","--no-sandbox","--disable-dev-shm-usage",
 "--remote-debugging-port="+PORT,"--window-size=1920,1080","about:blank",
],{stdio:"ignore"});
let cdp;
try{
 const session=await verifiedAdminSession(BASE);
 let target;
 for(let i=0;i<55&&!target;i++){
  await sleep(200);
  try{
   const list=await (await fetch("http://127.0.0.1:"+PORT+"/json/list")).json();
   target=list.find(x=>x.type==="page");
  }catch{}
 }
 check(!!target,"Chrome/CDP available");
 cdp=await CDP.connect(target.webSocketDebuggerUrl);
 await cdp.send("Page.enable");
 await cdp.send("Runtime.enable");
 await cdp.send("Network.enable");
 await cdp.send("Network.setCookie",{
  name:"fm_session",value:session.cookie.slice("fm_session=".length),
  domain:"127.0.0.1",path:"/",httpOnly:true,sameSite:"Strict",
 });
 mkdirSync(SHOTS,{recursive:true});
 for(const vp of [{name:"wide",w:1920,h:1080},{name:"desktop",w:1366,h:768},{name:"narrow",w:720,h:900}]){
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:vp.w,height:vp.h,deviceScaleFactor:1,mobile:false});
  await cdp.navigate(BASE+"/doc?view=favorites");
  check(await cdp.waitFor("()=>!!document.querySelector('.collab-workspace .collab-results') && !!document.querySelector('.finder-sidebar') && document.querySelectorAll('.collab-results tbody .rare-badge').length>0"),vp.name+" favorites render");
  const layout=await cdp.evaluate(`(()=>{
   const first=document.querySelector('.finder-nav-item[href="/doc?view=favorites"]');
   const left=document.querySelector('.finder-sidebar')?.getBoundingClientRect();
   const right=document.querySelector('.collab-workspace .collab-results')?.getBoundingClientRect();
   const bad=[...document.querySelectorAll('.collab-results tbody tr')].filter(row=>row.querySelector('.rare-badge[data-rare-badge-tone=danger]'));
   const allBadUnlinked=bad.every(row=>!row.querySelector('td:first-child a'));
   const badges=[...document.querySelectorAll('.collab-results tbody .rare-badge')];
   return {first:first?.textContent?.trim(),selected:first?.getAttribute('aria-current'),
    beside:left.right<=right.left+3,mainVisible:right.top<innerHeight-80,
    rightInside:right.right<=innerWidth+1,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
    count:badges.length,tones:badges.every(b=>['success','danger'].includes(b.dataset.rareBadgeTone)&&b.textContent.trim()),
    badCount:bad.length,allBadUnlinked};
  })()`);
  check(layout.first==="我的关注"&&layout.selected==="page",vp.name+" 关注 in Finder sidebar");
  check(layout.beside&&layout.mainVisible&&layout.rightInside,vp.name+" responsive workbench",JSON.stringify(layout));
  check(layout.overflow<=1,vp.name+" no document horizontal overflow",JSON.stringify(layout));
  check(layout.tones&&layout.allBadUnlinked,vp.name+" status badges and invalid links",JSON.stringify(layout));
  const shot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  writeFileSync(SHOTS+"/"+vp.name+".png",Buffer.from(shot.data,"base64"));
  await cdp.evaluate(`(()=>{document.querySelector('.collab-create-action')?.click();return true;})()`);
  check(await cdp.waitFor("()=>!!document.querySelector('.share-workbench')"),vp.name+" resource picker opens on demand");
  await cdp.evaluate(`(()=>{[...document.querySelectorAll('.share-kind-switch button')].find(b=>b.textContent.trim()==='文件')?.click();return true;})()`);
  check(await cdp.waitFor("()=>!!document.querySelector('[aria-label=\"选择文件所在目录\"]')"),vp.name+" file selector opens");
 }
 // Switching tabs and reading page data must not navigate away.
 await cdp.evaluate(`(()=>{document.querySelector('.finder-nav-item[href="/doc?view=sent"]')?.click();return true;})()`);
 check(await cdp.waitFor("()=>document.querySelector('.collab-results-head strong')?.textContent==='我共享的' && document.querySelector('.collab-results-count')?.textContent?.includes('已加载')"),"sent shares page reads");
 check(await cdp.evaluate("(()=>location.pathname==='/doc' && new URLSearchParams(location.search).get('view')==='sent')()"),"shared view stays in documents");
 console.log("COLLABORATION_BROWSER_CHECK_PASS");
}finally{
 cdp?.close();chrome.kill();
}
