#!/usr/bin/env node
// Read-only Rare Workbench overlay regression: no resource writes. Uses a real
// browser on the remote developer server. Credentials are read only on target.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {readFileSync} from "node:fs";

const base="http://127.0.0.1:18091";
const port=9563;
const chrome=spawn("/usr/bin/google-chrome",[
 "--headless=new","--no-sandbox","--disable-gpu",
 "--user-data-dir=/tmp/fm-rare-overlay-"+process.pid,
 "--remote-debugging-port="+port,"--window-size=1440,900","about:blank"
],{stdio:"ignore"});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let ws,seq=0;
const requests=new Map();
function send(method,params={}){
 const id=++seq;
 return new Promise((resolve,reject)=>{
  requests.set(id,{resolve,reject});
  ws.send(JSON.stringify({id,method,params}));
 });
}
async function evalJS(expression){
 const result=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
 if(result.exceptionDetails)throw Error("browser evaluation failed: "+JSON.stringify(result.exceptionDetails).slice(0,350));
 return result.result?.value;
}
async function waitFor(expression){
 for(let i=0;i<100;i++){await sleep(130);if(await evalJS(expression))return;}
 throw Error("browser timeout: "+expression);
}
async function navigate(path,ready){
 await send("Page.navigate",{url:base+path});
 await waitFor(ready);
}
async function click(selector){
 const p=await evalJS(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error("not found: "+${JSON.stringify(selector)});const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
 await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:p.x,y:p.y});
 await send("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",clickCount:1,x:p.x,y:p.y});
 await send("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",clickCount:1,x:p.x,y:p.y});
 await sleep(160);
}
async function key(name,code,keyCode){
 await send("Input.dispatchKeyEvent",{type:"rawKeyDown",key:name,code,windowsVirtualKeyCode:keyCode});
 await send("Input.dispatchKeyEvent",{type:"keyUp",key:name,code,windowsVirtualKeyCode:keyCode});
 await sleep(90);
}
async function viewport(width,height){
 await send("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
 await sleep(130);
}
function inside(rect,width,height){
 return rect&&rect.left>=-1&&rect.top>=-1&&rect.right<=width+1&&rect.bottom<=height+1;
}
try{
 for(let i=0;i<100;i++){
  await sleep(110);
  try{
   const targets=await(await fetch("http://127.0.0.1:"+port+"/json/list")).json();
   const page=targets.find(t=>t.type==="page");
   if(page){ws=new WebSocket(page.webSocketDebuggerUrl);break;}
  }catch{}
 }
 if(!ws)throw Error("Chrome did not start");
 await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true});});
 ws.addEventListener("message",event=>{
  const response=JSON.parse(event.data),pending=requests.get(response.id);
  if(!pending)return;
  requests.delete(response.id);
  response.error?pending.reject(Error(response.error.message)):pending.resolve(response.result);
 });
 await send("Page.enable");await send("Runtime.enable");
 await navigate("/login","!!document.querySelector('input[type=password]')");
 const password=readFileSync(".secrets/admin.password","utf8").trim();
 assert.equal(await evalJS(`(async()=>{const response=await fetch("/api/login",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({login:"admin",password:${JSON.stringify(password)}})});return response.ok;})()`),true);
 const results=[];
 for(const width of [1440,900,390]){
  const height=width===390?760:900;
  await viewport(width,height);
  await navigate("/doc","!!document.querySelector('.account-trigger')");
  await click(".account-trigger");
  await waitFor('!!document.querySelector("[role=menu][aria-label=\"账户操作菜单\"]")');
  const menu=await evalJS(`(()=>{const m=document.querySelector('[role=menu][aria-label="账户操作菜单"]');const r=m.getBoundingClientRect();return{portal:m.parentElement===document.body,rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},focused:m.contains(document.activeElement),overflow:document.documentElement.scrollWidth-innerWidth};})()`);
  assert(menu.portal&&menu.focused&&inside(menu.rect,width,height)&&menu.overflow<=1,"account menu overlay at "+width+": "+JSON.stringify(menu));
  await key("Escape","Escape",27);
  await waitFor('!document.querySelector("[role=menu][aria-label=\"账户操作菜单\"]")');
  assert.equal(await evalJS('document.activeElement?.classList.contains("account-trigger")'),true,"Escape restores trigger");
  await navigate("/stats",'!!document.querySelector(".rare-select[aria-label=\"修改时间\"]")');
  await click('.rare-select[aria-label="修改时间"]');
  await waitFor('!!document.querySelector(".rare-select-menu [role=option]")');
  const select=await evalJS(`(()=>{const b=document.querySelector('.rare-select[aria-label="修改时间"]');const m=document.querySelector(".rare-select-menu");const r=m.getBoundingClientRect();return{role:b.getAttribute("role"),expanded:b.getAttribute("aria-expanded"),count:m.querySelectorAll('[role=option]').length,rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},overflow:document.documentElement.scrollWidth-innerWidth};})()`);
  assert(select.role==="combobox"&&select.expanded==="true"&&select.count>=3&&inside(select.rect,width,height)&&select.overflow<=1,"time dropdown at "+width+": "+JSON.stringify(select));
  await click('.rare-select-menu [role="option"]:nth-child(2)');
  assert.equal(await evalJS('document.querySelector(".rare-select[aria-label=\"修改时间\"]').getAttribute("aria-expanded")'),"false");
  results.push(width+"px: menu/combobox viewport and escape OK");
 }
 await viewport(1440,900);
 await navigate("/doc",'!!document.querySelector(".new-folder-wrapper > button")');
 await click(".new-folder-wrapper > button");
 await waitFor('!!document.querySelector("dialog:modal .dialog-close")');
 const dialog=await evalJS(`(()=>{const d=document.querySelector("dialog:modal"),c=d.querySelector(".dialog-close");const r=d.getBoundingClientRect();return{title:!!d.querySelector('.dialog-header .dialog-title'),close:c.getAttribute("aria-label"),focused:document.activeElement?.id,rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom}};})()`);
 assert(dialog.title&&dialog.close==="关闭弹窗"&&dialog.focused==="new-folder-modal-input"&&inside(dialog.rect,1440,900),"dialog title/first focus: "+JSON.stringify(dialog));
 await click("dialog:modal .dialog-close");
 await waitFor('!document.querySelector("dialog:modal")');
 assert.equal(await evalJS('document.activeElement?.classList.contains("action-btn-secondary")'),true,"dialog close restores trigger");
 console.log("RARE_OVERLAY_READONLY_PASS "+results.join("; ")+"; dialog/close/focus OK");
}catch(error){console.error("RARE_OVERLAY_READONLY_FAIL",error.message);process.exitCode=1;}
finally{ws?.close();chrome.kill("SIGTERM");}
