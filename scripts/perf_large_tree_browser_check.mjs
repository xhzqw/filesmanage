#!/usr/bin/env node
// Read-only real Chrome check against the isolated 10k-directory perf corpus.
// Never creates, updates, moves or deletes business data.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";

const BASE="http://127.0.0.1:18094",TARGET="pf_bulk_9627",TARGET_NAME="目录 9627";
if(process.env.FILESMANAGE_PERF_BROWSER!=="read-only")
 throw Error("PERF_BROWSER_REFUSED: explicit isolated read-only mode required");
// The scratch-only perf principal is defined beside the existing load test.
// Avoid a second hard-coded credential or accepting a production password.
const fixtureDefinition=readFileSync(new URL("./loadtest.py",import.meta.url),"utf8");
const fixturePassword=fixtureDefinition.match(/^DEFAULT_PERF_PASSWORD = "([^"\n]+)"/m)?.[1];
assert.ok(fixturePassword,"perf fixture credential not found");
const login=await fetch(BASE+"/api/login",{method:"POST",headers:{"Content-Type":"application/json"},
 body:JSON.stringify({login:"perf-admin",password:fixturePassword})});
assert.equal(login.status,200);
const cookie=login.headers.getSetCookie().find(x=>x.startsWith("fm_session="))?.split(";")[0];
assert.ok(cookie);
const tree=await(await fetch(BASE+"/api/folders/tree",{headers:{Cookie:cookie}})).json();
assert.ok(tree.ok&&tree.data.length>300&&tree.data.length<=500&&!tree.data.some(f=>f.id===TARGET),"real corpus must exercise 500-row compatibility limit");
const direct=await(await fetch(BASE+"/api/folders/"+TARGET,{headers:{Cookie:cookie}})).json();
assert.equal(direct.data?.id,TARGET);
const dir=mkdtempSync(join(tmpdir(),"fm-perf-chrome-"));
const chrome=spawn("/usr/bin/google-chrome",["--headless=new","--no-sandbox","--disable-gpu",
 "--remote-debugging-port=0","--user-data-dir="+dir,"--force-device-scale-factor=1",
 "--disable-background-timer-throttling","--disable-renderer-backgrounding","about:blank"],{stdio:"ignore"});
let ws,seq=0;
const pending=new Map();
const send=(method,params={})=>new Promise((resolve,reject)=>{
 const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));
});
const evalJS=async expression=>{
 const res=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
 if(res.exceptionDetails)throw Error("Chrome execution failed: "+JSON.stringify(res.exceptionDetails).slice(0,250));
 return res.result.value;
};
const wait=async expression=>{
 for(let n=0;n<220;n++){
  const value=await evalJS(expression);
  if(value)return value;
  await delay(130);
 }
 throw Error("Chrome timed out: "+expression.slice(0,100));
};
try{
 let port=0;
 for(let i=0;i<85;i++){
  try{port=Number(readFileSync(join(dir,"DevToolsActivePort"),"utf8").split("\n")[0]);break;}catch{}
  await delay(100);
 }
 assert.ok(port>0);
 const pages=await(await fetch("http://127.0.0.1:"+port+"/json/list")).json();
 ws=new WebSocket(pages.find(p=>p.type==="page").webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true});});
 ws.addEventListener("message",event=>{
  const msg=JSON.parse(event.data),item=pending.get(msg.id);
  if(!item)return;
  pending.delete(msg.id);
  msg.error?item.reject(Error(msg.error.message)):item.resolve(msg.result);
 });
 await send("Page.enable");
 await send("Runtime.enable");
 await send("Network.enable");
 await send("Network.setCookie",{name:"fm_session",value:cookie.slice("fm_session=".length),url:BASE,httpOnly:true});
 await send("Performance.enable");
 const version=await send("Browser.getVersion");
 const results=[];
 for(const width of [390,760,1366]){
  await send("Emulation.setDeviceMetricsOverride",{width,height:860,deviceScaleFactor:1,mobile:false});
  const start=Date.now();
  await send("Page.navigate",{url:BASE+"/doc?folder="+TARGET});
  await wait(`document.querySelector('.folder-context-bar')?.textContent?.includes(${JSON.stringify(TARGET_NAME)})&&document.querySelectorAll('tbody tr[data-id]').length>0`);
  const info=await evalJS(`(()=>({width:innerWidth,overflow:document.documentElement.scrollWidth-innerWidth,
    files:document.querySelectorAll('tbody tr[data-id]').length,
    nodes:document.querySelectorAll('ul.tree li[role=treeitem]').length,
    location:location.search,rootPresent:!!document.querySelector('li[data-folder-id="pf_root"]')}))()`);
  assert.ok(info.overflow<=2&&info.files>0&&info.rootPresent&&info.location.includes(TARGET));
  const heap=(await send("Performance.getMetrics")).metrics.find(m=>m.name==="JSHeapUsedSize")?.value??0;
  results.push({...info,readyWallMs:Date.now()-start,heapMiB:Math.round(heap/1048576*10)/10});
  console.log("REAL_TREE_DEEP_LINK "+JSON.stringify(results.at(-1)));
 }
 const expanded=await evalJS(`(()=>{let n=document.querySelector('li[data-folder-id="pf_root"]');
  if(n?.getAttribute('aria-expanded')==='false')n.querySelector(':scope > .tree-row button')?.click();return !!n;})()`);
 assert.ok(expanded);
 await wait(`document.querySelectorAll('ul.tree li[role=treeitem]').length>=201`);
 assert.ok(await evalJS(`!!document.querySelector('ul.tree .tree-more')`));
 const tick=Date.now();
 await evalJS(`document.querySelector('ul.tree .tree-more')?.click()`);
 await wait(`document.querySelectorAll('ul.tree li[role=treeitem]').length>=401`);
 const appendWallMs=Date.now()-tick;
 const fit=await evalJS(`document.documentElement.scrollWidth-innerWidth`);
 assert.ok(fit<=2);
 console.log("REAL_TREE_APPEND "+JSON.stringify({nodes:401,appendWallMs,overflow:fit}));
 const scroll=await evalJS(`(()=>{const box=document.querySelector('.sidebar-scroll');box.scrollTop=10000;return {height:box.scrollHeight,client:box.clientHeight,top:box.scrollTop};})()`);
 assert.ok(scroll.height>scroll.client&&scroll.top>0,"large expanded tree must scroll inside the sidebar");
 const searchStart=Date.now();
 await evalJS(`(()=>{const input=document.querySelector('.tree-search');
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
  setter.call(input,'目录 9626');input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
 await wait(`[...document.querySelectorAll('.tree-results a')].some(a=>a.textContent?.includes('目录 9626'))`);
 await evalJS(`(()=>{[...document.querySelectorAll('.tree-results a')].find(a=>a.textContent?.includes('目录 9626'))?.click();return true;})()`);
 await wait(`location.search.includes('pf_bulk_9626')&&document.querySelector('.folder-context-bar')?.textContent?.includes('目录 9626')`);
 const searchWallMs=Date.now()-searchStart;
 console.log("REAL_TREE_SEARCH "+JSON.stringify({searchWallMs,target:"pf_bulk_9626",scroll}));
 const report={chrome:version.product,corpusHint:tree.data.length,results,appendWallMs,searchWallMs,scroll};
 console.log("PERF_LARGE_TREE_BROWSER_PASS "+JSON.stringify(report));
}finally{
 ws?.close();chrome.kill("SIGTERM");await delay(350);rmSync(dir,{recursive:true,force:true});
}
