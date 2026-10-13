#!/usr/bin/env node
// Non-mutating, real-Chrome regression for authenticated global OS-file drag.
// All file drops that would need a destination are cancelled before enqueue.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {readFileSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";

const base=(process.argv[2]||"http://127.0.0.1:18091").replace(/\/+$/,"");
const password=readFileSync(process.argv[3]||".secrets/admin.password","utf8").trim();
const port=13000+process.pid%26000,profile=mkdtempSync(join(tmpdir(),"fm-global-drop-"));
const chrome=spawn("/usr/bin/google-chrome",[
 "--headless=new","--no-sandbox","--disable-dev-shm-usage",
 "--remote-debugging-port="+port,"--user-data-dir="+profile,"--window-size=1440,900","about:blank",
],{stdio:"ignore"});
let ws,id=0;
const pending=new Map();
function send(method,params={}){
 const key=++id;
 return new Promise((resolve,reject)=>{pending.set(key,{resolve,reject});ws.send(JSON.stringify({id:key,method,params}));});
}
async function evaluate(expression){
 const result=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
 if(result.exceptionDetails)throw Error("browser evaluation error: "+JSON.stringify(result.exceptionDetails).slice(0,240));
 return result.result.value;
}
async function waitFor(expression){
 for(let n=0;n<80;n++){if(await evaluate(expression))return;await sleep(150);}
 throw Error("browser state timeout: "+expression.slice(0,110));
}
const dropScript=(selector,type)=>`(()=>{
 const el=document.querySelector(${JSON.stringify(selector)})||document.body;
 const dt=new DataTransfer();
 if(${JSON.stringify(type)}==="internal")dt.setData("application/x-filesmanage-files","{}");
 else dt.items.add(new File(["test"],"global-drag-check.txt",{type:"text/plain"}));
 el.dispatchEvent(new DragEvent("dragenter",{bubbles:true,cancelable:true,dataTransfer:dt,clientX:60,clientY:100}));
 el.dispatchEvent(new DragEvent("dragover",{bubbles:true,cancelable:true,dataTransfer:dt,clientX:60,clientY:100}));
 return dt;
})()`;
try{
 let tab;
 for(let i=0;i<80&&!tab;i++){
  try{tab=(await(await fetch("http://127.0.0.1:"+port+"/json/list")).json()).find(t=>t.type==="page");}catch{}
  if(!tab)await sleep(125);
 }
 assert.ok(tab,"Chrome debugger startup timeout");
 ws=new WebSocket(tab.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true});});
 ws.addEventListener("message",event=>{
  const m=JSON.parse(event.data),task=pending.get(m.id);
  if(task){pending.delete(m.id);m.error?task.reject(Error(m.error.message)):task.resolve(m.result);}
 });
 await send("Page.enable");await send("Runtime.enable");
 await send("Page.navigate",{url:base+"/login"});
 await waitFor("location.pathname==='/login' && !!document.querySelector('body')");
 await evaluate(`(()=>{const dt=new DataTransfer();dt.items.add(new File(["x"],"login.txt"));document.body.dispatchEvent(new DragEvent("dragenter",{bubbles:true,dataTransfer:dt}));return true;})()`);
 assert.equal(await evaluate("!!document.querySelector('.global-upload-overlay')"),false,"login cannot accept dragged files");
 const login=await evaluate(`(async()=>{
  const res=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",
   body:JSON.stringify({login:"admin",password:${JSON.stringify(password)}})});
  return {status:res.status,ok:(await res.json()).ok};
 })()`);
 assert.equal(login.ok,true,"test login must succeed: "+JSON.stringify(login));
 await send("Page.navigate",{url:base+"/stats"});
 await waitFor("location.pathname==='/stats'&&!!document.querySelector('main')");
 await evaluate(`(()=>{window.__fmDrag=${dropScript("main","file")};return true;})()`);
 await waitFor("!!document.querySelector('.global-upload-overlay')");
 assert.match(await evaluate("document.querySelector('.global-upload-hint')?.textContent"),/选择目标文件夹/);
 await evaluate(`(()=>{document.querySelector("main").dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer:window.__fmDrag,clientX:60,clientY:100}));return true;})()`);
 await waitFor("!!document.querySelector('dialog[open]')");
 assert.match(await evaluate("document.querySelector('dialog[open]')?.textContent"),/选择上传位置/);
 await waitFor("!!document.querySelector('dialog[open] .folder-picker')||!!document.querySelector('dialog[open] .global-upload-pick-error')");
 await evaluate(`(()=>{document.querySelector('dialog[open] .dialog-close')?.click();return true;})()`);
 await waitFor("!document.querySelector('dialog[open]')");
 assert.equal(await evaluate("!!document.querySelector('.global-upload-overlay')"),false);
 console.log("PASS other page: drop prompts one target dialog, cancel has no upload");

 for(const width of [1440,1100,820]){
  await send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
  await evaluate(`(()=>{window.__fmDrag=${dropScript("main","file")};return true;})()`);
  await waitFor("!!document.querySelector('.global-upload-hint')");
  const bounds=await evaluate(`(()=>{const e=document.querySelector('.global-upload-hint')?.getBoundingClientRect();return e&&{left:e.left,right:e.right,viewport:innerWidth};})()`);
  assert.ok(bounds.left>=0&&bounds.right<=bounds.viewport,"overlay bounds at "+width);
  await evaluate(`(()=>{window.dispatchEvent(new Event("blur"));return true;})()`);
  await waitFor("!document.querySelector('.global-upload-overlay')");
 }
 console.log("PASS widths: 1440 / 1100 / 820 without overlay overflow");

 await send("Page.navigate",{url:base+"/doc"});
 await waitFor("location.pathname==='/doc'&&!!document.querySelector('.document-explorer')");
 await evaluate(`(()=>{window.__fmDrag=${dropScript(".work-body","file")};return true;})()`);
 await waitFor("!!document.querySelector('.global-upload-hint')");
 assert.match(await evaluate("document.querySelector('.global-upload-hint')?.textContent"),/上传至/);
 await evaluate("window.dispatchEvent(new Event('blur'))");
 await evaluate(`(()=>{const dt=new DataTransfer();dt.setData("application/x-filesmanage-files","{}");document.querySelector('.work-body')?.dispatchEvent(new DragEvent("dragenter",{bubbles:true,dataTransfer:dt}));return true;})()`);
 assert.equal(await evaluate("!!document.querySelector('.global-upload-overlay')"),false,"internal move cannot activate OS-upload overlay");
 console.log("PASS document view: resolved directory direct destination, internal move isolation");

 await send("Page.navigate",{url:base+"/doc?view=favorites"});
 await waitFor("location.search.includes('view=favorites')&&!!document.querySelector('.document-explorer')");
 await evaluate(`(()=>{window.__fmDrag=${dropScript("main","file")};return true;})()`);
 await waitFor("!!document.querySelector('.global-upload-hint')");
 assert.match(await evaluate("document.querySelector('.global-upload-hint')?.textContent"),/选择目标文件夹/);
 console.log("PASS favorites view: requires destination picker rather than a stale folder");
 console.log("GLOBAL_UPLOAD_BROWSER_PASS");
}catch(error){
 console.error("GLOBAL_UPLOAD_BROWSER_FAIL",error.message);
 process.exitCode=1;
}finally{
 ws?.close();
 if(chrome.exitCode===null){
  const ended=new Promise(resolve=>chrome.once("exit",resolve));
  chrome.kill("SIGTERM");await Promise.race([ended,sleep(1500)]);
 }
 rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:150});
}
