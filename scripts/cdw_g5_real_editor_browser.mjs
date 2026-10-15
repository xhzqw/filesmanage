#!/usr/bin/env node
// Real Chrome/ONLYOFFICE editing runner. Called ONLY by the Go isolated G5
// integration test. The Go test owns test DB, HTTP listener and cleanup.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";

const target=process.argv[2];
const root=process.env.CDW_G5_TEST_ROOT;
assert(target?.startsWith("http://127.0.0.1:18095/test?nonce="),"invalid isolated target");
assert.equal(root,"http://127.0.0.1:18095");
const profile=mkdtempSync(join(tmpdir(),"cdw-g5-real-browser-"));
const port=34000+process.pid%20000;
const chrome=spawn("/usr/bin/google-chrome",[
 "--headless=new","--no-sandbox","--disable-dev-shm-usage",
 "--remote-debugging-port="+port,"--user-data-dir="+profile,
 "--window-size=1280,900","--disable-background-timer-throttling","about:blank"
],{stdio:"ignore"});
let ws,seq=0;
const pending=new Map();
const send=(method,params={})=>new Promise((resolve,reject)=>{
 const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));
});
const inspect=async expression=>{
 const answer=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
 if(answer.exceptionDetails)throw Error(JSON.stringify(answer.exceptionDetails).slice(0,400));
 return answer.result.value;
};
const click=async(x,y)=>{
 await send("Input.dispatchMouseEvent",{type:"mouseMoved",x,y});
 await send("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",buttons:1,clickCount:1});
 await send("Input.dispatchMouseEvent",{type:"mouseReleased",x,y,button:"left",buttons:0,clickCount:1});
};
try{
 let tab;
 for(let i=0;i<80&&!tab;i++){
  try{tab=(await(await fetch("http://127.0.0.1:"+port+"/json/list")).json()).find(x=>x.type==="page")}catch{}
  if(!tab)await sleep(150);
 }
 assert.ok(tab,"Chrome CDP browser unavailable");
 ws=new WebSocket(tab.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true})});
 ws.addEventListener("message",message=>{
  const data=JSON.parse(message.data),promise=pending.get(data.id);
  if(promise){pending.delete(data.id);data.error?promise.reject(Error(data.error.message)):promise.resolve(data.result)}
 });
 await send("Page.enable");await send("Runtime.enable");
 await send("Page.navigate",{url:target});
 let ready=false;
 for(let i=0;i<165;i++){
  await sleep(250);
  const state=await inspect("({ready:!!window.__g5Ready,err:window.__g5Error||'',location:location.href})");
  if(state.err)throw Error("ONLYOFFICE editor error: "+state.err);
  if(state.ready){ready=true;break;}
 }
 assert(ready,"Real ONLYOFFICE onDocumentReady not received");
 console.log("CDW_G5_CHROME_REAL_EDITOR_READY");
 // ONLYOFFICE renders the document on a centered editable page; click inside
 // its page body, not the toolbar. CDP input crosses child iframe boundaries.
 let changed=false;
 for(const [x,y] of [[640,360],[610,430],[680,520],[540,610]]){
  await click(x,y);
  await send("Input.dispatchKeyEvent",{type:"keyDown",key:"End",code:"End",windowsVirtualKeyCode:35});
  await send("Input.dispatchKeyEvent",{type:"keyUp",key:"End",code:"End",windowsVirtualKeyCode:35});
  await send("Input.insertText",{text:" CDW_G5_REAL_BROWSER_EDIT_"+Date.now()});
  for(let i=0;i<17;i++){
   await sleep(250);
   changed=!!await inspect("window.__g5Changed");
   if(changed)break;
  }
  if(changed)break;
 }
 assert(changed,"Real editor failed to accept keyboard edit; no onDocumentStateChange");
 console.log("CDW_G5_CHROME_REAL_EDITOR_CHANGED");
 // Stay connected while Go asks Document Server to force-save and waits for
 // its actual callback; do not close the collaborative session prematurely.
 for(let i=0;i<240;i++){
  await sleep(350);
  if((await(await fetch(root+"/test/done")).text()).trim()==="done")break;
 }
 console.log("CDW_G5_CHROME_CLEANUP");
}finally{
 try{ws?.close()}catch{}
 chrome.kill("SIGTERM");
 await Promise.race([new Promise(resolve=>chrome.once("exit",resolve)),sleep(2200)]);
 rmSync(profile,{recursive:true,force:true,maxRetries:8,retryDelay:125});
}
