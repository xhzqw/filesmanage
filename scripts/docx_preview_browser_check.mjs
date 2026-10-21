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
let item;
if(process.env.DOCX_PREVIEW_TARGET_FILE_ID){
 const target=await fetch(base+"/api/files/"+encodeURIComponent(process.env.DOCX_PREVIEW_TARGET_FILE_ID),{headers:{Cookie:cookie}});
 assert.equal(target.status,200,"Requested DOCX regression target must be accessible");
 item=(await target.json()).data?.file;
 assert(item?.name?.toLowerCase().endsWith(".docx"),"Requested regression target must be a DOCX file");
}else{
 const query=await fetch(base+"/api/search?q=do05-sample&limit=20",{headers:{Cookie:cookie}});
 assert.equal(query.status,200);
 const data=await query.json();
 item=data.data?.items?.find(file=>file.name==="do05-sample.docx");
 assert(item?.id,"DO05 fixture must be present for DOCX layout check");
}
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
const unexpectedDownloads=[];
const unexpectedBytesRequests=[];
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
  if(reply.method==="Page.downloadWillBegin"||reply.method==="Browser.downloadWillBegin"){
   unexpectedDownloads.push(reply.params?.suggestedFilename??"download");
  }
  if(reply.method==="Network.requestWillBeSent"&&(reply.params?.request?.url??"").includes("/bytes")){
   unexpectedBytesRequests.push(reply.params.request.url);
  }
  if(!job)return;
  pending.delete(reply.id);clearTimeout(job.timer);
  reply.error?job.reject(Error(reply.error.message)):job.resolve(reply.result);
 });
 await send("Page.enable");await send("Runtime.enable");await send("Network.enable");
 await send("Network.setCookie",{name:"fm_session",value:cookie.slice("fm_session=".length),url:base});
 await send("Page.navigate",{url:base+"/preview/"+encodeURIComponent(item.id)});
 assert(await waitFor('Boolean([...document.querySelectorAll(".office-layout-pdf img")].some(img=>img.complete&&img.naturalWidth>0&&getComputedStyle(img).visibility==="visible"))',35000),
  "DOCX must open as a rendered image page, without downloading");
 for(const [width,height] of [[1440,900],[1024,768],[740,740]]){
  await send("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
  await delay(250);
  const state=await evalJS(`(()=>{
   const stage=document.querySelector(".office-layout-preview");
   const viewport=document.querySelector(".office-layout-pdf");
   const image=document.querySelector(".office-layout-pdf img");
   const rect=stage?.getBoundingClientRect(),paper=image?.getBoundingClientRect();
   const view=viewport?.getBoundingClientRect();
   const style=viewport&&getComputedStyle(viewport);
   const insideHeight=(view?.height??0)-(style?parseFloat(style.paddingTop)+parseFloat(style.paddingBottom):0);
   const insideWidth=(view?.width??0)-(style?parseFloat(style.paddingLeft)+parseFloat(style.paddingRight):0);
   const ratio=image?.naturalWidth/image?.naturalHeight;
   const displayedRatio=paper?.width/paper?.height;
   const selected=[...document.querySelectorAll(".office-layout-switch button")]
    .find(button=>button.getAttribute("aria-pressed")==="true")?.textContent?.trim();
   return {selected,stageWidth:rect?.width,pageWidth:paper?.width,pageHeight:paper?.height,
    insideWidth,insideHeight,ratio,displayedRatio,
    isPNG:!!image?.complete&&image.naturalWidth>0&&image.getAttribute("src")?.includes("/preview/office/page?"),
    hasPDFFrame:!!document.querySelector(".office-layout-pdf iframe"),
    summaryVisible:!!document.querySelector(".office-layout-outline"),
    overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth};
  })()`);
  assert(state.selected==="页面布局"&&state.isPNG&&!state.hasPDFFrame&&!state.summaryVisible&&state.pageHeight>220&&
   state.pageWidth>150&&state.pageWidth<=state.insideWidth+2&&state.pageHeight<=state.insideHeight+2&&
   Math.abs(state.ratio-state.displayedRatio)<0.01&&state.overflow<=1,
   "DOCX paged layout geometry "+width+": "+JSON.stringify(state));
  console.log("PASS DOCX page layout "+width+" native="+state.ratio.toFixed(3)+" displayed="+state.displayedRatio.toFixed(3));
 }
 const count=await evalJS('Number(document.querySelector(".office-layout-page-controls .preview-dock-page-count")?.textContent?.split("/")[1])||0');
 const firstMounted=await evalJS('document.querySelectorAll(".office-layout-pdf img").length');
 assert(firstMounted<=8,"Document must not mount every offscreen image");
 if(count>1){
  await evalJS('document.querySelector(".office-layout-pdf").scrollTop=document.querySelector(".office-layout-pdf").scrollHeight');
  assert(await waitFor('Number(document.querySelector(".office-layout-page-controls .preview-dock-page-count")?.textContent?.split("/")[0])>1'),
   "Scrolling must update the active page across document boundaries");
  const afterScroll=await evalJS('document.querySelectorAll(".office-layout-pdf img").length');
  assert(afterScroll<=8,"Continuous scrolling must keep the mounted page-image window bounded");
  await evalJS('document.querySelector(".office-layout-pdf").scrollTop=0');
  assert(await waitFor('document.querySelector(".office-layout-page-controls .preview-dock-page-count")?.textContent?.trim().startsWith("1 /")'),
   "Scrolling back must restore the first page position");
  console.log("PASS DOCX continuous scrolling, active page tracking and bounded images");
 }
 const beforeZoom=await evalJS('document.querySelector(".office-layout-pdf img")?.getBoundingClientRect().height');
 await evalJS('document.querySelector("button[aria-label=放大页面]")?.click()');
 await delay(200);
 const afterZoom=await evalJS('document.querySelector(".office-layout-pdf img")?.getBoundingClientRect().height');
 assert(afterZoom>beforeZoom*1.15,"Zoom must enlarge without stretching document pages");
 console.log("PASS DOCX zoom enlarges proportional page");
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
 assert(await waitFor('Boolean([...document.querySelectorAll(".office-layout-pdf img")].some(img=>img.complete&&img.naturalWidth>0&&getComputedStyle(img).visibility==="visible"))'),
  "DOCX switch back to pages must retain rendered page");
 assert.deepEqual(unexpectedDownloads,[],"DOCX preview must not trigger a browser download");
 assert.deepEqual(unexpectedBytesRequests,[],"DOCX preview must not fetch the original file");
 console.log("PASS DOCX returns to image pages without downloading");
}finally{
 ws?.close();
 chrome.kill("SIGTERM");
 await delay(180);
 rmSync(profile,{recursive:true,force:true});
}
console.log("DOCX_PREVIEW_BROWSER_PASS");
