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
 for(const vp of [{name:"wide",w:2048,h:900},{name:"desktop",w:1366,h:768},{name:"narrow",w:720,h:900}]){
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
  // Verify actual API names reach the Finder labels, including folder
  // favorites. The DB query coalesces file and folder names independently;
  // checking for a rendered row alone misses empty folder labels.
  const sidebarNames=await cdp.evaluate(`(async()=>{
   const response=await fetch("/api/favorites?view=sidebar",{cache:"no-store"});
   const json=await response.json();
   const rows=json.data?.items||[];
   return {ok:response.ok&&json.ok,count:rows.length,
    folderCount:rows.filter(row=>row.kind==="folder").length,
    named:rows.every(row=>typeof row.resourceName==="string"&&row.resourceName.trim().length>0),
    matches:rows.every(row=>{
     const id=row.kind==="folder"?row.folderId:row.fileId;
     const href=row.kind==="folder"?"/doc?folder="+encodeURIComponent(id):"/preview/"+encodeURIComponent(id);
     const link=[...document.querySelectorAll(".finder-favorite-item")].find(node=>node.getAttribute("href")===href);
     return link&&link.title===row.resourceName&&link.querySelector("span")?.textContent?.trim()===row.resourceName;
    })};
  })()`);
  check(sidebarNames.ok&&sidebarNames.count>0&&sidebarNames.folderCount>0&&sidebarNames.named&&sidebarNames.matches,
   vp.name+" sidebar folder and file favorite names match API",JSON.stringify(sidebarNames));
  check(layout.beside&&layout.mainVisible&&layout.rightInside,vp.name+" responsive workbench",JSON.stringify(layout));
  check(layout.overflow<=1,vp.name+" no document horizontal overflow",JSON.stringify(layout));
  check(layout.tones&&layout.allBadUnlinked,vp.name+" status badges and invalid links",JSON.stringify(layout));
  const chromeGeometry=await cdp.evaluate(`(()=>{
   const rect=selector=>document.querySelector(selector)?.getBoundingClientRect();
   const head=rect('.collab-results-head'),create=rect('.collab-create-action'),
    search=rect('.collab-filter-controls input[type=search]'),
    tools=rect('.collab-filter-controls'),table=rect('.collab-resource-table'),
    panel=rect('.collab-results'),side=rect('.finder-sidebar');
   const inside=r=>r&&r.width>0&&r.left>=-1&&r.right<=innerWidth+1;
   return {createAtStart:!!head&&!!create&&Math.abs(create.left-head.left)<=20,
    searchVisible:inside(search),toolsVisible:inside(tools),tableInside:!!table&&!!panel&&table.right<=panel.right+2,
    sidebarSized:!!side&&(innerWidth<=700||side.width>=180),
    createLeft:create?.left,headLeft:head?.left,searchRight:search?.right,tableRight:table?.right,
    panelRight:panel?.right,sidebarWidth:side?.width};
  })()`);
  check(chromeGeometry.createAtStart&&chromeGeometry.searchVisible&&chromeGeometry.toolsVisible&&chromeGeometry.tableInside&&chromeGeometry.sidebarSized,
   vp.name+" actual toolbar alignment, sidebar and table bounds",JSON.stringify(chromeGeometry));
  check(await cdp.evaluate("(()=>!!document.querySelector('.collab-filter-controls input[type=search]')&&!!document.querySelector('[aria-label=\"资源显示方式\"]')&&!!document.querySelector('.collab-resource-table'))()"),
   vp.name+" unified Finder commands and resource rows");
  await cdp.evaluate("(()=>{document.querySelector('[aria-label=\"资源显示方式\"] button[aria-label=\"图标视图\"]')?.click();return true;})()");
  check(await cdp.waitFor("()=>!!document.querySelector('.collab-visual .explorer-icon-grid')"),vp.name+" icon scope render");
  await cdp.evaluate("(()=>{document.querySelector('[aria-label=\"资源显示方式\"] button[aria-label=\"分栏视图\"]')?.click();return true;})()");
  check(await cdp.waitFor("()=>!!document.querySelector('.collab-visual .explorer-columns .collab-resource-detail')"),vp.name+" columns scope detail");
  await cdp.evaluate("(()=>{document.querySelector('[aria-label=\"资源显示方式\"] button[aria-label=\"画廊视图\"]')?.click();return true;})()");
  check(await cdp.waitFor("()=>!!document.querySelector('.collab-visual .explorer-gallery')"),vp.name+" gallery scope render");
  await cdp.evaluate("(()=>{document.querySelector('[aria-label=\"资源显示方式\"] button[aria-label=\"列表视图\"]')?.click();return true;})()");
  check(await cdp.waitFor("()=>!!document.querySelector('.collab-resource-table')"),vp.name+" list scope restored");
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
 await cdp.evaluate("(()=>{document.querySelector('.finder-nav-item[href=\"/doc?view=received\"]')?.click();return true;})()");
 check(await cdp.waitFor("()=>document.querySelector('.collab-results-head strong')?.textContent==='与我共享' && !!document.querySelector('.collab-filter-controls')"),"received shares reuse Finder browser");
 check(await cdp.waitFor("()=>document.querySelector('.collab-results-count')?.textContent?.includes('已加载')"),"received shares finished loading");
 const received=await cdp.evaluate(`(()=>{
  const head=document.querySelector('.collab-results-head')?.getBoundingClientRect();
  const tools=document.querySelector('.collab-filter-controls')?.getBoundingClientRect();
  const count=document.querySelector('.collab-results-count')?.getBoundingClientRect();
  const empty=document.querySelector('.collab-empty-state');
  return {noCreate:!document.querySelector('.collab-create-action'),
   controlsInside:!!head&&!!tools&&tools.left>=head.left&&tools.right<=head.right+2,
   countAtStart:!!head&&!!count&&count.left<=head.left+20,
   noEmptyTableHeaders:!empty||!document.querySelector('.collab-resource-table thead'),
   emptyState:empty?.textContent?.trim()||''};
 })()`);
 check(received.noCreate&&received.controlsInside&&received.countAtStart&&received.noEmptyTableHeaders,
  "received scope without create action, centered empty state or old table",JSON.stringify(received));
 console.log("COLLABORATION_BROWSER_CHECK_PASS");
}finally{
 cdp?.close();chrome.kill();
}
