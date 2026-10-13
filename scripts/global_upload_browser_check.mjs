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
 await waitFor("!!document.querySelector('dialog[open] .folder-picker-paged .folder-picker-tree [data-folder-id]')");
 const expandableRoot=await evaluate(`(async()=>{
  const result=await(await fetch('/api/folders/children?limit=50')).json();
  return result.data.items.find(item=>item.hasChildren)||null;
 })()`);
 assert.ok(expandableRoot,"fixture needs an expandable visible root for real folder-navigation regression");
 const rootButton=await evaluate(`(()=>{
  const li=[...document.querySelectorAll('dialog[open] .folder-picker-tree [data-folder-id]')]
    .find(row=>row.dataset.folderId===${JSON.stringify(expandableRoot.id)});
  const btn=li?.querySelector('.folder-picker-chevron');
  // The picker auto-expands a sole company root. Never toggle it twice
  // synchronously: React would read the same stale closure and leave it shut.
  if(btn?.getAttribute('aria-expanded')!=='true')btn?.click();
  return Boolean(btn);
 })()`);
 assert.ok(rootButton,"root folder must render an actionable expand control");
 const childPage=await evaluate(`(async()=>{
  const result=await(await fetch('/api/folders/children?parentId='+encodeURIComponent(${JSON.stringify(expandableRoot.id)})+'&limit=50')).json();
  return result.data.items;
 })()`);
 assert.ok(childPage.length>0,"expanded root must have visible children");
 const firstChild=childPage[0];
 await waitFor(`!![...document.querySelectorAll('dialog[open] .folder-picker-tree li[data-folder-id]')].find(
  row=>row.dataset.folderId===${JSON.stringify(firstChild.id)})`);
 await evaluate(`(()=>{
  const li=[...document.querySelectorAll('dialog[open] .folder-picker-tree li[data-folder-id]')]
    .find(row=>row.dataset.folderId===${JSON.stringify(firstChild.id)});
  li?.querySelector('.folder-picker-name')?.click();return true;
 })()`);
 assert.equal(await evaluate(`document.querySelector('dialog[open] .folder-picker-candidate-path')?.textContent?.includes(${JSON.stringify(firstChild.name)})`),Boolean(firstChild.canSelect),
  "an uploadable child must be selectable, without allowing non-uploadable folders");
 const searchTerm=firstChild.name.slice(0,Math.min(firstChild.name.length,12));
 await evaluate(`(()=>{
  const input=document.querySelector('dialog[open] .folder-picker-search');
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
  setter.call(input,${JSON.stringify(searchTerm)});input.dispatchEvent(new Event('input',{bubbles:true}));return true;
 })()`);
 await waitFor(`!![...document.querySelectorAll('dialog[open] .folder-picker-result-name')].find(
  node=>node.textContent?.includes(${JSON.stringify(searchTerm)}))`);
 const dialogBounds=await evaluate(`(()=>{
  const rect=document.querySelector('dialog[open]').getBoundingClientRect();
  return {left:rect.left,right:rect.right,viewport:innerWidth};
 })()`);
 assert.ok(dialogBounds.left>=0&&dialogBounds.right<=dialogBounds.viewport,"picker dialog must remain within viewport");
 await evaluate(`(()=>{document.querySelector('dialog[open] .dialog-close')?.click();return true;})()`);
 await waitFor("!document.querySelector('dialog[open]')");
 assert.equal(await evaluate("!!document.querySelector('.global-upload-overlay')"),false);
 console.log("PASS other page: paged root -> expandable children -> remote search -> cancel has no upload");

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
 // Wait for the resolved file list, not the explorer shell: the early loading
 // state correctly has no directory target and would open the picker.
 await waitFor("location.pathname==='/doc'&&!!document.querySelector('.work-body')");
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
  chrome.kill("SIGTERM");await Promise.race([ended,sleep(4000)]);
  if(chrome.exitCode===null){chrome.kill("SIGKILL");await sleep(500);}
 }
 // Chromium's crashpad can briefly retain a profile handle after the parent
 // exits. Cleanup cannot turn an otherwise passed functional assertion red.
 try{rmSync(profile,{recursive:true,force:true,maxRetries:30,retryDelay:200});}
 catch(error){if(error?.code!=="ENOTEMPTY"&&error?.code!=="EBUSY")throw error;}
 // Native WebSocket may retain its closing timer after the browser exits.
 // The process is a standalone CLI and all its assertions/cleanup are done.
 process.exit(process.exitCode??0);
}
