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
let copiedTestId=null,copyDestination=null;
let copyBeforeIds=[];
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
 await until('document.querySelectorAll("tr.file-entry,.explorer-list-folder").length>0',
  "Initial folder rows must finish rendering before checking file count");
 const folderDate=await evaluate(`(async()=>{
  const tree=await(await fetch("/api/folders/tree",{cache:"no-store"})).json();
  const row=document.querySelector(".explorer-list-folder");
  const data=tree.data?.find(entry=>entry.id===row?.dataset.uploadFolderId);
  return {api:data?.updatedAt,displayed:row?.querySelector("td.col-date")?.textContent.trim()};
 })()`);
 assert(folderDate.api&&folderDate.displayed===folderDate.api.replace("T"," ").slice(0,16),
  "Folder modified date must come from the actual API: "+JSON.stringify(folderDate));
 console.log("EXPLORER_FOLDER_MTIME_PASS",JSON.stringify(folderDate));
 let count=await evaluate('document.querySelectorAll("tr.file-entry").length');
 if(count<4){
  const queue=await evaluate('[...document.querySelectorAll(".explorer-list-folder")].map(el=>el.dataset.uploadFolderId).filter(Boolean)');
  const visited=new Set();
  while(queue.length&&count<4&&visited.size<60){
   const id=queue.shift();
   if(visited.has(id))continue;
   visited.add(id);
   await navigate("/doc?folder="+encodeURIComponent(id),'!!document.querySelector(".work-body .file-toolbar")');
   await until('!document.querySelector(".work-body .table .brand-loading-label")');
   await delay(450);
   count=await evaluate('document.querySelectorAll("tr.file-entry").length');
   if(count<4){
    const children=await evaluate('[...document.querySelectorAll(".explorer-list-folder")].map(el=>el.dataset.uploadFolderId).filter(Boolean)');
    queue.push(...children.filter(child=>!visited.has(child)));
   }
  }
 }
 if(count<4){
  const diagnostics=await evaluate(`(async()=>{
   const tree=await(await fetch("/api/folders/tree")).json();
   const root=tree.data?.find(item=>item.parentId===null);
   const files=root?await(await fetch("/api/files?folder="+encodeURIComponent(root.id)+"&sort=updated_desc&limit=50")).json():null;
   return {path:location.pathname+location.search,treeCount:tree.data?.length,
    root:root?.id,fileCount:files?.data?.items?.length,fileError:files?.error,
    pageText:document.body.textContent.slice(-250)};
  })()`);
  console.error("EXPLORER_REAL_DATA_DIAGNOSTIC",JSON.stringify(diagnostics));
 }
 assert(count>=4,"Need at least four authorized file rows for real input regression; loaded="+count);
 await click("tr.file-entry .file-name",0);
 await until('(document.querySelector(".file-selected-count")?.textContent||"").includes("已选 1")');
 await click("tr.file-entry .file-name",1);
 await until('document.querySelectorAll("tr.file-entry[aria-selected=true]").length===1');
 assert.equal(await evaluate('document.querySelectorAll("tr.file-entry")[1]?.getAttribute("aria-selected")'),"true",
  "Second plain click should replace the first selection");
 await click("tr.file-entry .file-name",0,2);
 await until('(document.querySelector(".file-selected-count")?.textContent||"").includes("已选 2")');
 assert.equal(await selectedFiles(),2,"Ctrl-click must add an earlier file");
 await click("tr.file-entry .file-name",2,2);
 await until('(document.querySelector(".file-selected-count")?.textContent||"").includes("已选 3")');
 assert.equal(await selectedFiles(),3,"Ctrl-click should add a third file");
 assert(await evaluate('!document.querySelector("tr.file-entry input[type=checkbox]")'),
  "checkboxes must not exist before enabling the option");
 await click(".checkbox-visibility-toggle");
 await until('!!document.querySelector("tr.file-entry input[type=checkbox]")');
 await click('tr.file-entry .col-select input[type="checkbox"]',3);
 await until('(document.querySelector(".file-selected-count")?.textContent||"").includes("已选 4")');
 assert.equal(await selectedFiles(),4,"Checkbox should preserve three earlier selections");
 await click("tr.file-entry .file-name",1,2);
 await until('(document.querySelector(".file-selected-count")?.textContent||"").includes("已选 3")');
 await click(".batch-clear-selection");
 await until('!document.querySelector(".batch-actions-group")');
 await click(".checkbox-visibility-toggle");
 await until('!document.querySelector("tr.file-entry input[type=checkbox]")');
 console.log("EXPLORER_LIVE_MULTI_SELECT_PASS",JSON.stringify({count:4,plainSingle:true,ctrlClick:true,checkbox:true,toggleOff:true}));

 const path=await evaluate('location.pathname+location.search');
 await click('.folder-view-switch button[aria-label="图标视图"]');
 await until('document.querySelector(".work-body")?.dataset.explorerView==="icons"');
 const points=await evaluate(`(()=>{
  const grid=document.querySelector(".explorer-icon-grid"),surface=document.querySelector(".explorer-surface");
  const cards=[...grid.querySelectorAll(".explorer-item")];
  if(cards.length<2)return null;
  const g=grid.getBoundingClientRect(),a=cards[0].getBoundingClientRect(),b=cards[1].getBoundingClientRect();
  return {start:{x:g.left+3,y:g.top+3},end:{x:Math.max(a.right,b.right)-3,y:Math.max(a.bottom,b.bottom)-2}};
 })()`);
 assert(points,"Icon view must have at least two resources to marquee-select");
 await send("Input.dispatchMouseEvent",{type:"mouseMoved",...points.start});
 await send("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",clickCount:1,...points.start});
 for(let i=1;i<=8;i++){
  await send("Input.dispatchMouseEvent",{type:"mouseMoved",buttons:1,button:"left",
   x:points.start.x+(points.end.x-points.start.x)*i/8,
   y:points.start.y+(points.end.y-points.start.y)*i/8});
 }
 await until('!!document.querySelector(".explorer-marquee")');
 await send("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",clickCount:1,...points.end});
 await until('[...document.querySelectorAll(".explorer-item[aria-selected=true]")].length>=2');
 await until('!document.querySelector(".explorer-marquee")',"Marquee should disappear on release");
 console.log("EXPLORER_FINDER_MARQUEE_PASS");
 await click('.folder-view-switch button[aria-label="列表视图"]');
 await until('document.querySelector(".work-body")?.dataset.explorerView==="list"');

 // Exercise a real Ctrl+C -> directory navigation -> Ctrl+V round-trip.
 // The source is an existing small file; only the new duplicate is deleted.
 const clipboardFixture=await evaluate(`(async()=>{
  const tree=await(await fetch("/api/folders/tree")).json();
  const sourceFolder=new URLSearchParams(location.search).get("folder")||tree.data?.find(row=>!row.parentId)?.id;
  const source=await(await fetch("/api/files?"+new URLSearchParams({folder:sourceFolder,sort:"updated_desc",limit:"50"}))).json();
  const rows=source.data?.items||[];
  const file=rows.find(row=>row.sizeBytes<131072&&row.name.endsWith(".txt")&&
    !!document.querySelector('tr.file-entry[data-id="'+row.id+'"]'));
  const child=[...document.querySelectorAll(".explorer-list-folder")].map(row=>row.dataset.uploadFolderId)
   .find(id=>id&&id!==sourceFolder);
  return file&&child?{fileId:file.id,name:file.name,sha:file.sha256,target:child}:null;
 })()`);
 if(clipboardFixture){
  copyDestination=clipboardFixture.target;
  const current=await evaluate(`(async()=>{
   const r=await fetch("/api/files?"+new URLSearchParams({folder:${JSON.stringify(copyDestination)},sort:"updated_desc",limit:"50"}));
   const data=await r.json();return (data.data?.items||[]).map(file=>file.id);
  })()`);
  copyBeforeIds=current;
  await click('tr.file-entry[data-id="'+clipboardFixture.fileId+'"] .file-name');
  const shortcut=async(key,code)=>{
   await send("Input.dispatchKeyEvent",{type:"keyDown",modifiers:2,key,code});
   await send("Input.dispatchKeyEvent",{type:"keyUp",modifiers:2,key,code});
  };
  await shortcut("c","KeyC");
  const afterCopy=await evaluate('({toasts:[...document.querySelectorAll("[role=status],[role=alert]")].map(x=>x.textContent.slice(0,140)),selected:document.querySelector(".file-selected-count")?.textContent,active:document.activeElement?.tagName})');
  console.log("COPY_SHORTCUT_DEBUG",JSON.stringify(afterCopy));
  await navigate("/doc?folder="+encodeURIComponent(copyDestination),'!!document.querySelector(".work-body .file-toolbar")');
  await shortcut("v","KeyV");
  await delay(350);
  const afterPaste=await evaluate('({toasts:[...document.querySelectorAll("[role=status],[role=alert]")].map(x=>x.textContent.slice(0,140)),progress:document.querySelector(".file-paste-status")?.textContent,path:location.pathname+location.search,active:document.activeElement?.tagName})');
  console.log("PASTE_SHORTCUT_DEBUG",JSON.stringify(afterPaste));
  const newCopy=async()=>evaluate(`(async()=>{
   const r=await fetch("/api/files?"+new URLSearchParams({folder:${JSON.stringify(copyDestination)},sort:"updated_desc",limit:"50"}));
   const data=await r.json();return (data.data?.items||[]).find(row=>!${JSON.stringify(copyBeforeIds)}.includes(row.id)&&row.sha256===${JSON.stringify(clipboardFixture.sha)})||null;
  })()`);
  for(let i=0;i<120;i++){const copy=await newCopy();if(copy){copiedTestId=copy.id;break;}await delay(150);}
  if(!copiedTestId){
   const diagnostic=await evaluate(`(async()=>{
    const r=await fetch("/api/files?"+new URLSearchParams({folder:${JSON.stringify(copyDestination)},sort:"updated_desc",limit:"50"}));
    const body=await r.json();
    return {items:(body.data?.items||[]).map(item=>({id:item.id,name:item.name,sha:item.sha256})).slice(0,10),
     toasts:[...document.querySelectorAll("[role=alert],[role=status]")].map(x=>x.textContent.slice(0,130)),
     progress:document.querySelector(".file-paste-status")?.textContent};
   })()`);
   console.log("PASTE_FAILURE_DIAGNOSTIC",JSON.stringify(diagnostic));
  }
  assert(copiedTestId,"Ctrl+V must persist a new content-identical file in the destination directory");
  const copy=await newCopy();
  assert(copy.name.includes("副本")||copy.name===clipboardFixture.name,"Pasted file must keep original name or use a safe copy suffix");
  await until('!document.querySelector(".file-paste-status")',"Paste operation finished");
  console.log("EXPLORER_LIVE_COPY_PASTE_PASS",JSON.stringify({source:clipboardFixture.fileId,destination:copyDestination,copied:copiedTestId,hashMatches:true}));
  const cleanup=await evaluate(`(async()=>{
   const response=await fetch("/api/files/"+${JSON.stringify(copiedTestId)},{method:"DELETE"});
   return response.ok;
  })()`);
  assert(cleanup,"Temporary copied file must be cleaned up");
  copiedTestId=null;
  await navigate(path,'!!document.querySelector("tr.file-entry")');
 }

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
 await navigate(path,'!!document.querySelector("tr.file-entry .action-star-btn")');
 await until(`document.querySelector("tr.file-entry .action-star-btn")?.classList.contains("favorited")===${expected}`,"favorite after reload");
 console.log("EXPLORER_LIVE_FAVORITE_PERSIST_PASS",JSON.stringify({id:tested,changed:true,afterReload:true}));
}catch(error){
 console.error("EXPLORER_LIVE_INTERACTION_FAIL",error?.stack||error);
 process.exitCode=1;
}finally{
 if(copiedTestId&&ws?.readyState===WebSocket.OPEN){
  try{
   await evaluate(`(async()=>{await fetch("/api/files/"+${JSON.stringify(copiedTestId)},{method:"DELETE"});return true})()`);
  }catch(error){console.error("COPY_FIXTURE_RESTORE_FAILED",error?.message);process.exitCode=1;}
 }
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
