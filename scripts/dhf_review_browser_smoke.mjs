#!/usr/bin/env node
// Non-mutating, credential-free acceptance for an isolated DHF review deploy.
// Verifies real HTTP, the rendered React login, three viewport configurations
// and denial of unauthenticated Gate/conditional-planning endpoints.
// Usage: node scripts/dhf_review_browser_smoke.mjs http://127.0.0.1:18095
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";

const BASE=(process.argv[2]??"http://127.0.0.1:18095").replace(/\/+$/,"");
const destination=new URL(BASE);
assert.equal(destination.protocol,"http:","QA smoke requires private HTTP review instance");
assert.ok(["127.0.0.1","localhost"].includes(destination.hostname),
 "Browser smoke must run on target machine loopback, never against a public service");
const health=await fetch(BASE+"/health/ready");
assert.equal(health.status,200,"isolated review backend readiness");
assert.equal((await health.json()).ok,true);
for(const route of [
 "/api/workbench/dhf/conditional-plans",
 "/api/workbench/dhf/gate-decision-reviews",
 "/api/workbench/dhf/gates/fixture-unknown/readiness",
]){
 const response=await fetch(BASE+route,{redirect:"manual"});
 assert.equal(response.status,401,"unauthenticated Gate endpoint should deny "+route);
}
const html=await(await fetch(BASE+"/login")).text();
const asset=html.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1];
assert.ok(asset,"real current Vite index asset path");
assert.equal((await fetch(BASE+asset)).status,200,"current release JS asset served");

const PORT=17000+process.pid%18000;
const profile=mkdtempSync(join(tmpdir(),"fm-dhf-review-browser-"));
const chrome=spawn("/usr/bin/google-chrome",[
 "--headless=new","--no-sandbox","--disable-dev-shm-usage",
 "--remote-debugging-port="+PORT,"--user-data-dir="+profile,
 "--window-size=1440,900","about:blank"
],{stdio:"ignore"});
let ws;
let seq=0;
const pending=new Map();
const exceptions=[];
function send(method,params={}){
 const id=++seq;
 return new Promise((resolve,reject)=>{
  pending.set(id,{resolve,reject});
  ws.send(JSON.stringify({id,method,params}));
 });
}
async function evaluate(expression){
 const reply=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
 if(reply.exceptionDetails)throw Error("Chrome evaluation failed");
 return reply.result.value;
}
try{
 let target;
 for(let n=0;n<75&&!target;n++){
  try{target=(await(await fetch("http://127.0.0.1:"+PORT+"/json/list")).json()).find(x=>x.type==="page");}
  catch{}
  if(!target)await sleep(180);
 }
 assert.ok(target,"isolated Chromium debugger started");
 ws=new WebSocket(target.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{
  ws.addEventListener("open",resolve,{once:true});
  ws.addEventListener("error",reject,{once:true});
 });
 ws.addEventListener("message",event=>{
  const result=JSON.parse(event.data);
  if(result.method==="Runtime.exceptionThrown")
   exceptions.push(String(result.params?.exceptionDetails?.text??"runtime exception"));
  const item=pending.get(result.id);
  if(!item)return;
  pending.delete(result.id);
  result.error?item.reject(Error(result.error.message)):item.resolve(result.result);
 });
 await send("Page.enable");
 await send("Runtime.enable");
 await send("Page.navigate",{url:BASE+"/login"});
 let loginLoaded=false;
 for(let n=0;n<65&&!loginLoaded;n++){
  loginLoaded=await evaluate("Boolean(document.querySelector('input[type=password]'))").catch(()=>false);
  if(!loginLoaded)await sleep(180);
 }
 assert.ok(loginLoaded,"React login screen actually rendered");
 for(const width of [1440,1024,760,390]){
  await send("Emulation.setDeviceMetricsOverride",{
   width,height:900,deviceScaleFactor:1,mobile:false
  });
  await sleep(170);
  const metrics=await evaluate(`(()=>{
   const password=document.querySelector('input[type=password]');
   const rect=password?.getBoundingClientRect();
   return {viewport:innerWidth,document:document.documentElement.scrollWidth,
    fieldPresent:!!password,fieldWidth:rect?.width??0,
    fieldVisible:!!rect&&rect.width>0&&rect.height>0&&rect.left>=0&&rect.right<=innerWidth+2};
  })()`);
  assert.ok(metrics.fieldPresent&&metrics.fieldVisible,
   "visible login field at "+width+": "+JSON.stringify(metrics));
  assert.ok(metrics.document<=metrics.viewport+2,
   "horizontal document overflow at "+width+": "+JSON.stringify(metrics));
 }
 await send("Emulation.setEmulatedMedia",{
  features:[{name:"prefers-reduced-motion",value:"reduce"}]
 });
 assert.equal(await evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"),true);
 assert.deepEqual(exceptions,[],"no uncaught errors during browser startup");
 console.log("DHF_REVIEW_BROWSER_PASS 1440/1024/760/390; assets, ready, unauth-denial, React, reduced motion");
}finally{
 try{ws?.close()}catch{}
 chrome.kill("SIGTERM");
 await sleep(180);
 rmSync(profile,{recursive:true,force:true});
}
