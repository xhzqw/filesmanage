#!/usr/bin/env node
// READ-ONLY UI interaction gate. Never creates, edits, deletes or purges files.
// Login only establishes a disposable browser session on the remote dev server.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {readFileSync} from "node:fs";
const base="http://127.0.0.1:18091",port=9542;
const chrome=spawn("/usr/bin/google-chrome",["--headless=new","--no-sandbox","--disable-gpu","--user-data-dir=/tmp/fm-rare-review-"+process.pid,"--remote-debugging-port="+port,"--window-size=1440,900","about:blank"],{stdio:"ignore"});
const sleep=(n)=>new Promise(r=>setTimeout(r,n));
let ws;
let counter=0;
const pending=new Map();
function send(method,params={}){
 const id=++counter;
 return new Promise((resolve,reject)=>{
  pending.set(id,{resolve,reject});
  ws.send(JSON.stringify({id,method,params}));
 });
}
async function ev(expression){
 const r=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
 if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails).slice(0,240));
 return r.result?.value;
}
async function wait(expression){
 for(let i=0;i<80;i++){await sleep(150);try{if(await ev(expression))return true;}catch{}}
 throw Error("timeout "+expression);
}
async function clickAt(selector){
 const rect=await ev(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
 await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:rect.x,y:rect.y});
 await send("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",clickCount:1,x:rect.x,y:rect.y});
 await send("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",clickCount:1,x:rect.x,y:rect.y});
 await sleep(200);
}
try{
 for(let i=0;i<80;i++){await sleep(150);try{const list=await(await fetch("http://127.0.0.1:"+port+"/json/list")).json();const page=list.find(x=>x.type==="page");if(page){ws=new WebSocket(page.webSocketDebuggerUrl);break;}}catch{}}
 if(!ws)throw Error("No Chrome target");
 await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true});});
 ws.addEventListener("message",e=>{const x=JSON.parse(e.data);const q=pending.get(x.id);if(q){pending.delete(x.id);x.error?q.reject(Error(x.error.message)):q.resolve(x.result);}});
 await send("Page.enable");await send("Runtime.enable");
 await send("Page.navigate",{url:base+"/login"});
 await wait("!!document.querySelector('input[type=password]')");
 const password=readFileSync(".secrets/admin.password","utf8").trim();
 const login=await ev(`(async()=>{const r=await fetch('/api/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({login:'admin',password:${JSON.stringify(password)}})});return r.ok})()`);
 if(!login)throw Error("login returned false");
 await send("Page.navigate",{url:base+"/doc"});
 await wait("!!document.querySelector('.account-trigger')");
 const snap=async()=>ev(`(()=>({expanded:document.querySelector('.account-trigger')?.getAttribute('aria-expanded'),menu:!!document.querySelector('[role="menu"][aria-label="账户操作菜单"]')}))()`);
 assert.equal((await snap()).menu,false);
 await clickAt(".account-trigger");
 assert.deepEqual(await snap(),{expanded:"true",menu:true},"account trigger should open menu");
 await clickAt(".account-trigger");
 assert.deepEqual(await snap(),{expanded:"false",menu:false},"second pointer click must close menu");
 await clickAt(".account-trigger");
 assert.equal((await snap()).menu,true);
 await send("Input.dispatchKeyEvent",{type:"rawKeyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
 await send("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
 await sleep(100);
 assert.equal((await snap()).menu,false,"Escape must close menu");
 await send("Page.navigate",{url:base+"/doc"});
 await wait("!!document.querySelector('.command-trigger')");
 await clickAt(".command-trigger");
 await wait("!!document.querySelector('dialog.command-panel')");
 const inspect=async()=>ev(`(()=>({modal:!!document.querySelector('dialog.command-panel:modal'),inside:!!document.activeElement?.closest('dialog.command-panel')}))()`);
 assert.deepEqual(await inspect(),{modal:true,inside:true},"palette must be a real native modal");
 for(let i=0;i<5;i++){
  await send("Input.dispatchKeyEvent",{type:"rawKeyDown",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
  await send("Input.dispatchKeyEvent",{type:"keyUp",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
  await sleep(60);
  assert.deepEqual(await inspect(),{modal:true,inside:true},"Tab "+(i+1)+" escaped palette");
 }
 await send("Input.dispatchKeyEvent",{type:"rawKeyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
 await send("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
 await wait("!document.querySelector('dialog.command-panel')");
 await send("Page.navigate",{url:base+"/org"});
 await wait("!!document.querySelector('#org-tab-members')");
 await clickAt("#org-tab-members");
 await send("Input.dispatchKeyEvent",{type:"rawKeyDown",key:"ArrowRight",code:"ArrowRight",windowsVirtualKeyCode:39});
 await send("Input.dispatchKeyEvent",{type:"keyUp",key:"ArrowRight",code:"ArrowRight",windowsVirtualKeyCode:39});
 await sleep(150);
 const tab=await ev(`(()=>({selected:document.querySelector('[role=tab][aria-selected=true]')?.id,focused:document.activeElement?.id,controls:document.querySelector('[role=tab][aria-selected=true]')?.getAttribute('aria-controls')}))()`);
 assert.deepEqual(tab,{selected:"org-tab-groups",focused:"org-tab-groups",controls:"org-panel-groups"});
 console.log("RARE_UI_READONLY_PASS: menu toggle, Escape, modal focus scope, tabs");
}catch(e){console.error("RARE_UI_READONLY_FAIL",e.message);process.exitCode=1;}
finally{ws?.close();chrome.kill("SIGTERM");}
