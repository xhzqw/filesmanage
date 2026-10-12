#!/usr/bin/env node
// Isolated WF-31 approval UI regression independent of the rollback/restore suite.
// Must be run through ux_isolated_lab.sh; the fixture guard refuses shared DBs.
import {spawn} from "node:child_process";
import {readFileSync} from "node:fs";
import {setTimeout as delay} from "node:timers/promises";
import {assertIsolatedFixtures} from "./ux_fixture_guard.mjs";

const args=process.argv.slice(2);
const option=(key,otherwise)=>{
 const index=args.indexOf("--"+key);
 return index<0?otherwise:args[index+1];
};
const BASE=option("base","").replace(/\/+$/,"");
const PASSWORD_FILE=option("password-file","");
const PORT=Number(option("port","9373"));
assertIsolatedFixtures({base:BASE,args,explicitBase:args.includes("--base")});
const password=readFileSync(PASSWORD_FILE,"utf8").trim();

class CDP {
 constructor(ws){
  this.ws=ws;this.next=1;this.pending=new Map();
  ws.addEventListener("message",event=>{
   const msg=JSON.parse(event.data);
   if(!msg.id||!this.pending.has(msg.id))return;
   const pending=this.pending.get(msg.id);this.pending.delete(msg.id);
   msg.error?pending.reject(new Error(msg.error.message)):pending.resolve(msg.result);
  });
 }
 static async connect(url){
  const ws=new WebSocket(url);
  await new Promise((ok,fail)=>{
   ws.addEventListener("open",ok,{once:true});
   ws.addEventListener("error",()=>fail(new Error("CDP websocket failed")),{once:true});
  });
  return new CDP(ws);
 }
 send(method,params={}){
  const id=this.next++;
  return new Promise((resolve,reject)=>{
   this.pending.set(id,{resolve,reject});
   this.ws.send(JSON.stringify({id,method,params}));
  });
 }
 async evaluate(expression){
  const result=await this.send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails)throw new Error("Browser evaluate failed: "+expression.slice(0,90));
  return result.result.value;
 }
 async waitFor(predicate,timeoutMs=15000){
  const end=Date.now()+timeoutMs;
  while(Date.now()<end){
   const value=await this.evaluate("(" + predicate + ")()");
   if(value)return value;
   await delay(220);
  }
  throw new Error("Browser timed out: "+predicate.slice(0,110));
 }
 close(){this.ws.close();}
}

let cookie="";
let folderId="";
let fileId="";
let chrome=null;
let cdp=null;
const stamp=String(Date.now());
const filename="wf31-rare-"+stamp+".txt";
const comment="Rare WF31 自动审批意见 "+stamp;
async function api(method,path,body){
 const response=await fetch(BASE+"/api"+path,{
  method,
  headers:{Origin:BASE,Cookie:cookie,...(body===undefined?{}:{"Content-Type":"application/json"})},
  body:body===undefined?undefined:JSON.stringify(body),
 });
 const payload=await response.json().catch(()=>null);
 if(!response.ok||payload?.ok===false)throw new Error(method+" "+path+" returned "+response.status+" "+JSON.stringify(payload?.error??{}));
 return payload?.data;
}
function check(condition,label){
 if(!condition)throw new Error("FAIL "+label);
 console.log("PASS "+label);
}
async function run(){
 const response=await fetch(BASE+"/api/login",{
  method:"POST",headers:{"Content-Type":"application/json"},
  body:JSON.stringify({login:"admin",password}),
 });
 cookie=response.headers.getSetCookie().find(x=>x.startsWith("fm_session="))?.split(";")[0]??"";
 check(response.ok&&!!cookie,"isolated admin session");
 const me=await api("GET","/me");
 const tree=await api("GET","/folders/tree");
 const root=tree.find(x=>x.id==="folder_root")??tree.find(x=>!x.parentId);
 folderId=(await api("POST","/folders",{parentId:root.id,name:"UX-WF31-"+stamp})).id;
 const data=new FormData();
 data.set("folderId",folderId);
 data.set("file",new Blob(["rare ui approval test "+stamp+"\n"]),filename);
 const uploadResponse=await fetch(BASE+"/api/files",{method:"POST",headers:{Cookie:cookie,Origin:BASE},body:data});
 const uploaded=await uploadResponse.json();
 check(uploadResponse.ok&&!!uploaded.data?.fileId,"fixture uploaded in isolated DB");
 fileId=uploaded.data.fileId;
 const token=(await api("POST","/files/"+fileId+"/lock",{baseSeq:1})).lockToken;
 await api("PUT","/folders/"+folderId+"/approval-policy",{approverId:me.id,enabled:true});
 const changed=await api("POST","/files/"+fileId+"/save",{
  baseSeq:1,lockToken:token,data:btoa("approved content "+stamp+"\n"),
  idempotencyKey:"rare-wf31-"+stamp,
 });
 check(changed?.status==="pending"||changed?.status==="awaiting_approval","new version awaits approval");
 chrome=spawn("/usr/bin/google-chrome",[
  "--headless=new","--no-sandbox","--disable-gpu","--window-size=1440,900",
  "--remote-debugging-port="+PORT,"about:blank",
 ],{stdio:"ignore"});
 await delay(1250);
 const targets=await (await fetch("http://127.0.0.1:"+PORT+"/json/list")).json();
 cdp=await CDP.connect(targets.find(x=>x.type==="page").webSocketDebuggerUrl);
 await cdp.send("Page.enable");
 await cdp.send("Runtime.enable");
 await cdp.send("Network.enable");
 const set=await cdp.send("Network.setCookie",{
  name:"fm_session",value:cookie.slice("fm_session=".length),url:BASE+"/approvals",httpOnly:true,
 });
 check(set.success!==false,"browser session established");
 await cdp.send("Page.navigate",{url:BASE+"/approvals"});
 const rowQuery=JSON.stringify(filename);
 await cdp.waitFor("()=>[...document.querySelectorAll('.approval-list-row')].some(r=>r.textContent?.includes("+rowQuery+"))",25000);
 check(true,"pending document row rendered in Finder inbox");
 await cdp.evaluate("(()=>{const r=[...document.querySelectorAll('.approval-list-row')].find(r=>r.textContent?.includes("+rowQuery+"));r.click();return true;})()");
 await cdp.waitFor("()=>document.querySelector('.approval-detail-content')?.textContent?.includes("+rowQuery+")");
 await cdp.evaluate("(()=>{[...document.querySelectorAll('.approval-detail-actions button')].find(b=>b.textContent?.trim()==='通过')?.click();return true;})()");
 await cdp.waitFor("()=>!!document.querySelector('dialog.approval-decision-dialog[open] textarea')");
 check(true,"inspector decision opens the optional-comment dialog");
 await cdp.evaluate("(()=>{const el=document.querySelector('dialog.approval-decision-dialog[open] textarea');const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(el,"+JSON.stringify(comment)+");el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()");
 await cdp.evaluate("(()=>{const d=document.querySelector('dialog.approval-decision-dialog[open]');[...d.querySelectorAll('button')].find(b=>b.textContent?.trim()==='确认通过').click();return true;})()");
 await cdp.waitFor("()=>!document.querySelector('dialog.approval-decision-dialog[open]')",25000);
 await cdp.waitFor("()=>[...document.querySelectorAll('.approval-nav-item')].some(b=>b.textContent?.includes('我发起的'))");
 await cdp.evaluate("(()=>{[...document.querySelectorAll('.approval-nav-item')].find(b=>b.textContent?.includes('我发起的')).click();return true;})()");
 await cdp.waitFor("()=>[...document.querySelectorAll('.approval-list-row')].some(r=>r.textContent?.includes("+rowQuery+"))",25000);
 await cdp.evaluate("(()=>{[...document.querySelectorAll('.approval-list-row')].find(r=>r.textContent?.includes("+rowQuery+")).click();return true;})()");
 await cdp.waitFor("()=>document.querySelector('.approval-detail-content')?.textContent?.includes("+JSON.stringify(comment)+")",25000);
 check(true,"approval comment rendered in the right inspector");
 const approved=(await api("GET","/approvals?scope=mine")).find(x=>x.fileId===fileId);
 check(approved?.state==="approved"&&approved.decisionComment===comment,"server persisted approved state and comment");
 const record=await api("GET","/approvals/"+approved.id);
 check(record?.state==="approved"&&record.id===approved.id,"completed approval record remains readable");
 const versions=await api("GET","/files/"+fileId);
 check(versions?.file?.currentVersionSeq===2,"approval generated the committed version");
 await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await delay(450);
 const mobile=await cdp.evaluate("(()=>{const row=[...document.querySelectorAll('.approval-list-row')].find(r=>r.textContent?.includes("+rowQuery+"));const file=row?.querySelector('.approval-row-core strong')?.getBoundingClientRect();const state=row?.querySelector('.rare-badge')?.getBoundingClientRect();const side=document.querySelector('.approval-side');return {file:!!file&&file.width>60&&file.left>=0&&file.right<=innerWidth+1,state:!!state&&state.width>30&&state.right<=innerWidth+1,inspector:getComputedStyle(side).display!=='none',overflow:document.documentElement.scrollWidth-innerWidth};})()");
 check(mobile.file&&mobile.state&&mobile.inspector&&mobile.overflow<=1,"390px file/status/inspector accessible without page overflow: "+JSON.stringify(mobile));
 console.log("UX_APPROVAL_PASS");
}
try{
 await run();
}catch(error){
 console.error("UX_APPROVAL_FAILED: "+String(error?.message??error));
 process.exitCode=1;
}finally{
 cdp?.close();
 chrome?.kill("SIGKILL");
 if(fileId)await api("DELETE","/files/"+fileId).catch(()=>{});
 if(folderId)await api("DELETE","/folders/"+folderId).catch(()=>{});
}
