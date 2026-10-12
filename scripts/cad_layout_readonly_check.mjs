#!/usr/bin/env node
// Read-only Chrome layout regression against an existing STEP file.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {setTimeout as pause} from "node:timers/promises";
import {verifiedAdminSession} from "./qa_session.mjs";

const base="http://127.0.0.1:18091";
const {cookie}=await verifiedAdminSession(base);
const res=await fetch(base+"/api/search?q=ev.step&limit=30",{headers:{Cookie:cookie}});
assert.equal(res.status,200);
const item=(await res.json()).data.items.find(file=>file.name==="ev.step");
assert(item?.id,"Existing ev.step fixture required");
const dir=mkdtempSync("/root/.cache/filesmanage-build-tmp/cad-layout-");
const chrome=spawn("/usr/bin/google-chrome",[
 "--headless=new","--no-sandbox","--disable-dev-shm-usage",
 "--use-angle=swiftshader","--enable-unsafe-swiftshader",
 "--user-data-dir="+dir,"--remote-debugging-port=0",
 "--window-size=1680,900","about:blank"
],{stdio:"ignore"});
let ws,sequence=0;const waiting=new Map();
function send(method,params={}){
 return new Promise((resolve,reject)=>{
  const id=++sequence;waiting.set(id,{resolve,reject});
  ws.send(JSON.stringify({id,method,params}));
 });
}
async function evaluate(expression){
 const data=await send("Runtime.evaluate",{expression,returnByValue:true});
 if(data.exceptionDetails)throw Error("browser exception");
 return data.result.value;
}
async function until(expression){
 for(let i=0;i<200;i++){const result=await evaluate(expression);if(result)return result;await pause(150);}
 return null;
}
try{
 let target;
 for(let i=0;i<100&&!target;i++){
  await pause(150);
  try{
   const port=Number(readFileSync(join(dir,"DevToolsActivePort"),"utf8").split("\n")[0]);
   target=(await(await fetch("http://127.0.0.1:"+port+"/json/list")).json()).find(x=>x.type==="page");
  }catch{}
 }
 assert(target,"Chrome unavailable");
 ws=new WebSocket(target.webSocketDebuggerUrl);
 await new Promise(resolve=>ws.addEventListener("open",resolve,{once:true}));
 ws.addEventListener("message",event=>{
  const packet=JSON.parse(event.data),job=waiting.get(packet.id);
  if(job){waiting.delete(packet.id);packet.error?job.reject(Error(packet.error.message)):job.resolve(packet.result);}
 });
 await send("Page.enable");await send("Runtime.enable");await send("Network.enable");
 await send("Network.setCookie",{name:"fm_session",value:cookie.slice("fm_session=".length),url:base});
 await send("Page.navigate",{url:base+"/preview/"+item.id});
 assert(await until("Boolean(document.querySelector('.cad-compact-toolbar')&&document.querySelector('.cad-embedded canvas'))"),"CAD viewer not ready");
 for(const [width,height] of [[1680,900],[1280,800],[920,740],[680,700]]){
  await send("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
  await pause(350);
  const result=await evaluate(`(()=>{
   const box=el=>{const r=el?.getBoundingClientRect();return r?{top:r.top,bottom:r.bottom,right:r.right,width:r.width}:null};
   const inspector=document.querySelector('.cad-embedded .cad-inspector');
   const toggle=document.querySelector('.cad-inspector-toggle');
   return {dock:box(document.querySelector('.file-preview-action-dock')),
    toolbar:box(document.querySelector('.cad-compact-toolbar')),
    inspector:box(inspector),first:box(inspector?.querySelector('.cad-inspector-section')),
    visible:inspector&&getComputedStyle(inspector).display!=='none',
    toggle:toggle&&getComputedStyle(toggle).display!=='none',
    stage:box(document.querySelector('.cad-viewport')),
    overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth};
  })()`);
  assert(result.toolbar.right<=width+2&&result.stage.width>250&&result.overflow<=2,"CAD overflow "+width+" "+JSON.stringify(result));
  if(result.visible)assert(result.first.top>=result.dock.bottom-2,"Inspector overlap "+width);
  else assert(result.toggle,"Inspector toggle absent "+width);
  console.log("CAD_LAYOUT_PASS",width,height,JSON.stringify({canvas:result.stage.width,inspector:result.visible,toolbar:result.toolbar.width}));
 }
 console.log("CAD_LAYOUT_CHECK_PASS");
}catch(error){console.error("CAD_LAYOUT_CHECK_FAIL",error.message);process.exitCode=1;}
finally{
 try{ws?.close();}catch{}
 chrome.kill("SIGTERM");await pause(700);
 rmSync(dir,{recursive:true,force:true,maxRetries:4,retryDelay:100});
}
