#!/usr/bin/env node
// Read-only performance and DOM-bounding gate; run on the remote dev host.
// Synthetic organization payloads are injected into this Chrome tab's fetch,
// never written to the real database. Authentication is a verified real session.
import {spawn} from "node:child_process";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {verifiedAdminSession} from "./qa_session.mjs";

const BASE="http://127.0.0.1:18091";
const dir=mkdtempSync(join(tmpdir(),"fm-org-load-"));
const port=9600+Math.floor(Math.random()*400);
let chrome,ws;
let id=0;
const pending=new Map();
function check(ok,text,detail=""){
 console.log((ok?"PASS ":"FAIL ")+text+(detail?" :: "+detail:""));
 if(!ok)throw Error(text);
}
async function cmd(method,params={}){
 const current=++id;
 return new Promise((resolve,reject)=>{
  pending.set(current,{resolve,reject});
  ws.send(JSON.stringify({id:current,method,params}));
 });
}
async function evalBrowser(expression){
 const result=await cmd("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
 if(result.exceptionDetails)throw Error("browser evaluation failed");
 return result.result.value;
}
async function waitFor(condition,timeout=12000){
 const start=Date.now();
 while(Date.now()-start<timeout){
  if(await evalBrowser("("+condition+")()").catch(()=>false))return Date.now()-start;
  await delay(80);
 }
 throw Error("browser condition timeout");
}
const inject=`(()=>{
 const originalFetch=window.fetch.bind(window);
 const users=Array.from({length:1000},(_,n)=>({
  id:"stress-user-"+String(n).padStart(4,"0"),
  login:"stress-user-"+String(n).padStart(4,"0"),
  displayName:"压测成员"+String(n).padStart(4,"0"),
  isAdmin:false,mustChangePassword:false,disabled:false,departmentId:""
 }));
 const groups=Array.from({length:400},(_,n)=>({
  id:"stress-group-"+String(n).padStart(3,"0"),
  name:"压测工作组"+String(n).padStart(3,"0"),departmentId:null
 }));
 const respond=data=>Promise.resolve(new Response(JSON.stringify({ok:true,data}),{
  status:200,headers:{"Content-Type":"application/json"}
 }));
 window.fetch=(resource,init)=>{
  const url=new URL(typeof resource==="string"?resource:resource.url,location.href);
  const method=(init?.method??"GET").toUpperCase();
  if(method==="GET"&&url.origin===location.origin){
   if(url.pathname==="/api/users")return respond(users);
   if(url.pathname==="/api/groups")return respond(groups);
   if(url.pathname==="/api/groups/stress-group-000/members")return respond(users.slice(0,420));
  }
  return originalFetch(resource,init);
 };
})()`;

try{
 const session=await verifiedAdminSession(BASE);
 chrome=spawn("/usr/bin/google-chrome",[
  "--headless=new","--no-sandbox","--disable-dev-shm-usage",
  "--remote-debugging-port="+port,"--user-data-dir="+dir,
  "--window-size=1440,900","about:blank",
 ],{stdio:"ignore"});
 let target;
 for(let n=0;n<60&&!target;n++){
  await delay(150);
  try{
   const tabs=await(await fetch("http://127.0.0.1:"+port+"/json/list")).json();
   target=tabs.find(x=>x.type==="page");
  }catch{}
 }
 check(!!target,"Chrome stress browser started");
 ws=new WebSocket(target.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{
  ws.addEventListener("open",resolve,{once:true});
  ws.addEventListener("error",reject,{once:true});
 });
 ws.addEventListener("message",e=>{
  const msg=JSON.parse(e.data);
  const task=pending.get(msg.id);
  if(!task)return;
  pending.delete(msg.id);
  msg.error?task.reject(Error(msg.error.message)):task.resolve(msg.result);
 });
 await cmd("Page.enable");
 await cmd("Runtime.enable");
 await cmd("Network.enable");
 await cmd("Network.setCookie",{
  name:"fm_session",value:session.cookie.slice("fm_session=".length),
  domain:new URL(BASE).hostname,path:"/",httpOnly:true,sameSite:"Strict",
 });
 await cmd("Page.addScriptToEvaluateOnNewDocument",{source:inject});
 const start=Date.now();
 await cmd("Page.navigate",{url:BASE+"/org?tab=members"});
 await waitFor("()=>document.querySelector('.org-table-container tbody')?.children.length===100");
 const initialMs=Date.now()-start;
 check(initialMs<15000,"1000-member initial render is bounded",initialMs+"ms, 100 DOM rows");
 const initialCount=await evalBrowser("(()=>document.querySelector('.org-filter-bar .toolbar-hint')?.textContent)()");
 check(initialCount?.includes("100 / 1000"),"full 1000-member count preserved",initialCount);
 await evalBrowser(`(()=>{
  const button=[...document.querySelectorAll(".org-list-more button")]
   .find(b=>b.textContent?.includes("显示更多成员"));
  button?.click();return !!button;
 })()`);
 await waitFor("()=>document.querySelector('.org-table-container tbody')?.children.length===200");
 check(true,"member show-more reaches 200 DOM rows");
 const searchStart=Date.now();
 await evalBrowser(`(()=>{
  const el=document.querySelector('input[aria-label="搜索成员"]');
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;
  setter.call(el,"stress-user-0999");el.dispatchEvent(new Event("input",{bubbles:true}));
  return true;
 })()`);
 await waitFor("()=>document.querySelector('.org-table-container tbody')?.children.length===1 && document.querySelector('.org-table-container tbody')?.textContent?.includes('stress-user-0999')");
 check(Date.now()-searchStart<5000,"1000-member search responds","under "+(Date.now()-searchStart)+"ms");
 await evalBrowser(`(()=>{
  const tab=[...document.querySelectorAll("button.org-tab")]
   .find(b=>b.textContent?.includes("工作组"));
  tab?.click();return !!tab;
 })()`);
 await waitFor("()=>document.querySelectorAll('.org-group-cards-list > li').length===60");
 check(true,"400-group first paint is bounded at 60 cards");
 await waitFor("()=>document.querySelectorAll('.org-member-grid .org-member-card').length===100");
 check(true,"420-group-member first paint is bounded at 100 cards");
 await evalBrowser(`(()=>{
  [...document.querySelectorAll(".org-list-more button")]
   .find(b=>b.textContent?.includes("显示更多工作组"))?.click();return true;
 })()`);
 await waitFor("()=>document.querySelectorAll('.org-group-cards-list > li').length===120");
 check(true,"show-more reveals 120 group cards");
 await evalBrowser(`(()=>{
  [...document.querySelectorAll(".org-list-more button")]
   .find(b=>b.textContent?.includes("显示更多组内成员"))?.click();return true;
 })()`);
 await waitFor("()=>document.querySelectorAll('.org-member-grid .org-member-card').length===200");
 check(true,"show-more reveals 200 group members");
 const groupSearchStart=Date.now();
 await evalBrowser(`(()=>{
  const el=document.querySelector('input[placeholder="搜索工作组..."]');
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;
  setter.call(el,"压测工作组399");el.dispatchEvent(new Event("input",{bubbles:true}));
  return true;
 })()`);
 await waitFor("()=>document.querySelectorAll('.org-group-cards-list > li').length===1 && document.querySelector('.org-group-cards-list')?.textContent?.includes('压测工作组399')");
 check(Date.now()-groupSearchStart<5000,"400-group search responds",Date.now()-groupSearchStart+"ms");
 console.log("ORG_LARGE_DATA_BROWSER_PASS users=1000 groups=400 group_members=420");
}finally{
 ws?.close();chrome?.kill("SIGKILL");
 rmSync(dir,{recursive:true,force:true});
}
