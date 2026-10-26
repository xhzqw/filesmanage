#!/usr/bin/env node
// Isolated-database Chrome regression: nested-page deep links, inline editor,
// autosave, recency and responsive Notion workbench. Never run on business DB.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {readFileSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";

const base=(process.argv[2]||"http://127.0.0.1:18098").replace(/\/+$/,"");
assert.match(base,/^http:\/\/(127\.0\.0\.1|localhost):18098$/,"isolated V05 canary only");
const password=readFileSync(process.argv[3]||".secrets/admin.password","utf8").trim();
const port=19000+process.pid%14000;
const profile=mkdtempSync(join(tmpdir(),"fm-notion-v05-"));
const chrome=spawn("/usr/bin/google-chrome",[
 "--headless=new","--no-sandbox","--disable-dev-shm-usage",
 "--remote-debugging-port="+port,"--user-data-dir="+profile,
 "--window-size=1440,900","about:blank"
],{stdio:"ignore",detached:true});
let ws,seq=0;
const pending=new Map(),created=[];
const send=(method,params={})=>new Promise((resolve,reject)=>{
 const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));
});
async function js(expression){
 const out=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
 if(out.exceptionDetails)throw Error("Browser exception "+JSON.stringify(out.exceptionDetails).slice(0,300));
 return out.result.value;
}
async function until(expression,label){
 for(let i=0;i<100;i++){if(await js(expression))return;await sleep(180);}
 throw Error("Timed out: "+label+" "+JSON.stringify(await js("({url:location.href,body:document.body.innerText.slice(0,250)})")));
}
async function api(path,method="GET",body){
 const payload=JSON.stringify({path,method,body});
 const result=await js(`(async()=>{const a=${payload};
  const r=await fetch('/api'+a.path,{method:a.method,
   headers:{'Content-Type':'application/json'},
   credentials:'same-origin',
   body:a.body===undefined?undefined:JSON.stringify(a.body)});
  const j=await r.json();return {status:r.status,...j};})()`);
 if(!result.ok)throw Error("API "+method+" "+path+" "+result.status);
 return result.data;
}
try{
 let tab;
 for(let i=0;i<80&&!tab;i++){
  try{tab=(await(await fetch("http://127.0.0.1:"+port+"/json/list")).json()).find(t=>t.type==="page");}catch{}
  if(!tab)await sleep(150);
 }
 assert.ok(tab,"Chrome debugger");
 ws=new WebSocket(tab.webSocketDebuggerUrl);
 await new Promise((ok,no)=>{ws.addEventListener("open",ok,{once:true});ws.addEventListener("error",no,{once:true})});
 ws.addEventListener("message",event=>{const data=JSON.parse(event.data),p=pending.get(data.id);
  if(p){pending.delete(data.id);data.error?p.reject(Error(data.error.message)):p.resolve(data.result);}
 });
 await send("Page.enable");await send("Runtime.enable");
 await send("Page.navigate",{url:base+"/login"});
 await until("location.pathname==='/login'","login");
 const login=await js(`(async()=>{const r=await fetch('/api/login',{
  method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({login:'admin',password:${JSON.stringify(password)}})});
  return {status:r.status,ok:(await r.json()).ok};})()`);
 assert.equal(login.status,200);
 assert.equal(login.ok,true);

 const stamp=Date.now().toString();
 const names=["QA 祖先 "+stamp,"QA 子页面 "+stamp,"QA 孙页面 "+stamp];
 for(let i=0;i<3;i++){
  const page=await api("/knowledge/pages","POST",{title:names[i],parentId:created.at(-1)?.id||""});
  created.push(page);
 }
 const grand=created[2],blockId="test_"+stamp;
 const text="V05 浏览器验证内容 "+stamp;
 await api("/knowledge/pages/"+grand.id,"PUT",{
  title:names[2],revision:grand.revision,
  blocks:[{id:blockId,type:"paragraph",text}]
 });
 await send("Page.navigate",{url:base+"/workbench?view=knowledge&page="+encodeURIComponent(grand.id)});
 await until("document.querySelector('.kn-title')?.value==="+JSON.stringify(names[2]),"deep link page title");
 await until("document.querySelectorAll('.wbn-tree-item').length>=3","full nested tree");
 const tree=await js("([...document.querySelectorAll('.wbn-page-link')].map(x=>x.textContent.trim()))");
 assert.ok(names.every(name=>tree.some(row=>row.includes(name))),"deep-link reveals all ancestors "+JSON.stringify(tree));
 const crumbs=await js("([...document.querySelectorAll('.kn-breadcrumb a')].map(x=>x.textContent.trim()))");
 assert.ok(crumbs.includes(names[0])&&crumbs.includes(names[1]),"complete clickable breadcrumb "+JSON.stringify(crumbs));
 console.log("NOTION_DEEP_LINK_PASS");

 const altered=text+" / 自动保存";
 const edit=await js(`(()=>{const el=document.querySelector('[data-kn-block=${JSON.stringify(blockId)}] textarea');
  if(!el)return false;const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
  setter.call(el,${JSON.stringify(altered)});el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
 assert.ok(edit,"block textarea visible and editable");
 await until(`(async()=>{const r=await fetch('/api/knowledge/pages/${grand.id}');const j=await r.json();
   return j.data?.blocks?.[0]?.text===${JSON.stringify(altered)};})()`,"autosave persisted");
 await until("document.querySelector('.kn-page-top')?.innerText.includes('已保存')","saved indicator");
 console.log("NOTION_AUTOSAVE_PASS");

 for(const width of [1440,1024,760,390]){
  await send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
  await sleep(230);
  const dimensions=await js("({document:document.documentElement.scrollWidth,canvas:document.querySelector('.kn-canvas').getBoundingClientRect().right})");
  assert.ok(dimensions.document<=width+2&&dimensions.canvas<=width+2,"overflow "+width+" "+JSON.stringify(dimensions));
  console.log("NOTION_VIEWPORT_PASS",width);
 }
 await send("Emulation.clearDeviceMetricsOverride");
 await send("Page.navigate",{url:base+"/workbench"});
 await until("!!document.querySelector('.wbn-home .wbn-page-links')","home");
 await until("!!document.querySelector('.wbn-page-links .wbn-line')","recent pages fetched");
 const first=await js("document.querySelector('.wbn-page-links .wbn-line')?.getAttribute('href')||''");
 assert.ok(first.includes(grand.id),"latest modified page first "+first);
 console.log("NOTION_RECENCY_PASS");
 console.log("NOTION_V05_BROWSER_PASS");
}finally{
 if(ws?.readyState===1){
  for(const p of [...created].reverse()){
   try{
    const data=await api("/knowledge/pages/"+p.id);
    await api("/knowledge/pages/"+p.id+"/archive","POST",{revision:data.revision});
   }catch(err){console.error("CLEANUP_FAILED",p.id,String(err));}
  }
 }
 try{ws?.close()}catch{}
 try{process.kill(-chrome.pid,"SIGTERM")}catch{try{chrome.kill("SIGTERM")}catch{}}
 await sleep(300);
 try{rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:150})}catch{}
}
