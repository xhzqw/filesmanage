#!/usr/bin/env node
// Read-only DOCX regression on the remote developer server. Does not upload,
// change document content, or expose QA credentials.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {readFileSync,rmSync,mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {verifiedAdminSession} from "./qa_session.mjs";

const base="http://127.0.0.1:18091";
const {cookie}=await verifiedAdminSession(base);
const query=await fetch(base+"/api/search?q=do05-sample&limit=20",{headers:{Cookie:cookie}});
assert.equal(query.status,200);
const data=await query.json();
const item=data.data?.items?.find(file=>file.name==="do05-sample.docx");
assert(item?.id,"DO05 fixture must be present for DOCX layout check");
const probe=await fetch(base+"/api/files/"+encodeURIComponent(item.id)+"/preview/office-pdf",{headers:{Cookie:cookie},signal:AbortSignal.timeout(35000)});
assert.equal(probe.status,200,"DOCX derivative must be available");
assert.match(probe.headers.get("content-type")??"",/^application\/pdf/);
const pdfBytes=Buffer.from(await probe.arrayBuffer());
assert.equal(pdfBytes.subarray(0,5).toString(),"%PDF-");
assert.equal(Number(probe.headers.get("content-length")),pdfBytes.byteLength,
 "DOCX derivative must expose a trustworthy transfer length");
console.log("PASS DOCX derivative produces a real PDF");

const profile=mkdtempSync(join(tmpdir(),"fm-docx-check-"));
const chrome=spawn("/usr/bin/google-chrome",[
 "--headless=new","--no-sandbox","--disable-dev-shm-usage",
 "--user-data-dir="+profile,"--remote-debugging-port=0",
 "--window-size=1440,900","about:blank"
],{stdio:"ignore"});
let ws,sequence=0;
const pending=new Map();
async function send(method,params={}){
 const id=++sequence;
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{pending.delete(id);reject(Error("CDP timeout "+method))},15000);
  pending.set(id,{resolve,reject,timer});
  ws.send(JSON.stringify({id,method,params}));
 });
}
async function evalJS(expression){
 const result=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
 if(result.exceptionDetails)throw Error("Chrome evaluation failed: "+JSON.stringify(result.exceptionDetails).slice(0,250));
 return result.result?.value;
}
async function waitFor(expression,deadlineMs=18000){
 const until=Date.now()+deadlineMs;
 do{
  if(await evalJS(expression))return true;
  await delay(175);
 }while(Date.now()<until);
 return false;
}
try{
 let page;
 for(let i=0;i<90&&!page;i++){
  await delay(120);
  try{
   const port=Number(readFileSync(join(profile,"DevToolsActivePort"),"utf8").split("\n")[0]);
   page=(await(await fetch("http://127.0.0.1:"+port+"/json/list")).json()).find(t=>t.type==="page");
  }catch{}
 }
 assert(page,"Chrome did not start");
 ws=new WebSocket(page.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{
  ws.addEventListener("open",resolve,{once:true});
  ws.addEventListener("error",reject,{once:true});
 });
 ws.addEventListener("message",ev=>{
  const reply=JSON.parse(ev.data),job=pending.get(reply.id);
  if(!job)return;
  pending.delete(reply.id);clearTimeout(job.timer);
  reply.error?job.reject(Error(reply.error.message)):job.resolve(reply.result);
 });
 await send("Page.enable");await send("Runtime.enable");await send("Network.enable");
 await send("Network.setCookie",{name:"fm_session",value:cookie.slice("fm_session=".length),url:base});
 await send("Page.navigate",{url:base+"/preview/"+encodeURIComponent(item.id)});
 assert(await waitFor('Boolean(document.querySelector(".office-layout-pdf iframe[src^=blob]"))',25000),
  "DOCX must open in page layout, not automatically switch to summary");
 for(const [width,height] of [[1440,900],[1024,768],[740,740]]){
  await send("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
  await delay(250);
  const state=await evalJS(`(()=>{
   const stage=document.querySelector(".office-layout-preview");
   const iframe=document.querySelector(".office-layout-pdf iframe");
   const rect=stage?.getBoundingClientRect(),paper=iframe?.getBoundingClientRect();
   const selected=[...document.querySelectorAll(".office-layout-switch button")]
    .find(button=>button.getAttribute("aria-pressed")==="true")?.textContent?.trim();
   return {selected,stageWidth:rect?.width,pageWidth:paper?.width,pageHeight:paper?.height,
    isBlob:iframe?.getAttribute("src")?.startsWith("blob:"),summaryVisible:!!document.querySelector(".office-layout-outline"),
    overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth};
  })()`);
  assert(state.selected==="页面布局"&&state.isBlob&&!state.summaryVisible&&state.pageHeight>250&&
   state.pageWidth>200&&state.pageWidth<=state.stageWidth+2&&state.overflow<=1,
   "DOCX paged layout geometry "+width+": "+JSON.stringify(state));
  console.log("PASS DOCX page layout "+width);
 }
 await evalJS(`(()=>{
  [...document.querySelectorAll(".office-layout-switch button")].find(b=>b.textContent?.includes("内容摘要"))?.click();
 })()`);
 const outline=await evalJS(`(()=>{
  const node=document.querySelector(".office-layout-outline .structured-preview-scroll");
  const area=document.querySelector(".office-layout-outline");
  const lines=document.querySelectorAll(".office-layout-outline .structured-lines p");
  return {width:node?.getBoundingClientRect().width,areaWidth:area?.getBoundingClientRect().width,
   lineCount:lines.length,selected:[...document.querySelectorAll(".office-layout-switch button")]
    .find(b=>b.getAttribute("aria-pressed")==="true")?.textContent?.trim()};
 })()`);
 assert(outline.selected==="内容摘要"&&outline.lineCount>0&&outline.width<=outline.areaWidth+2,
  "readable summary content "+JSON.stringify(outline));
 console.log("PASS DOCX summary remains explicitly selectable");
 await evalJS(`(()=>{
  [...document.querySelectorAll(".office-layout-switch button")].find(b=>b.textContent?.includes("页面布局"))?.click();
 })()`);
 assert(await waitFor('Boolean(document.querySelector(".office-layout-pdf iframe[src^=blob]"))'),
  "DOCX switch back to pages must retain PDF");
 console.log("PASS DOCX returns to real PDF pages");
}finally{
 ws?.close();
 chrome.kill("SIGTERM");
 await delay(180);
 rmSync(profile,{recursive:true,force:true});
}
console.log("DOCX_PREVIEW_BROWSER_PASS");
