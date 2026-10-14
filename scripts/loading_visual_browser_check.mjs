#!/usr/bin/env node
// Read-only remote Chrome regression: glyphs stay still, and a busy button
// keeps exactly the same outer geometry and high-contrast foreground.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";

const port=12000+process.pid%20000;
const profile=mkdtempSync(join(tmpdir(),"fm-loading-visual-"));
const chrome=spawn("/usr/bin/google-chrome",[
 "--headless=new","--no-sandbox","--disable-dev-shm-usage",
 "--remote-debugging-port="+port,"--user-data-dir="+profile,
 "--window-size=1440,900","about:blank",
],{stdio:"ignore"});
let ws,seq=0;
const pending=new Map();
function send(method,params={}){
 const id=++seq;
 return new Promise((resolve,reject)=>{
  pending.set(id,{resolve,reject});
  ws.send(JSON.stringify({id,method,params}));
 });
}
async function evaluate(expression){
 const r=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
 if(r.exceptionDetails)throw Error("Chrome evaluation: "+JSON.stringify(r.exceptionDetails).slice(0,380));
 return r.result.value;
}
const markup=String.raw`(()=>{
 const root=document.createElement("section");root.id="loading-visual-fixture";
 root.style.cssText="position:fixed;top:100px;left:12px;z-index:99999;background:white;padding:8px";
 const btn=document.createElement("button");btn.type="button";btn.id="loading-button-fixture";
 btn.className="rare-button primary";btn.dataset.rareControl="button";
 btn.dataset.rareTone="primary";btn.dataset.rareIntent="primary";
 btn.dataset.rareLoadable="true";btn.dataset.density="compact";
 btn.innerHTML='<span class="rare-button-content">保存</span>';
 root.append(btn);document.body.append(root);
 return true;
})()`;
const loaderMarkup=String.raw`(()=>{
 const button=document.querySelector("#loading-button-fixture");
 const old=button.getBoundingClientRect();
 button.dataset.rareLoading="true";button.disabled=true;
 button.querySelector(".rare-button-content").dataset.rareHidden="true";
 const pending=document.createElement("span");pending.className="rare-button-pending";
 pending.innerHTML='<span class="brand-loader" data-loader-size="xs" data-loader-decoration="true" aria-hidden="true"><span class="brand-loader-mark"><img class="brand-loader-ink" src="/assets/brand/logo-loader-256.png" alt=""><span class="brand-loader-mask"><span class="brand-loader-glow"></span></span></span><span class="brand-loader-caption"><span class="brand-loader-glyph" style="--glyph-order:0">加</span><span class="brand-loader-glyph" style="--glyph-order:1">载</span><span class="brand-loader-glyph" style="--glyph-order:2">中</span><span class="brand-loader-dots">...</span></span></span>';
 button.append(pending);window.__loadingOriginalRect={width:old.width,height:old.height};
 return true;
})()`;
const measure=String.raw`(()=>{
 const btn=document.querySelector("#loading-button-fixture"),loader=btn.querySelector(".brand-loader");
 const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height}};
 return {button:rect(btn),original:window.__loadingOriginalRect,
  glyphs:[...btn.querySelectorAll(".brand-loader-glyph")].map(e=>({rect:rect(e),transform:getComputedStyle(e).transform,filter:getComputedStyle(e).filter,opacity:getComputedStyle(e).opacity})),
  inkFilter:getComputedStyle(loader.querySelector(".brand-loader-ink")).filter,
  foreground:getComputedStyle(loader).color,
  documentWidth:document.documentElement.scrollWidth,viewport:innerWidth};
})()`;
try{
 let tab;
 for(let n=0;n<100&&!tab;n++){
  try{tab=(await(await fetch("http://127.0.0.1:"+port+"/json/list")).json()).find(t=>t.type==="page");}catch{}
  if(!tab)await sleep(120);
 }
 assert.ok(tab,"Chrome debugger unavailable");
 ws=new WebSocket(tab.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{
  ws.addEventListener("open",resolve,{once:true});
  ws.addEventListener("error",reject,{once:true});
 });
 ws.addEventListener("message",event=>{
  const m=JSON.parse(event.data),item=pending.get(m.id);
  if(!item)return;
  pending.delete(m.id);
  m.error?item.reject(Error(m.error.message)):item.resolve(m.result);
 });
 await send("Page.enable");await send("Runtime.enable");
 await send("Page.navigate",{url:"http://127.0.0.1:18091/login"});
 for(let n=0;n<100;n++){
  if(await evaluate("!!document.querySelector('.login-entry')&&!!document.styleSheets.length").catch(()=>false))break;
  await sleep(150);
 }
 await evaluate(markup);
 await evaluate(loaderMarkup);
 for(const width of [1440,820,390,320]){
  await send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
  await sleep(150);
  const start=await evaluate(measure);
  await sleep(260);
  const end=await evaluate(measure);
  assert.equal(start.glyphs.length,3,"three glyphs should animate independently");
  assert.ok(Math.abs(start.button.width-start.original.width)<.5,"button width changed on loading at "+width);
  assert.ok(Math.abs(start.button.height-start.original.height)<.5,"button height changed on loading at "+width);
  assert.ok(end.documentWidth<=end.viewport+2,"horizontal overflow at "+width);
  for(let i=0;i<3;i++){
   const a=start.glyphs[i],b=end.glyphs[i];
   assert.equal(a.transform,"none","glyph must not transform");
   assert.equal(a.filter,"none","glyph must not blur");
   for(const key of ["left","top","width","height"])
    assert.ok(Math.abs(a.rect[key]-b.rect[key])<.2,"glyph "+i+" jumped in "+key);
  }
  assert.equal(end.foreground,"rgb(255, 255, 255)","primary button loading text must be white");
  assert.match(end.inkFilter,/invert\(1\)/,"primary button logo must be white");
 }
 await send("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});
 await sleep(100);
 const reduced=await evaluate(measure);
 assert.ok(reduced.glyphs.every(g=>g.opacity==="1"),"reduced motion glyphs must be static and readable");
 console.log("LOADING_VISUAL_PASS: stationary glyphs, fixed button geometry, primary contrast, narrow layouts, reduced motion");
}finally{
 try{ws?.close()}catch{}
 chrome.kill("SIGTERM");
 await sleep(160);
 rmSync(profile,{recursive:true,force:true});
}
