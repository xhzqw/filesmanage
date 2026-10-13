#!/usr/bin/env node
// Development-only authenticated Chrome check of actual pointer events and
// favorite persistence. It restores a tested favorite to its initial state.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {readFileSync,rmSync} from "node:fs";

const origin="http://127.0.0.1:18091";
const profile="/tmp/fm-explorer-real-"+process.pid;
const chrome=spawn("/usr/bin/google-chrome",[
 "--headless=new","--no-sandbox","--disable-gpu","--disable-dev-shm-usage",
 "--user-data-dir="+profile,"--remote-debugging-port=0","--window-size=1440,900","about:blank"
],{stdio:"ignore"});
const delay=ms=>new Promise(done=>setTimeout(done,ms));
let ws,port=0,seq=0;
const pending=new Map();
function send(method,params={}){
 const id=++seq;
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{pending.delete(id);reject(Error("CDP timeout "+method));},16000);
  pending.set(id,{resolve,reject,timer});
  ws.send(JSON.stringify({id,method,params}));
 });
}
async function evaluate(source){
 const r=await send("Runtime.evaluate",{expression:source,returnByValue:true,awaitPromise:true});
 if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);
 return r.result?.value;
}
async function until(expression,description=expression){
 for(let i=0;i<120;i++){if(await evaluate(expression))return;await delay(130);}
 throw Error("Timeout: "+description);
}
async function navigate(path,selector){
 await send("Page.navigate",{url:origin+path});
 await until(selector);
}
async function click(selector,index=0,modifiers=0){
 const rect=await evaluate(`(()=>{
  const node=document.querySelectorAll(${JSON.stringify(selector)})[${index}];
  if(!node)return null;
  node.scrollIntoView({block:"center",inline:"center"});
  const b=node.getBoundingClientRect();
  return {x:b.left+b.width/2,y:b.top+b.height/2};
 })()`);
 assert(rect,"missing clickable "+selector+"["+index+"]");
 await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:rect.x,y:rect.y,modifiers});
 await send("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",clickCount:1,x:rect.x,y:rect.y,modifiers});
 await send("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",clickCount:1,x:rect.x,y:rect.y,modifiers});
}
const selectedFiles=()=>evaluate('document.querySelectorAll("tr.file-entry[aria-selected=true]").length');
const selectionText=()=>evaluate('document.querySelector(".file-selected-count")?.textContent||""');
const favoriteRead=()=>evaluate('(async()=>{const response=await fetch("/api/favorites",{cache:"no-store"});const json=await response.json();return {status:response.status,ok:json.ok,rows:json.data};})()');

let tested=null,originalFavorite=false;
try{
 for(let i=0;i<120;i++){
  await delay(90);
  try{
   if(!port)port=Number(readFileSync(profile+"/DevToolsActivePort","utf8").split("\n")[0]);
   const targets=await(await fetch("http://127.0.0.1:"+port+"/json/list")).json();
   const page=targets.find(x=>x.type==="page");
   if(page){ws=new WebSocket(page.webSocketDebuggerUrl);break;}
  }catch{}
 }
 assert(ws,"Chrome startup failure");
 await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true});});
 ws.addEventListener("message",ev=>{
  const result=JSON.parse(ev.data);
  const item=pending.get(result.id);
  if(!item)return;
  pending.delete(result.id);clearTimeout(item.timer);
  result.error?item.reject(Error(result.error.message)):item.resolve(result.result);
 });
 await send("Page.enable");await send("Runtime.enable");
 await navigate("/login",'!!document.querySelector("input[type=password]")');
 const password=readFileSync(".secrets/admin.password","utf8").trim();
 assert(await evaluate(`(async()=>{const r=await fetch("/api/login",{method:"POST",credentials:"same-origin",
  headers:{"Content-Type":"application/json"},body:JSON.stringify({login:"admin",password:${JSON.stringify(password)}})});return r.ok;})()`),
  "Development admin authentication failed");
 await navigate("/doc",'!!document.querySelector(".folder-view-switch")');
 await click('.folder-view-switch button[aria-label="列表视图"]');
 await until('document.querySelector(".work-body")?.dataset.explorerView==="list"');
 let count=await evaluate('document.querySelectorAll("tr.file-entry").length');
 if(count<4){
  const queue=await evaluate('[...document.querySelectorAll(".explorer-list-folder")].map(el=>el.dataset.uploadFolderId).filter(Boolean)');
  const visited=new Set();
  while(queue.length&&count<4&&visited.size<60){
   const id=queue.shift();
   if(visited.has(id))continue;
   visited.add(id);
   await navigate("/doc?folder="+encodeURIComponent(id),'!!document.querySelector(".work-body .file-toolbar")');
   await delay(380);
   count=await evaluate('document.querySelectorAll("tr.file-entry").length');
   if(count<4){
    const children=await evaluate('[...document.querySelectorAll(".explorer-list-folder")].map(el=>el.dataset.uploadFolderId).filter(Boolean)');
    queue.push(...children.filter(child=>!visited.has(child)));
   }
  }
 }
 assert(count>=4,"Need at least four authorized file rows for real input regression; loaded="+count);
 await click("tr.file-entry .file-name",0);
 await until('(document.querySelector(".file-selected-count")?.textContent||"").includes("已选 1")');
 await click("tr.file-entry .file-name",1);
 await until('(document.querySelector(".file-selected-count")?.textContent||"").includes("已选 2")');
 assert.equal(await selectedFiles(),2,"Second plain click must add a file");
 await click("tr.file-entry .file-name",2,2);
 await until('(document.querySelector(".file-selected-count")?.textContent||"").includes("已选 3")');
 assert.equal(await selectedFiles(),3,"Ctrl-click should add a third file");
 await click('tr.file-entry .col-select input[type="checkbox"]',3);
 await until('(document.querySelector(".file-selected-count")?.textContent||"").includes("已选 4")');
 assert.equal(await selectedFiles(),4,"Checkbox should preserve three earlier selections");
 await click("tr.file-entry .file-name",1);
 await until('(document.querySelector(".file-selected-count")?.textContent||"").includes("已选 3")');
 await click(".batch-clear-selection");
 await until('!document.querySelector(".batch-actions-group")');
 console.log("EXPLORER_LIVE_MULTI_SELECT_PASS",JSON.stringify({count:4,plainClick:true,ctrlClick:true,checkbox:true,toggleOff:true}));

 const initial=await favoriteRead();
 assert(initial.ok&&Array.isArray(initial.rows),"Real favorites GET must succeed");
 const target=await evaluate('(()=>{const row=document.querySelector("tr.file-entry");return row?{id:row.dataset.id,name:row.querySelector(".file-name")?.textContent}:null;})()');
 assert(target?.id,"Missing real file for favorite test");
 tested=target.id;
 originalFavorite=initial.rows.some(row=>row.kind==="file"&&row.fileId===tested);
 await click("tr.file-entry .action-star-btn",0);
 const expected=!originalFavorite;
 await until(`document.querySelector("tr.file-entry .action-star-btn")?.classList.contains("favorited")===${expected}`,"favorite feedback");
 for(let i=0;i<50;i++){
  const saved=await favoriteRead();
  if(saved.ok&&saved.rows.some(row=>row.kind==="file"&&row.fileId===tested)===expected)break;
  await delay(130);
 }
 const persisted=await favoriteRead();
 assert.equal(persisted.rows.some(row=>row.kind==="file"&&row.fileId===tested),expected,"Server favorite must persist after click");
 const location=await evaluate('location.pathname+location.search');
 await navigate(location,'!!document.querySelector("tr.file-entry .action-star-btn")');
 await until(`document.querySelector("tr.file-entry .action-star-btn")?.classList.contains("favorited")===${expected}`,"favorite after reload");
 console.log("EXPLORER_LIVE_FAVORITE_PERSIST_PASS",JSON.stringify({id:tested,changed:true,afterReload:true}));
}catch(error){
 console.error("EXPLORER_LIVE_INTERACTION_FAIL",error?.stack||error);
 process.exitCode=1;
}finally{
 if(tested&&ws?.readyState===WebSocket.OPEN){
  try{
   const result=await evaluate(`(async()=>{
    const response=await fetch("/api/favorites/file/"+${JSON.stringify(tested)},{method:${JSON.stringify(originalFavorite?"PUT":"DELETE")}});
    const read=await fetch("/api/favorites",{cache:"no-store"});
    const json=await read.json();
    return {write:response.ok,verified:json.ok&&json.data.some(row=>row.kind==="file"&&row.fileId===${JSON.stringify(tested)})===${originalFavorite}};
   })()`);
   if(!result.write||!result.verified){console.error("FAVORITE_RESTORE_FAILED");process.exitCode=1;}
  }catch(error){console.error("FAVORITE_RESTORE_FAILED",error?.message);process.exitCode=1;}
 }
 ws?.close();chrome.kill("SIGTERM");await delay(200);
 rmSync(profile,{recursive:true,force:true});
}
