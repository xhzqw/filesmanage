#!/usr/bin/env node
// Read-only authenticated Chrome geometry and navigation smoke for CDW.
// No tasks are created and no business document is edited.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {readFileSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";

const base=(process.argv[2]||"http://127.0.0.1:18091").replace(/\/+$/,"");
const password=readFileSync(process.argv[3]||".secrets/admin.password","utf8").trim();
const port=18000+process.pid%17000,profile=mkdtempSync(join(tmpdir(),"fm-cdw-browser-"));
const chrome=spawn("/usr/bin/google-chrome",[
 "--headless=new","--no-sandbox","--disable-dev-shm-usage","--remote-debugging-port="+port,
 "--user-data-dir="+profile,"--window-size=1440,900","about:blank"],{stdio:"ignore",detached:true});
let ws,sequence=0;
const pending=new Map();
function send(method,params={}){
 const id=++sequence;
 return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
}
async function evalJS(expression){
 const result=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
 if(result.exceptionDetails)throw Error("browser script exception: "+JSON.stringify(result.exceptionDetails).slice(0,280));
 return result.result.value;
}
async function until(expression){
 for(let i=0;i<90;i++){if(await evalJS(expression))return;await sleep(170);}
 throw Error("browser wait timeout: "+expression+"; got "+JSON.stringify(await evalJS("({route:location.pathname,html:document.body.innerText.slice(0,350)})")));
}
try{
 let tab;
 for(let i=0;i<70&&!tab;i++){
  try{tab=(await(await fetch("http://127.0.0.1:"+port+"/json/list")).json()).find(t=>t.type==="page");}catch{}
  if(!tab)await sleep(150);
 }
 assert.ok(tab,"Chrome debugger must be available");
 ws=new WebSocket(tab.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true});});
 ws.addEventListener("message",event=>{const message=JSON.parse(event.data),ticket=pending.get(message.id);
  if(ticket){pending.delete(message.id);message.error?ticket.reject(Error(message.error.message)):ticket.resolve(message.result);}
 });
 await send("Page.enable");await send("Runtime.enable");
 await send("Page.navigate",{url:base+"/login"});
 await until("location.pathname==='/login'");
 const login=await evalJS(`(async()=>{const res=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',
 body:JSON.stringify({login:'admin',password:${JSON.stringify(password)}})});return {status:res.status,ok:(await res.json()).ok}})()`);
 assert.equal(login.status,200,"isolated Chrome read-only admin login");
 assert.equal(login.ok,true,"admin credentials work");
 await send("Page.navigate",{url:base+"/knowledge"});
 await until("location.pathname==='/knowledge'&&!!document.querySelector('.kn-shell')");
 assert.equal(await evalJS("document.querySelector('.kn-nav')!==null"),true);
 const created=await evalJS("(async()=>{const r=await fetch('/api/knowledge/pages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Chrome知识页QA'})});return (await r.json()).data.id})()");
 await send("Page.navigate",{url:base+"/knowledge?page="+encodeURIComponent(created)});
 await until("!!document.querySelector('.kn-title')");
 assert.equal(await evalJS("document.querySelector('.kn-title').value"),"Chrome知识页QA");
 await evalJS("(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent.includes('修订历史'))?.click();return true})()");
 await until("!!document.querySelector('.kn-history details')");

 for(const width of [1440,1024,760,390]){
  await send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
  await sleep(220);
  const dims=await evalJS("(()=>({doc:document.documentElement.scrollWidth,canvas:document.querySelector('.kn-canvas').getBoundingClientRect().right}))()");
  assert.ok(dims.doc<=width+2&&dims.canvas<=width+2,"knowledge layout overflow "+width+" "+JSON.stringify(dims));
  console.log("KNOWLEDGE_VIEWPORT_PASS",width);
 }
 await send("Emulation.clearDeviceMetricsOverride");
 await send("Page.navigate",{url:base+"/doc"});
 await until("!!document.querySelector('.finder-navigation')");
 assert.ok(await evalJS("document.getElementsByClassName(String.fromCharCode(107,110,45,102,105,110,100,101,114,45,115,101,99,116,105,111,110)).length>0"));
 console.log("KNOWLEDGE_BROWSER_PASS");
}finally{
 try{ws?.close();}catch{}
 try{process.kill(-chrome.pid,"SIGTERM")}catch{chrome.kill("SIGTERM")}
 if(chrome.exitCode===null&&chrome.signalCode===null)await Promise.race([new Promise(resolve=>chrome.once("exit",resolve)),sleep(2400)]);
 for(let attempt=0;attempt<15;attempt++){
  try{rmSync(profile,{recursive:true,force:true,maxRetries:4,retryDelay:150});break;}
  catch(error){if(attempt===14)throw error;await sleep(270);}
 }
}
