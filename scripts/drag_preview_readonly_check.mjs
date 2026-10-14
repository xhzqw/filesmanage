#!/usr/bin/env node
// Non-mutating UI check: simulated drag, hover and cancel. Never commits moves.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {readFileSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
const base=(process.argv[2]||"http://127.0.0.1:18092").replace(/\/+$/,"");
const password=readFileSync(process.argv[3]||".secrets/admin.password","utf8").trim();
const port=10000+process.pid%30000,profile=mkdtempSync(join(tmpdir(),"fm-drag-"));
const chrome=spawn("/usr/bin/google-chrome",["--headless=new","--no-sandbox","--disable-gpu","--user-data-dir="+profile,"--remote-debugging-port="+port,"--window-size=1280,850","about:blank"],{stdio:"ignore"});
let ws,id=0;const pending=new Map();
function send(method,params={}){
 const key=++id;
 return new Promise((resolve,reject)=>{pending.set(key,{resolve,reject});ws.send(JSON.stringify({id:key,method,params}));});
}
async function evaluate(expression){
 const result=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
 if(result.exceptionDetails)throw Error("browser evaluation error: "+JSON.stringify(result.exceptionDetails).slice(0,250));
 return result.result.value;
}
async function waitFor(expression){
 for(let n=0;n<100;n++){try{if(await evaluate(expression))return;}catch{}await sleep(140);}
 throw Error("browser state timeout: "+expression.slice(0,90));
}
try{
 let page;
 for(let n=0;n<90;n++){
  await sleep(130);
  try{const tabs=await(await fetch("http://127.0.0.1:"+port+"/json/list")).json();page=tabs.find(t=>t.type==="page");if(page)break;}catch{}
 }
 assert.ok(page,"Chrome CDP not ready");
 ws=new WebSocket(page.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true});});
 ws.addEventListener("message",ev=>{const data=JSON.parse(ev.data),task=pending.get(data.id);if(task){pending.delete(data.id);data.error?task.reject(Error(data.error.message)):task.resolve(data.result);}});
 await send("Page.enable");await send("Runtime.enable");await send("Page.navigate",{url:base+"/login"});
 await waitFor("!!document.querySelector('input[type=password]')");
 await evaluate("(()=>{const set=(e,v)=>{const f=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;f.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));};const a=[...document.querySelectorAll('input')];set(a.find(i=>i.type==='text'||i.type==='email'),'admin');set(a.find(i=>i.type==='password'),"+JSON.stringify(password)+");[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='登录')?.click();return true;})()");
 await waitFor("location.pathname==='/doc'");
 const folder=await evaluate("(async()=>{const t=(await(await fetch('/api/folders/tree')).json()).data||[];for(const f of t.slice(0,150)){const d=(await(await fetch('/api/files?folder='+encodeURIComponent(f.id)+'&limit=3')).json()).data;if((d?.items||[]).length>=2)return f.id;}return null;})()");
 assert.ok(folder,"No directory with >=2 test files");
 await send("Page.navigate",{url:base+"/doc?folder="+encodeURIComponent(folder)});
 await waitFor("document.querySelectorAll('tbody tr[data-id]').length>=2");
 const single=await evaluate("(()=>{const r=document.querySelector('tbody tr[data-id]'),dt=new DataTransfer();let ghost;Object.defineProperty(dt,'setDragImage',{value:el=>{ghost={text:el.textContent,parts:el.children.length};}});r.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dt}));window._d=dt;return {ghost,name:r.querySelector('.file-name')?.textContent,ids:JSON.parse(dt.getData('application/x-filesmanage-files')||'{\"ids\":[]}').ids.length};})()");
 assert.equal(single.ghost?.text,single.name);assert.equal(single.ghost.parts,1);assert.equal(single.ids,1);
 await waitFor("getComputedStyle(document.querySelector('tbody tr.drag-source .col-date')).visibility==='hidden'");
 const target=await evaluate("(()=>{const a=[...document.querySelectorAll('li[data-folder-id]>.tree-row')].find(r=>r.parentElement.dataset.folderId!=="+JSON.stringify(folder)+");if(!a)return null;a.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:window._d}));return a.parentElement.dataset.folderId;})()");
 assert.ok(target,"No visible alternate folder");
 await waitFor("!!document.querySelector('li[data-folder-id="+JSON.stringify(target)+"]>.tree-row.drop-accept .tree-drop-arrow')");
 await evaluate("(()=>{document.querySelector('tbody tr[data-id]').dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:window._d}));return true;})()");
 await waitFor("!document.querySelector('tbody tr.drag-source')&&!document.querySelector('.tree-row.drop-accept')");
 await evaluate("(()=>{const r=[...document.querySelectorAll('tbody tr[data-id]')];r[0].dispatchEvent(new MouseEvent('click',{bubbles:true}));r[1].dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}));return true;})()");
 await sleep(120);
 const multi=await evaluate("(()=>{const r=document.querySelector('tbody tr[data-id]'),dt=new DataTransfer();let ghost;Object.defineProperty(dt,'setDragImage',{value:el=>{ghost={text:el.textContent,count:el.querySelector('.file-drag-ghost-count')?.textContent,parts:el.children.length};}});r.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:dt}));const ids=JSON.parse(dt.getData('application/x-filesmanage-files')||'{\"ids\":[]}').ids;r.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:dt}));return {...ghost,ids:ids.length};})()");
 assert.equal(multi.ids,2);assert.equal(multi.count,"+1");assert.equal(multi.parts,2);
 console.log("DRAG_PREVIEW_READONLY_PASS: filename ghost, count badge, row reduction, target motion, cancel");
}catch(error){console.error("DRAG_PREVIEW_READONLY_FAIL",error.message);process.exitCode=1;
}finally{
 ws?.close();
 if(chrome.exitCode===null){
  const finished=new Promise(resolve=>chrome.once("exit",resolve));
  chrome.kill("SIGTERM");
  await Promise.race([finished,sleep(1500)]);
 }
 rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:150});
}
