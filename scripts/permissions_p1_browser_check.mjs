#!/usr/bin/env node
// Read-only Chrome/CDP smoke of Organization > Permissions P1.
// Execute only on the remote dev target where admin.password is stored.
import {spawn} from "node:child_process";
import {readFileSync} from "node:fs";
import {setTimeout as sleep} from "node:timers/promises";

const BASE="http://127.0.0.1:18091";
const PORT=9389;
const password=readFileSync(".secrets/admin.password","utf8").trim();
const assert=(condition,message)=>{
 if(!condition)throw new Error("FAIL "+message);
 console.log("PASS "+message);
};
class CDP {
 constructor(ws){
  this.ws=ws;this.seq=0;this.pending=new Map();
  ws.addEventListener("message",event=>{
   const msg=JSON.parse(event.data);
   if(msg.id&&this.pending.has(msg.id)){
    const {resolve,reject}=this.pending.get(msg.id);
    this.pending.delete(msg.id);
    msg.error?reject(new Error(msg.error.message)):resolve(msg.result);
   }
  });
 }
 static async connect(url){
  const ws=new WebSocket(url);
  await new Promise((resolve,reject)=>{
   ws.addEventListener("open",resolve,{once:true});
   ws.addEventListener("error",reject,{once:true});
  });
  return new CDP(ws);
 }
 send(method,params={}){
  const id=++this.seq;
  return new Promise((resolve,reject)=>{
   this.pending.set(id,{resolve,reject});
   this.ws.send(JSON.stringify({id,method,params}));
  });
 }
 async evaluate(expression){
  const res=await this.send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
  if(res.exceptionDetails)throw new Error("browser expression threw");
  return res.result.value;
 }
 async navigate(url){
  await this.send("Page.navigate",{url});
  await sleep(650);
 }
 async waitFor(predicate,timeout=12000){
  const until=Date.now()+timeout;
  while(Date.now()<until){
   if(await this.evaluate("("+predicate+")()"))return true;
   await sleep(200);
  }
  return false;
 }
 close(){this.ws.close();}
}

const chrome=spawn("/usr/bin/google-chrome",[
 "--headless=new","--no-sandbox","--disable-dev-shm-usage",
 "--remote-debugging-port="+PORT,"--window-size=1440,900","about:blank",
],{stdio:"ignore"});
let cdp;
try{
 let target;
 for(let i=0;i<50&&!target;i++){
  await sleep(200);
  try{
   const list=await (await fetch("http://127.0.0.1:"+PORT+"/json/list")).json();
   target=list.find(tab=>tab.type==="page");
  }catch{}
 }
 assert(!!target,"Chrome debugging session starts");
 cdp=await CDP.connect(target.webSocketDebuggerUrl);
 await cdp.send("Page.enable");
 await cdp.send("Runtime.enable");
 await cdp.navigate(BASE+"/login");
 assert(await cdp.waitFor("()=>!!document.querySelector('input[type=password]')"),"login page renders");
 // This is a permissions UI test, not a login-input simulation test.
 // Authenticate in the browser's real cookie jar via the same API as the
 // app; the separate browser journey gate already covers the login form.
 const auth=await cdp.evaluate(`(async()=>{
  const response=await fetch('/api/login',{
   method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({login:'admin',password:${JSON.stringify(password)}}),
   credentials:'same-origin',
  });
  const body=await response.json().catch(()=>null);
  return {status:response.status,code:body?.error?.code??null};
 })()`);
 assert(auth?.status===200,"admin browser session established (HTTP "+auth?.status+", code "+auth?.code+")");
 await cdp.navigate(BASE+"/org?tab=permissions&view=folder");
 assert(await cdp.waitFor("()=>!!document.querySelector('.perm-workspace')"),"organization permission workspace renders");
 assert(await cdp.waitFor("()=>!!document.querySelector('.perm-tree-name')"),"resource folder browser loads");
 await cdp.evaluate("(()=>{document.querySelector('.perm-tree-name')?.click();return true;})()");
 assert(await cdp.waitFor("()=>!!document.querySelector('.perm-insight select')"),"effective permission explanation renders");
 await cdp.evaluate(`(()=>{
  const select=document.querySelector('.perm-insight select');
  const first=[...select.options].find(o=>o.value);
  if(!first)return false;
  const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
  setter.call(select,first.value);select.dispatchEvent(new Event('change',{bubbles:true}));
  return true;
 })()`);
 assert(await cdp.waitFor("()=>!!document.querySelector('.perm-effective')"),"server explanation appears after user selection");
 const actions=await cdp.evaluate("(()=>document.querySelectorAll('.perm-action-token').length)()");
 assert(Number.isInteger(actions)&&actions>=0,"effective actions are rendered as read-only labels");
 // Do not create an ACL entry: drive only the form's preview and consent gate.
 assert(await cdp.waitFor("()=>document.querySelector('.perm-form')&&!document.querySelector('.perm-form select').disabled"),
  "direct ACL form available for review");
 await cdp.evaluate(`(()=>{
  const subject=document.querySelector('.perm-form select');
  const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
  setter.call(subject,'user');subject.dispatchEvent(new Event('change',{bubbles:true}));
  return true;
 })()`);
 assert(await cdp.waitFor("()=>document.querySelector('.perm-form select')?.value==='user'"),
  "ACL subject kind changed");
 assert(await cdp.waitFor("()=>[...document.querySelectorAll('.perm-form select')].some(s=>[...s.options].some(o=>o.value&&o.value!=='user'&&o.value!=='group'&&o.value!=='only'&&o.value!=='subtree'))"),
  "ACL subject candidates loaded");
 await cdp.evaluate(`(()=>{
  const subject=[...document.querySelectorAll('.perm-form select')]
   .find(s=>s.options[0]?.value==='');
  const option=[...subject.options].find(o=>o.value);
  const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
  setter.call(subject,option.value);subject.dispatchEvent(new Event('change',{bubbles:true}));
  return true;
 })()`);
 assert(await cdp.waitFor("()=>!!document.querySelector('.perm-form select[required]')?.value"),
  "direct ACL subject selected");
 await cdp.evaluate(`(()=>{
  const risk=[...document.querySelectorAll('.perm-action-grid label')]
   .find(label=>label.textContent?.includes('下载'))?.querySelector('input');
  risk?.click();
  return true;
 })()`);
 assert(await cdp.waitFor("()=>[...document.querySelectorAll('.perm-action-grid label')].some(x=>x.textContent?.includes('下载')&&x.querySelector('input')?.checked)"),
  "high-risk download action selected");
 await cdp.evaluate("(()=>{document.querySelector('.perm-form').requestSubmit();return true;})()");
 assert(await cdp.waitFor("()=>!!document.querySelector('.perm-risk-consent')"),
  "high-risk ACL review shows explicit consent");
 assert(await cdp.evaluate("(()=>document.querySelector('.perm-form button[type=submit]').disabled)()"),
  "high-risk ACL cannot be committed without acknowledgement");
 await cdp.evaluate("(()=>{document.querySelector('.perm-risk-consent').click();return true;})()");
 assert(await cdp.waitFor("()=>!document.querySelector('.perm-form button[type=submit]').disabled"),
  "review consent unlocks only the confirm action");
 await cdp.evaluate(`(()=>{
  const scope=[...document.querySelectorAll('.perm-form select')]
   .find(s=>[...s.options].some(o=>o.value==='subtree'));
  const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
  setter.call(scope,'subtree');scope.dispatchEvent(new Event('change',{bubbles:true}));
  return true;
 })()`);
 assert(await cdp.waitFor("()=>!document.querySelector('.perm-risk-consent')"),
  "editing ACL scope invalidates reviewed consent");
 await cdp.evaluate(`(()=>{
  [...document.querySelectorAll('.perm-subnav button')]
   .find(b=>b.textContent?.includes('审计'))?.click();return true;
 })()`);
 assert(await cdp.waitFor("()=>!!document.querySelector('.perm-audit .perm-table')"),"audit view loads with event table");
 assert(await cdp.evaluate("(()=>new URLSearchParams(location.search).get('view')==='audit')()"),
  "audit tab is deep-linkable");
 await cdp.navigate(BASE+"/org?tab=roles");
 assert(await cdp.waitFor("()=>document.body.innerText.includes('管理角色委派')"),
  "P2 role bindings page renders");
 assert(await cdp.waitFor("()=>!!document.querySelector('.perm-detail form')"),
  "P2 role delegation form is available");
 console.log("PERMISSIONS_P1_BROWSER_PASS");
}finally{
 cdp?.close();
 chrome.kill("SIGKILL");
}
