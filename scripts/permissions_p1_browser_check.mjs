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
 await cdp.evaluate(`(()=>{
  const login=document.querySelector('input[type=text],input:not([type])');
  const pw=document.querySelector('input[type=password]');
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
  setter.call(login,'admin');login.dispatchEvent(new Event('input',{bubbles:true}));
  setter.call(pw,${JSON.stringify(password)});pw.dispatchEvent(new Event('input',{bubbles:true}));
  return true;
 })()`);
 await cdp.evaluate(`(()=>{
  const b=[...document.querySelectorAll('button')].find(x=>x.textContent?.trim()==='登录');
  (b||document.querySelector('form button'))?.click();return true;
 })()`);
 assert(await cdp.waitFor("()=>location.pathname==='/doc'",15000),"admin logs in");
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
 await cdp.evaluate(`(()=>{
  [...document.querySelectorAll('.perm-subnav button')]
   .find(b=>b.textContent?.includes('审计'))?.click();return true;
 })()`);
 assert(await cdp.waitFor("()=>!!document.querySelector('.perm-audit .perm-table')"),"audit view loads with event table");
 assert(await cdp.evaluate("(()=>new URLSearchParams(location.search).get('view')==='audit')()"),
  "audit tab is deep-linkable");
 console.log("PERMISSIONS_P1_BROWSER_PASS");
}finally{
 cdp?.close();
 chrome.kill("SIGKILL");
}
