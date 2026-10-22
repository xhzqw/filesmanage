#!/usr/bin/env node
// Preview return contract: /preview/:id?from=<whitelisted> sends the back link
// (and post-delete navigation) to the originating view, and rejects anything
// else so a crafted ?from= cannot become an open redirect. Also asserts
// /workbench?view=projects opens the project rail view directly.
// that an unknown from value falls back to the file list (no open redirect).
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
const base=(process.argv[2]||"http://127.0.0.1:18091").replace(/\/+$/,"");
const password=readFileSync(process.argv[3]||".secrets/admin.password","utf8").trim();
const port=18000+(process.pid%17000), profile=mkdtempSync(join(tmpdir(),"fm-from-"));
const chrome=spawn("/usr/bin/google-chrome",["--headless=new","--no-sandbox","--disable-dev-shm-usage",
 `--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,"--window-size=1280,900","about:blank"],{stdio:"ignore",detached:true});
let ws,seq=0;const pending=new Map();
function send(method,params={}){const id=++seq;return new Promise((res,rej)=>{pending.set(id,{res,rej});ws.send(JSON.stringify({id,method,params}));});}
async function evalJS(expression){const r=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails).slice(0,300));return r.result.value;}
async function until(expr,label){for(let i=0;i<120;i++){if(await evalJS(expr))return;await sleep(150);}throw Error("timeout "+label+" "+JSON.stringify(await evalJS("({u:location.pathname,t:document.body.innerText.slice(0,300)})")));}
try{
 let tab;for(let i=0;i<80&&!tab;i++){try{tab=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==="page");}catch{}if(!tab)await sleep(150);}
 ws=new WebSocket(tab.webSocketDebuggerUrl);
 await new Promise((res,rej)=>{ws.addEventListener("open",res,{once:true});ws.addEventListener("error",rej,{once:true});});
 ws.addEventListener("message",e=>{const m=JSON.parse(e.data),t=pending.get(m.id);if(t){pending.delete(m.id);m.error?t.rej(Error(m.error.message)):t.res(m.result);}});
 await send("Page.enable");await send("Runtime.enable");
 await send("Page.navigate",{url:base+"/login"});await until("location.pathname==='/login'","login");
 const login=await evalJS(`(async()=>{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({login:'admin',password:${JSON.stringify(password)}})});return r.status})()`);
 assert.equal(login,200,"login");
 // Use a real file: the project module links controlled documents by id.
 const file=await evalJS(`(async()=>{const t=await(await fetch('/api/folders/tree')).json();
  for(const f of (t.data||[])){const r=await(await fetch('/api/files?folder='+encodeURIComponent(f.id)+'&sort=name_asc&limit=1')).json();
   if(r.data?.items?.length)return r.data.items[0];} return null;})()`);
 assert.ok(file?.id,"a file exists to preview");
 const check=(query,expectedHref,expectedLabel)=>`(()=>{const a=document.querySelector('.file-back');
  return a?{href:a.getAttribute('href'),label:a.getAttribute('aria-label')}:null;})()`;
 for(const [query,href,label] of [
  [`?from=projects`,"/workbench?view=projects","返回项目"],
  [`?from=my-projects`,"/workbench?view=my-projects","返回我的项目"],
  [`?from=https://evil.example`,"/doc?folder="+encodeURIComponent(file.folderId),"返回文件列表"],
  [`?from=PROJECTS`,"/doc?folder="+encodeURIComponent(file.folderId),"返回文件列表"],
 ]){
  await send("Page.navigate",{url:base+"/preview/"+encodeURIComponent(file.id)+query});
  await until("!!document.querySelector('.file-back')","back link "+query);
  const got=await evalJS(check());
  assert.equal(got.href,href,"back target for "+query);
  assert.equal(got.label,label,"back label for "+query);
  console.log("PREVIEW_FROM_PASS",query,got.href);
 }
 // The deep link must open the project rail view, not just the workbench home.
 await send("Page.navigate",{url:base+"/workbench?view=projects"});
 await until("!!document.querySelector('.pj-shell')","project view via deep link");
 assert.equal(await evalJS("!!document.querySelector('.cdw-rail-item.is-current')"),true,"rail marks the current view");
 console.log("WORKBENCH_DEEPLINK_PASS");
}finally{try{ws?.close()}catch{};try{process.kill(-chrome.pid,"SIGKILL")}catch{try{chrome.kill("SIGKILL")}catch{}};try{rmSync(profile,{recursive:true,force:true})}catch{}}
