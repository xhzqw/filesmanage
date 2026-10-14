#!/usr/bin/env node
// Read-only browser check for preview mode navigation and floating header geometry.
// Uses existing root files; never changes file contents, versions or metadata.
import {spawn} from "node:child_process";
import {readFileSync} from "node:fs";
import {setTimeout as delay} from "node:timers/promises";

const BASE=(process.argv[2]||"http://127.0.0.1:18091").replace(/\/+$/,"");
const PORT=9593;
const checks=[];
function assert(name,ok,detail=""){
 checks.push({name,ok:!!ok});
 console.log(`${ok?"PASS":"FAIL"} ${name}${detail?" :: "+detail:""}`);
}
class CDP{
 constructor(ws){
  this.ws=ws;this.nextId=1;this.pending=new Map();
  ws.addEventListener("message",event=>{
   const message=JSON.parse(event.data);
   if(message.id&&!this.pending.has(message.id))return;
   if(!message.id)return;
   const pending=this.pending.get(message.id);this.pending.delete(message.id);
   message.error?pending.reject(new Error(message.error.message)):pending.resolve(message.result);
  });
 }
 static async connect(url){
  const ws=new WebSocket(url);
  await new Promise((resolve,reject)=>{
   ws.addEventListener("open",resolve,{once:true});
   ws.addEventListener("error",reject,{once:true});
  });
  return new CDP(ws);
 }
 send(method,params={}){
  const id=this.nextId++;
  return new Promise((resolve,reject)=>{
   this.pending.set(id,{resolve,reject});
   this.ws.send(JSON.stringify({id,method,params}));
  });
 }
 async evaluate(expression){
  const result=await this.send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails).slice(0,400));
  return result.result.value;
 }
 async waitFor(expression,ms=16000){
  const expires=Date.now()+ms;
  while(Date.now()<expires){
   if(await this.evaluate(`(${expression})()`))return true;
   await delay(175);
  }
  return false;
 }
 close(){this.ws.close();}
}
const chrome=spawn("/usr/bin/google-chrome",[
 "--headless=new",`--remote-debugging-port=${PORT}`,"--no-sandbox",
 "--disable-dev-shm-usage","--window-size=1440,900","about:blank"
],{stdio:"ignore"});
let cdp;
try{
 const password=readFileSync(".secrets/admin.password","utf8").trim();
 const login=await fetch(BASE+"/api/login",{method:"POST",headers:{"Content-Type":"application/json"},
  body:JSON.stringify({login:"admin",password})});
 if(!login.ok)throw new Error("Login failed: "+login.status);
 const cookie=login.headers.getSetCookie().find(s=>s.startsWith("fm_session="))?.split(";")[0];
 if(!cookie)throw new Error("Session cookie missing");
 const listing=await fetch(BASE+"/api/files?folder=folder_root&limit=200",{headers:{Cookie:cookie}});
 if(!listing.ok)throw new Error("Root listing failed: "+listing.status);
 const files=(await listing.json()).data?.items??[];
 const txt=files.find(item=>item.name==="dropghped.txt"&&item.currentVersionSeq>=2)
  ??files.find(item=>item.name?.toLowerCase().endsWith(".txt")&&item.currentVersionSeq>=2);
 if(!txt)throw new Error("Need a root TXT file with 2+ versions");
 let target;
 for(let attempt=0;attempt<70&&!target;attempt++){
  await delay(130);
  try{target=(await(await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(page=>page.type==="page");}
  catch{}
 }
 if(!target)throw new Error("Chrome not available");
 cdp=await CDP.connect(target.webSocketDebuggerUrl);
 await cdp.send("Page.enable");
 await cdp.send("Runtime.enable");
 await cdp.send("Network.enable");
 await cdp.send("Network.setCookie",{
  name:"fm_session",value:cookie.slice("fm_session=".length),url:BASE
 });
 await cdp.send("Page.navigate",{url:BASE+"/preview/"+encodeURIComponent(txt.id)});
 assert("file preview loads",await cdp.waitFor(`()=>!!document.querySelector('.file-workbench-nav-item[aria-label="版本对比"]')`));
 await cdp.evaluate(`(()=>document.querySelector('.file-workbench-nav-item[aria-label="版本对比"]')?.click())()`);
 assert("version compare renders actual diff",await cdp.waitFor(`()=>!!document.querySelector('.file-compare-lines .file-diff-line')&&!!document.querySelector('.file-compare-toolbar .file-compare-controls')`));

 for(const {label,width,height} of [
  {label:"desktop",width:1440,height:900},
  {label:"laptop",width:1024,height:768},
  {label:"narrow",width:760,height:800}
 ]){
  await cdp.send("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
  await delay(220);
  const geometry=await cdp.evaluate(`(()=>{
   const main=document.querySelector('.file-workbench-main');
   const title=document.querySelector('.file-preview-identity');
   const dock=document.querySelector('.file-preview-action-dock .file-workbench-actions');
   const toolbar=document.querySelector('.file-compare-toolbar');
   const controls=[...document.querySelectorAll('.file-compare-controls button.rare-select')];
   if(!main||!title||!dock||!toolbar||controls.length!==2)return null;
   const rect=element=>element.getBoundingClientRect();
   const overlap=(a,b)=>a.left<b.right-1&&a.right>b.left+1&&a.top<b.bottom-1&&a.bottom>b.top+1;
   const rTitle=rect(title),rDock=rect(dock),rBar=rect(toolbar),rMain=rect(main);
   return {
    titleBottom:Math.round(rTitle.bottom),dockBottom:Math.round(rDock.bottom),toolbarTop:Math.round(rBar.top),
    mainWidth:Math.round(rMain.width),viewport:document.documentElement.clientWidth,
    rootOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+2,
    mainOverflow:main.scrollWidth>main.clientWidth+2,
    covered:overlap(rTitle,rBar)||overlap(rDock,rBar),
    selectorVisible:controls.every(control=>{
     const box=rect(control);
     const top=document.elementFromPoint(box.left+box.width/2,box.top+box.height/2);
     return box.width>30&&box.height>15&&!!top&&(top===control||control.contains(top));
    })
   };
  })()`);
  assert(label+" compare controls clear of floating title/actions",
   !!geometry&&!geometry.covered&&geometry.selectorVisible,
   JSON.stringify(geometry));
  assert(label+" has no root/main horizontal overflow",
   !!geometry&&!geometry.rootOverflow&&!geometry.mainOverflow,
   JSON.stringify(geometry));
 }
 await cdp.send("Emulation.clearDeviceMetricsOverride");
 await cdp.evaluate(`(()=>{
  const next=[...document.querySelectorAll('.file-compare-quicknav button')].find(button=>button.textContent?.includes('下一处'));
  const expand=[...document.querySelectorAll('.file-compare-quicknav button')].find(button=>button.textContent?.includes('显示全部行'));
  next?.click();
  expand?.click();
 })()`);
 const diffNav=await cdp.waitFor(`()=>!!document.querySelector('.file-diff-line.active-change')&&!!document.querySelector('.file-compare-quicknav button[aria-pressed="true"]')`);
 assert("diff next/expand actions respond",diffNav);

 await cdp.evaluate(`(()=>document.querySelector('.file-workbench-nav-item[aria-label="历史记录"]')?.click())()`);
 assert("history panel replaces comparison",await cdp.waitFor(`()=>!!document.querySelector('.file-workbench-history .file-history-switch')&&!document.querySelector('.file-compare-toolbar')`));
 const historyGeometry=await cdp.evaluate(`(()=>{
  const title=document.querySelector('.file-preview-identity')?.getBoundingClientRect();
  const switcher=document.querySelector('.file-history-switch')?.getBoundingClientRect();
  const versions=[...document.querySelectorAll('.file-history-switch button')].find(button=>button.textContent?.includes('内容版本'));
  versions?.click();
  return {top:Math.round(switcher?.top??0),titleBottom:Math.round(title?.bottom??0)};
 })()`);
 const recordsReady=await cdp.waitFor(`()=>document.querySelectorAll('.file-version-entry').length>=2`);
 assert("history controls are clear of title and version timeline works",
  historyGeometry.top>=historyGeometry.titleBottom&&recordsReady,JSON.stringify({...historyGeometry,recordsReady}));
 const video=files.find(item=>item.name?.toLowerCase().endsWith(".mp4"));
 if(video){
  await cdp.send("Page.navigate",{url:BASE+"/preview/"+encodeURIComponent(video.id)});
  const loaded=await cdp.waitFor(`()=>!!document.querySelector('.media-video-stage video')`);
  const videoActions=await cdp.evaluate(`(()=>{
   const buttons=[...document.querySelectorAll('.file-preview-action-dock .file-workbench-actions button')];
   return {print:buttons.some(button=>button.getAttribute('aria-label')==='打印'),download:buttons.some(button=>button.getAttribute('aria-label')==='下载')};
  })()`);
  assert("MP4 uses video preview without print action",loaded&&!videoActions.print&&videoActions.download,JSON.stringify(videoActions));
 }
 console.log(`RESULT ${checks.filter(check=>check.ok).length}/${checks.length} passed`);
 if(checks.some(check=>!check.ok))process.exitCode=1;
}catch(error){
 console.error("FAIL preview workbench browser regression:",error);
 process.exitCode=1;
}finally{
 cdp?.close();chrome.kill("SIGTERM");
}
