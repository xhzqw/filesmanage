#!/usr/bin/env node
// Read-only browser geometry gate for the global Rare toast presentation.
// Uses the real app stylesheet, but only injects disposable DOM fixtures.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";

const port=10000+process.pid%30000;
const chrome=spawn("/usr/bin/google-chrome",[
 "--headless=new","--no-sandbox","--disable-gpu",
 "--user-data-dir=/tmp/fm-toast-geometry-"+process.pid,
 "--remote-debugging-port="+port,"--window-size=1280,800","about:blank",
],{stdio:"ignore"});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let ws,sequence=0;
const pending=new Map();
function send(method,params={}){
 const id=++sequence;
 return new Promise((resolve,reject)=>{
  pending.set(id,{resolve,reject});
  ws.send(JSON.stringify({id,method,params}));
 });
}
async function evaluate(expression){
 const result=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
 if(result.exceptionDetails)throw Error("browser evaluate failed: "+JSON.stringify(result.exceptionDetails).slice(0,360));
 return result.result.value;
}
async function waitUntil(expression){
 for(let n=0;n<100;n++){
  try{if(await evaluate(expression))return;}catch{}
  await sleep(120);
 }
 throw Error("browser UI did not become ready");
}

const geometry=String.raw`(()=>{
 const old=document.querySelector(".toast-geometry-fixture");
 old?.remove();
 const viewport=document.createElement("aside");
 viewport.className="rare-toast-viewport toast-geometry-fixture";
 const row=document.createElement("div");
 row.className="rare-toast";
 row.dataset.toastTone="success";
 const mark=document.createElement("span");
 mark.className="rare-toast-mark";
 mark.textContent="✓";
 const copy=document.createElement("span");
 copy.className="rare-toast-text";
 copy.textContent="已收藏："+"工程资料.pdf".repeat(30);
 copy.title=copy.textContent;
 row.append(mark,copy);
 viewport.append(row);
 document.body.append(viewport);
 const a=viewport.getBoundingClientRect(),b=row.getBoundingClientRect();
 const rowStyle=getComputedStyle(row),copyStyle=getComputedStyle(copy);
 const outcome={
  screenX:innerWidth/2,screenHeight:innerHeight,
  x:a.left+a.width/2,top:a.top,
  rowWidth:b.width,rowHeight:b.height,
  borderLeft:parseFloat(rowStyle.borderLeftWidth),
  borderRadius:parseFloat(rowStyle.borderTopLeftRadius),
  clipped:copy.scrollWidth>copy.clientWidth,
  ellipsis:copyStyle.textOverflow,
  rowCenterX:b.left+b.width/2,
 };
 viewport.remove();
 return outcome;
})()`;

function assertGeometry(state,where){
 assert.ok(Math.abs(state.x-state.screenX)<=2,where+": viewport not horizontally centered");
 const top=Math.min(112,Math.max(72,state.screenHeight*.12));
 assert.ok(Math.abs(state.top-top)<=2,where+": toast should sit at the upper-center anchor");
 assert.ok(state.top<state.screenHeight/3,where+": toast must not return to vertical middle");
 assert.ok(Math.abs(state.rowCenterX-state.screenX)<=2,where+": toast row not centered");
 assert.ok(state.rowHeight<=48,where+": notification became oversized");
 assert.ok(state.rowWidth<=400,where+": notification exceeds compact maximum");
 assert.ok(state.borderLeft<=1,where+": old colored side rail was restored");
 assert.ok(state.borderRadius>=15,where+": notification should have soft Rare pill geometry");
 assert.equal(state.clipped,true,where+": long filename must be truncated");
 assert.equal(state.ellipsis,"ellipsis");
}

try{
 let target;
 for(let n=0;n<100;n++){
  await sleep(120);
  try{
   const tabs=await(await fetch("http://127.0.0.1:"+port+"/json/list")).json();
   target=tabs.find(tab=>tab.type==="page");
   if(target)break;
  }catch{}
 }
 if(!target)throw Error("Chrome debugging target unavailable");
 ws=new WebSocket(target.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{
  ws.addEventListener("open",resolve,{once:true});
  ws.addEventListener("error",reject,{once:true});
 });
 ws.addEventListener("message",event=>{
  const message=JSON.parse(event.data),task=pending.get(message.id);
  if(!task)return;
  pending.delete(message.id);
  message.error?task.reject(Error(message.error.message)):task.resolve(message.result);
 });
 await send("Page.enable");
 await send("Runtime.enable");
 await send("Page.navigate",{url:"http://127.0.0.1:18091/login"});
 await waitUntil("!!document.querySelector('input[type=password]') && getComputedStyle(document.documentElement).getPropertyValue('--radius-pill').trim().length>0");
 assertGeometry(await evaluate(geometry),"desktop");

 await send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:2,mobile:true});
 assertGeometry(await evaluate(geometry),"mobile");
 const inModal=await evaluate(String.raw`(()=>{
  const dialog=document.createElement("dialog");
  dialog.textContent="测试弹窗";
  document.body.append(dialog);
  dialog.showModal();
  const viewport=document.createElement("aside");
  viewport.className="rare-toast-viewport";
  const row=document.createElement("div");
  row.className="rare-toast";
  row.dataset.toastTone="warning";
  row.textContent="操作结果未确认";
  viewport.append(row);
  dialog.append(viewport);
  const bounds=row.getBoundingClientRect();
  const hit=document.elementFromPoint(bounds.left+bounds.width/2,bounds.top+bounds.height/2);
  const result={modal:dialog.matches(":modal"),clickable:row.contains(hit),
   centerX:bounds.left+bounds.width/2,screenX:innerWidth/2,
   top:bounds.top,screenHeight:innerHeight};
  dialog.close();dialog.remove();
  return result;
})()`);
 assert.equal(inModal.modal,true);
 assert.equal(inModal.clickable,true,"notification must be clickable inside native modal");
 assert.ok(Math.abs(inModal.centerX-inModal.screenX)<=2,"modal toast remains screen-centered");
 assert.ok(inModal.top>=70&&inModal.top<inModal.screenHeight/3,"modal toast must remain in top center");
 console.log("TOAST_VISUAL_READONLY_PASS: desktop/mobile top-center, compact pill, ellipsis, modal top layer");
}catch(error){
 console.error("TOAST_VISUAL_READONLY_FAIL",error.message);
 process.exitCode=1;
}finally{
 ws?.close();
 chrome.kill("SIGTERM");
}
