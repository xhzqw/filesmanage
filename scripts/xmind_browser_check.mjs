#!/usr/bin/env node
// Real Chrome integration without adding files to the database.
// Only two imaginary API paths are intercepted in this disposable browser.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {readFileSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";

const base=(process.argv[2]||"http://127.0.0.1:18091").replace(/\/+$/,"");
const password=readFileSync(".secrets/admin.password","utf8").trim();
const fixture="xmind_controlled_browser_fixture";
const stamp=new Date().toISOString();
const root={title:"DHF 阶段 1–9 流程",notes:"来源于受控文件工作台，所有节点均为只读数据",
 children:Array.from({length:9},(_,i)=>({
  title:"阶段 "+(i+1),
  children:Array.from({length:3},(_,j)=>({
   title:"阶段 "+(i+1)+" 第 "+(j+1)+" 项验收",
   children:[{title:i===8&&j===2?"归档验收-最终确认":"审查记录 "+(i+1)+"."+(j+1),
    notes:"记录审查人、时间和追溯标识",labels:["受控"]}]
  }))
 }))};
function count(topic){return 1+(topic.children??[]).reduce((sum,child)=>sum+count(child),0);}
const mapData={sheets:[{title:"DHF 验收",root},{title:"变更流程",root:{title:"变更申请",children:[{title:"批准"},{title:"关闭"}]}}],topicCount:count(root)+3,truncated:false};
const file={id:fixture,folderId:"folder_root",name:"DHF-preview-fixture.xmind",uploadedBy:"admin",
 contentType:"application/vnd.xmind.workbook",sizeBytes:12345,sha256:"a".repeat(64),
 currentVersionSeq:1,updatedAt:stamp};
const meta={file,versions:[{versionSeq:1,sha256:file.sha256,sizeBytes:12345,action:"upload",createdBy:"admin",createdAt:stamp}],
 lineageParent:null,lineageChildren:[]};
const preview={fileId:fixture,name:file.name,contentType:file.contentType,size:12345,sha256:file.sha256,
 textual:false,renderer:"mindmap",truncated:false,content:"",structured:{
  kind:"mindmap",entries:[],sections:[],truncated:false,note:"",mindMap:mapData},
 byteMeta:{size:12345,sha256:file.sha256,encoding:"",hasBom:false,eol:"none",endsWithNewline:false,printable:false}};
const mockScript="(()=>{const original=window.fetch.bind(window);const data="+JSON.stringify({meta,preview})+
 ";window.fetch=function(input,options){const path=new URL(typeof input==='string'?input:input.url,location.href).pathname;"+
 "if(path==='/api/files/"+fixture+"')return Promise.resolve(new Response(JSON.stringify({ok:true,data:data.meta}),{status:200,headers:{'Content-Type':'application/json'}}));"+
 "if(path==='/api/files/"+fixture+"/preview')return Promise.resolve(new Response(JSON.stringify({ok:true,data:data.preview}),{status:200,headers:{'Content-Type':'application/json'}}));"+
 "return original(input,options);};})();";
const profile=mkdtempSync(join(tmpdir(),"fm-xmind-browser-"));
const port=19000+process.pid%20000;
const chrome=spawn("/usr/bin/google-chrome",["--headless=new","--no-sandbox","--disable-dev-shm-usage",
 "--remote-debugging-port="+port,"--user-data-dir="+profile,"--window-size=1440,900","about:blank"],{stdio:"ignore"});
let ws,seq=0;
const pending=new Map();
function send(method,params={}){
 const id=++seq;
 return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
}
async function evaluate(expression){
 const result=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
 if(result.exceptionDetails)throw Error("Chrome evaluation: "+JSON.stringify(result.exceptionDetails).slice(0,350));
 return result.result.value;
}
async function until(expression,label){
 for(let i=0;i<90;i++){
  if(await evaluate(expression))return;
  await sleep(145);
 }
 const body=await evaluate("document.body?.textContent?.slice(0,300)");
 throw Error(label+": timeout: "+JSON.stringify(body));
}
try{
 const login=await fetch(base+"/api/login",{method:"POST",headers:{"Content-Type":"application/json"},
  body:JSON.stringify({login:"admin",password})});
 assert.equal(login.ok,true,"login failed: "+login.status);
 const cookie=login.headers.getSetCookie().find(v=>v.startsWith("fm_session="))?.split(";")[0];
 assert.ok(cookie,"session cookie unavailable");
 let tab;
 for(let i=0;i<80&&!tab;i++){
  try{tab=(await(await fetch("http://127.0.0.1:"+port+"/json/list")).json()).find(x=>x.type==="page");}
  catch{}
  if(!tab)await sleep(130);
 }
 assert.ok(tab,"Chrome debugger did not start");
 ws=new WebSocket(tab.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true});});
 ws.addEventListener("message",event=>{
  const message=JSON.parse(event.data),p=pending.get(message.id);
  if(p){pending.delete(message.id);message.error?p.reject(Error(message.error.message)):p.resolve(message.result);}
 });
 await send("Page.enable");await send("Runtime.enable");await send("Network.enable");
 await send("Network.setCookie",{name:"fm_session",value:cookie.slice("fm_session=".length),url:base});
 await send("Page.addScriptToEvaluateOnNewDocument",{source:mockScript});
 await send("Page.navigate",{url:base+"/preview/"+fixture});
 await until("!!document.querySelector('.xmind-viewer .xmind-node.is-root')","mindmap rendered");
 assert.ok((await evaluate("document.querySelector('.xmind-node.is-root')?.textContent"))?.includes("DHF"));
 assert.equal(await evaluate("document.querySelectorAll('.xmind-sheet').length"),2);
 assert.ok(await evaluate("document.querySelectorAll('.xmind-edges path').length>10"),"missing mindmap connections");

 for(const [name,width,height] of [["desktop",1440,900],["laptop",1080,780],["narrow",760,760]]){
  await send("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
  await sleep(200);
  const dimensions=await evaluate("(()=>{const e=document.querySelector('.xmind-viewer'),s=document.querySelector('.xmind-surface'),r=document.querySelector('.xmind-node.is-root');if(!e||!s||!r)return null;const b=s.getBoundingClientRect(),n=r.getBoundingClientRect();return {width:b.width,height:b.height,rootVisible:n.left<b.right&&n.right>b.left&&n.top<b.bottom&&n.bottom>b.top,pageOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+2};})()");
  assert.ok(dimensions, name+" missing layout");
  assert.ok(dimensions.width>170&&dimensions.height>140,name+" viewer collapsed "+JSON.stringify(dimensions));
  assert.equal(dimensions.rootVisible,true,name+" root is outside viewport "+JSON.stringify(dimensions));
  assert.equal(dimensions.pageOverflow,false,name+" caused document horizontal scroll");
  console.log("XMIND_CHROME_VIEWPORT_PASS",name,dimensions.width,dimensions.height);
 }
 await evaluate("document.querySelector('.xmind-sheet:nth-child(2)')?.click()");
 await until("document.querySelector('.xmind-node.is-root')?.textContent?.includes('变更申请')","second sheet");
 await evaluate("document.querySelector('.xmind-sheet:first-child')?.click()");
 await until("document.querySelector('.xmind-node.is-root')?.textContent?.includes('DHF')","first sheet restored");
 await evaluate("document.querySelector('.xmind-outline-toggle')?.click()");
 await until("!!document.querySelector('.xmind-outline-search input')","outline open");
 await evaluate("(()=>{const input=document.querySelector('.xmind-outline-search input');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,'归档验收-最终确认');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
 await until("document.querySelectorAll('.xmind-outline-row').length===1","search result");
 await evaluate("document.querySelector('.xmind-outline-row')?.click()");
 await until("document.querySelector('.xmind-details')?.textContent?.includes('归档验收-最终确认')","search jump");
 assert.ok(await evaluate("document.querySelector('.xmind-details')?.textContent?.includes('审查人')"),"notes missing");
 const before=await evaluate("document.querySelector('.xmind-zoom').textContent");
 await evaluate("document.querySelector('.xmind-tools button[aria-label=\"放大\"]')?.click()");
 await until("document.querySelector('.xmind-zoom')?.textContent!=="+JSON.stringify(before),"zoom button");
 await evaluate("Array.from(document.querySelectorAll('.xmind-tools button')).find(b=>b.textContent==='收起')?.click()");
 await until("document.querySelectorAll('.xmind-node').length<20","fold deep");
 console.log("XMIND_CHROME_INTERACTION_PASS sheets/search/reveal/notes/zoom/fold");
}finally{
 try{ws?.close();}catch{}
 chrome.kill("SIGTERM");
 rmSync(profile,{recursive:true,force:true});
}
