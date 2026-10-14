#!/usr/bin/env node
// Read-only authenticated Chrome check of the Finder global search workbench.
// Run on the development host; creates no files/folders or fixture data.
import {spawn} from "node:child_process";
import {readFileSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
const base=process.env.FILESMANAGE_BASE??"http://127.0.0.1:18091";
if(!["127.0.0.1","localhost"].includes(new URL(base).hostname))throw Error("loopback target required");
const password=readFileSync(process.env.FILESMANAGE_ADMIN_PASSWORD_FILE??".secrets/admin.password","utf8").trim();
const login=await fetch(base+"/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({login:"admin",password})});
if(!login.ok)throw Error("login failed "+login.status);
const cookie=login.headers.getSetCookie().find(x=>x.startsWith("fm_session="))?.split(";")[0];
if(!cookie)throw Error("no session cookie");
const port=9700+Math.floor(Math.random()*180);
const dir=mkdtempSync(join(tmpdir(),"fm-search-readonly-"));
const chrome=spawn("/usr/bin/google-chrome",["--headless=new","--no-sandbox","--disable-gpu","--disable-dev-shm-usage","--user-data-dir="+dir,"--remote-debugging-port="+port,"about:blank"],{stdio:"ignore"});
let ws,id=0;const pending=new Map();
const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
const evaluate=async expr=>{const r=await send("Runtime.evaluate",{expression:expr,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error("browser JS error: "+JSON.stringify(r.exceptionDetails).slice(0,850)+" expression: "+expr.slice(0,160));return r.result?.value;};
const wait=async expr=>{for(let i=0;i<100;i++){if(await evaluate(expr))return;await sleep(140);}throw Error("timeout "+expr);};
try{
 let page;
 for(let i=0;i<70&&!page;i++){await sleep(200);try{const ls=await(await fetch("http://127.0.0.1:"+port+"/json/list")).json();page=ls.find(x=>x.type==="page");}catch{}}
 if(!page)throw Error("Chrome not ready");
 ws=new WebSocket(page.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true});});
 ws.addEventListener("message",e=>{const m=JSON.parse(e.data);if(!m.id)return;const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);});
 await send("Page.enable");await send("Runtime.enable");await send("Network.enable");
 await send("Network.setCookie",{name:"fm_session",value:cookie.split("=")[1],url:base+"/search",httpOnly:true});
 for(const width of [1440,1024,820,390]){
  await send("Emulation.setDeviceMetricsOverride",{width,height:850,deviceScaleFactor:1,mobile:false});
  await send("Page.navigate",{url:base+"/search"});
  await wait("!!document.querySelector('#search-q') && !!document.querySelector('.search-finder-table tbody tr')");
  await evaluate("document.querySelector(\'.search-finder-table tbody tr\').click()");
  await wait("document.querySelector(\'.search-finder-table tbody tr\')?.classList.contains(\'is-selected\')");
  const result=await evaluate("(()=>{const a=document.querySelector('.global-search').getBoundingClientRect(),b=document.querySelector('.search-results').getBoundingClientRect(),row=document.querySelector('.search-finder-table tbody tr'),table=row?.closest('table');if(!row)return {missing:true,url:location.href,html:document.body.innerText.slice(0,100)};return {width:"+width+",overflow:document.documentElement.scrollWidth-innerWidth,searchWidth:a.width,resultWidth:b.width,rows:document.querySelectorAll('.search-finder-table tbody tr').length,selected:row.classList.contains('is-selected'),rare:table.hasAttribute('data-rare-table'),actions:row.querySelectorAll('.search-row-action').length,sidebar:getComputedStyle(document.querySelector('.search-filters')).display};})()");
  if(result.overflow>2||result.resultWidth<180||!result.selected||!result.rare||result.actions!==2)throw Error("layout failure "+JSON.stringify(result));
  console.log("SEARCH_UI_PASS "+JSON.stringify(result));
  if(width===390){
   await evaluate("document.querySelector('.search-mobile-filters').click()");
   const open=await evaluate("getComputedStyle(document.querySelector('.search-filters')).display !== 'none'");
   if(!open)throw Error("mobile filter didn't open");console.log("SEARCH_FILTER_MOBILE_PASS");
  }
 }
 console.log("SEARCH_READONLY_BROWSER_PASS");
}finally{ws?.close();chrome.kill("SIGTERM");await sleep(650);rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:150});}
