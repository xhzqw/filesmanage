#!/usr/bin/env node
// Read-only signing workbench browser regression: staging a mark never calls sign/commit.
import {spawn} from "node:child_process";
import {readFileSync} from "node:fs";
import {setTimeout as delay} from "node:timers/promises";

const BASE=(process.argv[2]||"http://127.0.0.1:18091").replace(/\/+$/,"");
const PORT=9467;
const password=readFileSync(".secrets/admin.password","utf8").trim();
const checks=[];
function assert(name,ok,detail=""){
 checks.push([name,!!ok]);console.log((ok?"PASS ":"FAIL ")+name+(detail?" :: "+detail:""));
}
class CDP {
 constructor(ws){
  this.ws=ws;this.index=1;this.pending=new Map();
  ws.addEventListener("message",event=>{
   const data=JSON.parse(event.data);
   if(data.id&&this.pending.has(data.id)){
    const {resolve,reject}=this.pending.get(data.id);this.pending.delete(data.id);
    data.error?reject(new Error(data.error.message)):resolve(data.result);
   }
  });
 }
 static async connect(url){
  const ws=new WebSocket(url);
  await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true})});
  return new CDP(ws);
 }
 send(method,params={}){
  const id=this.index++;
  return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}))});
 }
 async evaluate(expr){
  const out=await this.send("Runtime.evaluate",{expression:expr,returnByValue:true,awaitPromise:true});
  if(out.exceptionDetails)throw new Error(JSON.stringify(out.exceptionDetails).slice(0,500));
  return out.result.value;
 }
 async waitFor(expr,ms=12000){
  const until=Date.now()+ms;
  do{
   const answer=await this.evaluate("("+expr+")()");
   if(answer)return answer;
   await delay(200);
  }while(Date.now()<until);
  return null;
 }
 async drag(from,to){
  await this.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:from.x,y:from.y});
  await this.send("Input.dispatchMouseEvent",{type:"mousePressed",x:from.x,y:from.y,button:"left",clickCount:1});
  await delay(130);
  for(let step=1;step<=5;step++){
   await this.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:from.x+(to.x-from.x)*step/5,y:from.y+(to.y-from.y)*step/5,buttons:1});
   await delay(55);
  }
  await this.send("Input.dispatchMouseEvent",{type:"mouseReleased",x:to.x,y:to.y,button:"left",clickCount:1});
  await delay(250);
 }
 close(){this.ws.close()}
}
const chrome=spawn("/usr/bin/google-chrome",["--headless=new",`--remote-debugging-port=${PORT}`,"--no-sandbox",
 "--disable-dev-shm-usage","--window-size=1440,900","about:blank"],{stdio:"ignore"});
let cdp;
try{
 const login=await fetch(BASE+"/api/login",{method:"POST",headers:{"Content-Type":"application/json"},
  body:JSON.stringify({login:"admin",password})});
 if(!login.ok)throw new Error("Cannot log into isolated browser test");
 const cookie=login.headers.getSetCookie().find(s=>s.startsWith("fm_session="))?.split(";")[0];
 if(!cookie)throw new Error("No session cookie");
 const files=await(await fetch(BASE+"/api/files?folder=folder_root&limit=200",{headers:{Cookie:cookie}})).json();
 const pdf=(files.data?.items??[]).find(item=>item.name?.toLowerCase().endsWith(".pdf"));
 if(!pdf)throw new Error("No existing root PDF for read-only signing test");
 let target;
 for(let i=0;i<55&&!target;i++){
  await delay(180);
  try{target=(await(await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t=>t.type==="page")}catch{}
 }
 if(!target)throw new Error("Chrome failed to start");
 cdp=await CDP.connect(target.webSocketDebuggerUrl);
 await cdp.send("Page.enable");await cdp.send("Runtime.enable");await cdp.send("Network.enable");
 await cdp.send("Network.setCookie",{name:"fm_session",value:cookie.slice("fm_session=".length),url:BASE});
 await cdp.send("Page.navigate",{url:BASE+"/preview/"+encodeURIComponent(pdf.id)+"?tab=seals"});
 const ready=await cdp.waitFor(`()=>!!document.querySelector('#file-seals-sidebar .seal-file-controls')&&
  !!document.querySelector('.seal-page-surface>img')&&document.querySelector('.seal-page-surface>img').naturalWidth>0`,20000);
 assert("signing controls and PDF page mount in split workbench",ready);
 if(ready){
  const geometry=await cdp.evaluate(`(()=>{
   const left=document.querySelector('#file-seals-sidebar').getBoundingClientRect();
   const right=document.querySelector('.seal-page-viewport').getBoundingClientRect();
   const paper=document.querySelector('.seal-page-surface').getBoundingClientRect();
   return {left:left.width,right:right.width,page:paper.width,distinct:right.left>=left.right-4};
  })()`);
  assert("signing page gets spacious right-hand canvas",geometry.right>580&&geometry.page>350&&geometry.distinct,JSON.stringify(geometry));
  const enabled=await cdp.evaluate(`(()=>{
   const list=document.querySelector('#file-seals-sidebar select');
   return [...(list?.options??[])].filter(o=>o.value&&!o.disabled).length;
  })()`);
  if(enabled){
   await cdp.evaluate(`(()=>{document.querySelector('#file-seals-sidebar .rare-select')?.click()})()`);
   const chose=await cdp.waitFor(`()=>[...document.querySelectorAll('[role="option"]')].some(o=>!o.disabled&&o.textContent.trim()!=='选择人员或公章')`,4500);
   assert("signing asset selection opens RareUI listbox",Boolean(chose));
   if(chose){
    await cdp.evaluate(`(()=>{[...document.querySelectorAll('[role="option"]')].find(o=>!o.disabled&&o.textContent.trim()!=='选择人员或公章')?.click()})()`);
    const mark=await cdp.waitFor(`()=>!!document.querySelector('.seal-position-mark.is-editable')`,4500);
    assert("selected signing asset has movable page overlay",Boolean(mark));
    if(mark){
     const before=await cdp.evaluate(`(()=>{
      const p=document.querySelector('.seal-position-mark').getBoundingClientRect();
      return {x:p.x+p.width*.45,y:p.y+p.height*.45,left:parseFloat(document.querySelector('.seal-position-mark').style.left),width:parseFloat(document.querySelector('.seal-position-mark').style.width)};
     })()`);
     await cdp.drag({x:before.x,y:before.y},{x:before.x+48,y:before.y-25});
     const after=await cdp.evaluate(`(()=>parseFloat(document.querySelector('.seal-position-mark').style.left))()`);
     assert("mark moves through real pointer drag",after>before.left+1,"left "+before.left+" → "+after);
     const handle=await cdp.evaluate(`(()=>{
      const h=document.querySelector('.seal-resize-handle').getBoundingClientRect();
      return {x:h.x+h.width/2,y:h.y+h.height/2};
     })()`);
     await cdp.drag(handle,{x:handle.x+25,y:handle.y+12});
     const width=await cdp.evaluate(`(()=>parseFloat(document.querySelector('.seal-position-mark').style.width))()`);
     assert("mark resizes through pointer handle",width>before.width+1,"width "+before.width+" → "+width);
     const add=await cdp.evaluate(`(()=>{
      const button=[...document.querySelectorAll('#file-seals-sidebar button')].find(b=>b.textContent?.includes('加入待签清单'));
      if(!button||button.disabled)return false;button.click();return true;
     })()`);
     await delay(150);
     assert("positioned mark enters draft without applying seal",add&&await cdp.evaluate(`(()=>document.querySelectorAll('.seal-draft-row').length===1)()`));
    }
   }
  }else console.log("SKIP asset editing: no unconsumed authorized signing assets");
 }
 await cdp.evaluate(`(()=>{
  [...document.querySelectorAll('.file-workbench-nav-item')].find(b=>b.textContent.trim()==='预览')?.click();
 })()`);
 const persisted=await cdp.evaluate(`(()=>!!document.querySelector('.file-workbench-signing[hidden] .seal-draft-row'))()`);
 assert("pending signing draft stays mounted while reading document",persisted);
 await cdp.evaluate(`(()=>{[...document.querySelectorAll('.file-workbench-nav-item')].find(b=>b.textContent.trim()==='签名与盖章')?.click()})()`);
 await delay(200);
 const restored=await cdp.evaluate(`(()=>!!document.querySelector('.file-workbench-signing:not([hidden]) .seal-draft-row'))()`);
 assert("pending signing draft is restored after switching back",restored);
 await cdp.evaluate(`(()=>{[...document.querySelectorAll('.file-workbench-nav-item')].find(b=>b.textContent.trim()==='预览')?.click()})()`);
 const dock=await cdp.evaluate(`(()=>{
  const buttons=[...document.querySelectorAll('.file-workbench-actions>button')];
  if(buttons.length!==3)return null;
  const widths=buttons.map(b=>b.getBoundingClientRect().width);
  buttons[2].click();
  return {length:buttons.length,widths};
 })()`);
 const expanded=await cdp.waitFor(`()=>!!document.querySelector('.file-action-expansion')`,3000);
 await delay(260);
 const above=await cdp.evaluate(`(()=>{
  const more=document.querySelector('.file-workbench-actions');
  const expanded=document.querySelector('.file-action-expansion');
  return !!more&&!!expanded&&expanded.getBoundingClientRect().bottom<=more.getBoundingClientRect().top+2;
 })()`);
 assert("download, print and more occupy same-width button row",!!dock&&Math.max(...dock.widths)-Math.min(...dock.widths)<20,JSON.stringify(dock));
 assert("more actions expand upward in the same dock",expanded&&above);
}finally{
 cdp?.close();chrome.kill("SIGKILL");
}
const failed=checks.filter(([,ok])=>!ok);
console.log("SIGNING_WORKBENCH_BROWSER_"+(failed.length?"FAIL":"PASS")+" "+(checks.length-failed.length)+"/"+checks.length);
if(failed.length)process.exitCode=1;
