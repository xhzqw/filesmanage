#!/usr/bin/env node
// Read-only synthetic MSH 120k-triangle browser performance test.
// The authenticated dev app runs unmodified. This *tab only* substitutes a
// model API response; the database is never populated with stress accounts.
import {spawn} from "node:child_process";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {verifiedAdminSession} from "./qa_session.mjs";

const BASE="http://127.0.0.1:18091",MODEL="__msh_perf__";
const port=10100+Math.floor(Math.random()*500),profile=mkdtempSync(join(tmpdir(),"fm-msh-perf-"));
const sendScript=`(()=>{
 const W=200,H=150,N=(W+1)*(H+1);
 const node=(part,x,y)=>part*N+y*(W+1)+x+1;
 const lines=["$MeshFormat","2.2 0 8","$EndMeshFormat","$Nodes",String(N*2)];
 for(let part=0;part<2;part++)
  for(let y=0;y<=H;y++)for(let x=0;x<=W;x++)
   lines.push(node(part,x,y)+" "+(part*300+x)+" "+y+" 0");
 lines.push("$EndNodes","$Elements",String(4*W*H));
 let element=0;
 for(let part=0;part<2;part++)
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
   const a=node(part,x,y),b=node(part,x+1,y),c=node(part,x,y+1),d=node(part,x+1,y+1);
   lines.push(++element+" 2 0 "+a+" "+b+" "+c);
   lines.push(++element+" 2 0 "+b+" "+d+" "+c);
  }
 lines.push("$EndElements","");
 const mesh=new TextEncoder().encode(lines.join("\\n"));
 const originalFetch=window.fetch.bind(window);
 const respond=data=>Promise.resolve(new Response(JSON.stringify({ok:true,data}),{
  status:200,headers:{"Content-Type":"application/json"}
 }));
 window.fetch=(resource,init)=>{
  const url=new URL(typeof resource==="string"?resource:resource.url,location.href);
  if((init?.method??"GET").toUpperCase()==="GET"&&url.origin===location.origin){
   if(url.pathname==="/api/files/__msh_perf__/derivative")
    return respond({found:true,format:"step",class:"converted",state:"ready",outputKind:"msh"});
   if(url.pathname==="/api/files/__msh_perf__/derivative/bytes")
    return Promise.resolve(new Response(mesh.slice(),{
     status:200,headers:{"Content-Type":"application/octet-stream","Content-Length":String(mesh.byteLength)}
    }));
   if(url.pathname==="/api/files/__msh_perf__")
    return respond({file:{sha256:"a".repeat(64),currentVersionSeq:1}});
  }
  return originalFetch(resource,init);
 };
 const stats=window.__mshPerf={started:false,finished:false,duration:0,maxLag:0,ticks:0,bytes:mesh.byteLength};
 const oldPost=Worker.prototype.postMessage;
 Worker.prototype.postMessage=function(message,...rest){
  if(message?.buffer instanceof ArrayBuffer){
   stats.started=true;
   const started=performance.now();
   let previous=started;
   const interval=setInterval(()=>{
    const now=performance.now();
    stats.maxLag=Math.max(stats.maxLag,now-previous-16);
    previous=now;stats.ticks++;
   },16);
   this.addEventListener("message",()=>{
    clearInterval(interval);
    const finish=performance.now();
    stats.maxLag=Math.max(stats.maxLag,finish-previous-16);
    stats.duration=Math.round(finish-started);
    stats.finished=true;
   },{once:true});
  }
  return oldPost.call(this,message,...rest);
 };
})()`;

let browser,ws,id=0;
const pending=new Map();
async function call(method,params={}){
 const value=++id;
 return new Promise((resolve,reject)=>{
  pending.set(value,{resolve,reject});
  ws.send(JSON.stringify({id:value,method,params}));
 });
}
async function expression(expr){
 const result=await call("Runtime.evaluate",{expression:expr,returnByValue:true,awaitPromise:true});
 if(result.exceptionDetails)throw Error("browser evaluation exception");
 return result.result.value;
}
async function until(expr,timeout=25000){
 const start=Date.now();
 while(Date.now()-start<timeout){
  const result=await expression(expr).catch(()=>null);
  if(result)return result;
  await delay(90);
 }
 throw Error("browser timeout: "+expr.slice(0,80));
}
function check(ok,name,value){
 console.log((ok?"PASS ":"FAIL ")+name+" :: "+JSON.stringify(value));
 if(!ok)throw Error(name);
}
try{
 const session=await verifiedAdminSession(BASE);
 browser=spawn("/usr/bin/google-chrome",[
  "--headless=new","--no-sandbox","--disable-dev-shm-usage",
  "--use-angle=swiftshader","--enable-unsafe-swiftshader",
  "--remote-debugging-port="+port,"--user-data-dir="+profile,"--window-size=1440,900","about:blank",
 ],{stdio:"ignore"});
 let tab;
 for(let n=0;n<80&&!tab;n++){
  await delay(120);
  try{
   const tabs=await(await fetch("http://127.0.0.1:"+port+"/json/list")).json();
   tab=tabs.find(t=>t.type==="page");
  }catch{}
 }
 check(!!tab,"headless Chrome started",Boolean(tab));
 ws=new WebSocket(tab.webSocketDebuggerUrl);
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
 await call("Page.enable");
 await call("Runtime.enable");
 await call("Network.enable");
 await call("Network.setCookie",{
  name:"fm_session",value:session.cookie.slice("fm_session=".length),
  domain:new URL(BASE).hostname,path:"/",httpOnly:true,sameSite:"Strict",
 });
 await call("Page.addScriptToEvaluateOnNewDocument",{source:sendScript});
 await call("Page.navigate",{url:BASE+"/model/"+MODEL});
 const result=await until(`(()=>({
  ready:!!document.querySelector('.toolbar[aria-label="视图控制"]'),
  count:document.querySelectorAll('.toolbar[aria-label="装配零件"] label').length,
  metrics:[...document.querySelectorAll(".viewer-stage~.toolbar .toolbar-hint")]
    .map(n=>n.textContent).join(" "),
  stats:window.__mshPerf,
 }))()`,25000);
 // A settled element count is a stronger condition than the initial shell.
 const ready=await until(`(()=>document.querySelectorAll('.toolbar[aria-label="装配零件"] label').length===2
  &&!!document.querySelector('.toolbar[aria-label="视图控制"]'))()`,30000);
 const measurement=await expression("(()=>window.__mshPerf)()");
 check(ready&&result!=null,"large MSH rendered with interactive toolbar",true);
 check(measurement.started&&measurement.finished,"actual MSH Web Worker dispatched and completed",measurement);
 check(measurement.ticks>=Math.max(2,measurement.duration/16*0.45)&&measurement.maxLag<220,
  "main browser event loop remains responsive while worker parses",
  {maxLagMs:measurement.maxLag,ticks:measurement.ticks,workerMs:measurement.duration});
 const parts=await expression(`(()=>{
  const labels=[...document.querySelectorAll('.toolbar[aria-label="装配零件"] label')];
  return labels.map(l=>l.querySelector('.toolbar-hint')?.textContent?.trim());
 })()`);
 check(parts.length===2&&parts.every(t=>t?.includes("200.00×150.00×0.00")&&t.includes("60000△")),
  "120k triangles retain two exact assembly bounds",parts);
 console.log("MSH_LARGE_BROWSER_PASS triangles=120000 parts=2 worker_ms="+measurement.duration);
}finally{
 ws?.close();
 if(browser){
  browser.kill("SIGKILL");
  if(browser.exitCode===null){
   await Promise.race([new Promise(resolve=>browser.once("close",resolve)),delay(3000)]);
  }
 }
 rmSync(profile,{recursive:true,force:true,maxRetries:15,retryDelay:100});
}
