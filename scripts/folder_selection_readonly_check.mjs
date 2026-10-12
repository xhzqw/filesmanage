#!/usr/bin/env node
// Non-mutating Chrome check for the document explorer's selected folder.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {readFileSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
const base=(process.argv[2]||"http://127.0.0.1:18091").replace(/\/+$/,"");
const password=readFileSync(process.argv[3]||".secrets/admin.password","utf8").trim();
const port=10000+process.pid%30000,profile=mkdtempSync(join(tmpdir(),"fm-selected-"));
const chrome=spawn("/usr/bin/google-chrome",["--headless=new","--no-sandbox","--disable-gpu","--remote-debugging-port="+port,"--user-data-dir="+profile,"--window-size=1440,850","about:blank"],{stdio:"ignore"});
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
 for(let n=0;n<110;n++){try{if(await evaluate(expression))return;}catch{}await sleep(130);}
 throw Error("browser state timeout: "+expression.slice(0,110));
}
try{
 let page;
 for(let n=0;n<90;n++){await sleep(130);try{const t=await(await fetch("http://127.0.0.1:"+port+"/json/list")).json();page=t.find(x=>x.type==="page");if(page)break;}catch{}}
 assert.ok(page,"Chrome CDP not ready");
 ws=new WebSocket(page.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true});});
 ws.addEventListener("message",ev=>{const data=JSON.parse(ev.data),task=pending.get(data.id);if(task){pending.delete(data.id);data.error?task.reject(Error(data.error.message)):task.resolve(data.result);}});
 await send("Page.enable");await send("Runtime.enable");await send("Page.navigate",{url:base+"/login"});
 await waitFor("!!document.querySelector('input[type=password]')");
 await evaluate("(()=>{const set=(e,v)=>{const f=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;f.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));};const a=[...document.querySelectorAll('input')];set(a.find(i=>i.type==='text'||i.type==='email'),'admin');set(a.find(i=>i.type==='password'),"+JSON.stringify(password)+");[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='登录')?.click();return true;})()");
 await waitFor("location.pathname==='/doc'&&!!document.querySelector('.sidebar .tree')");
 await evaluate("(()=>{const rows=[...document.querySelectorAll('.sidebar .tree li[data-folder-id]>.tree-row')];rows.find(r=>!r.classList.contains('on'))?.click();return true;})()");
 await waitFor("!!document.querySelector('.sidebar .tree li[aria-current=\"page\"]>.tree-row')");
 for(const width of [1440,1024,760,390]){
  await send("Emulation.setDeviceMetricsOverride",{width,height:850,deviceScaleFactor:1,mobile:false});
  await sleep(150);
  const state=await evaluate("(()=>{const r=document.querySelector('.sidebar .tree li[aria-current=\"page\"]>.tree-row');if(!r)return null;const s=getComputedStyle(r),b=r.getBoundingClientRect(),side=document.querySelector('.sidebar').getBoundingClientRect();return {name:r.querySelector('.tree-node-link')?.textContent?.trim(),shadow:s.boxShadow,rail:document.querySelectorAll('.sidebar .spring-rail,.sidebar .spring-rail-host').length,pseudo:getComputedStyle(r,'::before').display,radius:parseFloat(s.borderTopLeftRadius),width:b.width,sideWidth:side.width,overflow:document.documentElement.scrollWidth-innerWidth};})()");
  assert.ok(state,"selected row not found at "+width);
  assert.equal(state.rail,0,"duplicated left rail at "+width);
  assert.equal(state.shadow,"none","extra selected stroke at "+width);
  assert.equal(state.pseudo,"none","pseudo selected rail at "+width);
  assert.ok(state.radius>=4,"selected row is square at "+width);
  assert.ok(state.width<=state.sideWidth+1,"selected row exceeds sidebar at "+width);
  assert.ok(state.name,"selected node has no name");
  console.log("FOLDER_SELECTION_SIZE_PASS",width+"px",state.name);
 }
 console.log("FOLDER_SELECTION_READONLY_PASS: single low-noise selected surface, 4 viewport widths");
}catch(error){console.error("FOLDER_SELECTION_READONLY_FAIL",error.message);process.exitCode=1;
}finally{
 ws?.close();
 if(chrome.exitCode===null){
  const finished=new Promise(resolve=>chrome.once("exit",resolve));
  chrome.kill("SIGTERM");
  await Promise.race([finished,sleep(1500)]);
 }
 // Chromium child processes can keep writing into the profile briefly
 // after the browser process exits. Cleanup must not mask UI assertions.
 await sleep(250);
 for(let attempt=0;attempt<5;attempt++){
  try{rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:120});break;}
  catch(error){
   if(!["ENOTEMPTY","EBUSY"].includes(error?.code))throw error;
   if(attempt===4)console.warn("Chrome profile cleanup deferred");
   else await sleep(200);
  }
 }
}
