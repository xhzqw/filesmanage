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
const readOnly=process.argv.includes("--read-only");
assert.match(base,readOnly?
 /^http:\/\/(127\.0\.0\.1|localhost):18091$/:
 /^http:\/\/(127\.0\.0\.1|localhost):18098$/,
 readOnly?"local V05 read-only endpoint only":"isolated V05 canary only");
const credentialPath=process.argv[3]&&!process.argv[3].startsWith("--")?process.argv[3]:".secrets/admin.password";
const password=readFileSync(credentialPath,"utf8").trim();
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

 if(readOnly){
  await send("Page.navigate",{url:base+"/workbench"});
  await until("!!document.querySelector('.wbn-home h1')","Notion home");
  assert.equal(await js("document.querySelector('.wbn-home h1')?.textContent?.trim()"),"我的工作台",
   "workbench should lead with an actionable home, not a decorative splash");
  assert.ok(await js("(()=>{const a=document.querySelector('.wbn-section-actions')?.getBoundingClientRect();"
   +"const p=document.querySelector('.wbn-section-pages')?.getBoundingClientRect();return !!a&&!!p&&a.top<p.top})()"),
   "actionable inbox must precede page history in the visible home");
  console.log("NOTION_USABILITY_HOME_PRIORITY_PASS");
  assert.ok(await js("document.querySelector('link[rel=icon]')?.href.includes('/assets/brand/')"),"existing favicon");
  await send("Page.navigate",{url:base+"/workbench?view=knowledge"});
  await until("!!document.querySelector('.kn-shell')&&!!document.querySelector('.wbn-pages')","Notion page canvas");
  const visible=await js("(async()=>{const r=await fetch('/api/knowledge/pages');return (await r.json()).data;})()");
  assert.ok(Array.isArray(visible),"permitted knowledge page list");
  if(visible.length){
   const target=visible.find(p=>p.folderId==null)||visible[0];
   await send("Page.navigate",{url:base+"/workbench?view=knowledge&page="+encodeURIComponent(target.id)});
   await until("!!document.querySelector('.kn-title')","saved knowledge page");
   assert.equal(await js("document.querySelector('.kn-title')?.value"),target.title);
  }
  for(const width of [1440,1024,760,390]){
   await send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
   await sleep(250);
   const geometry=await js("({document:document.documentElement.scrollWidth,canvas:document.querySelector('.kn-canvas').getBoundingClientRect().right})");
   assert.ok(geometry.document<=width+2&&geometry.canvas<=width+2,"live page overflow "+width+" "+JSON.stringify(geometry));
   if(width===390){
    assert.ok(await js("getComputedStyle(document.querySelector('.wbn-mobile-navbar')).display!=='none'"),
     "narrow workspace must have a discoverable navigation control");
    assert.equal(await js("getComputedStyle(document.querySelector('.cdw-rail')).display"),"none",
     "mobile document must not permanently lose space to navigation");
    await js("document.querySelector('.wbn-mobile-navbar button')?.click()");
    await until("getComputedStyle(document.querySelector('.cdw-rail')).display!=='none'","mobile navigation opens");
    assert.ok(await js("document.querySelector('.wbn-pages')?.getBoundingClientRect().width>80"),
     "mobile navigation provides accessible page tree");
    await js("document.querySelector('.wbn-mobile-backdrop')?.click()");
    await until("getComputedStyle(document.querySelector('.cdw-rail')).display==='none'","mobile navigation closes");
    console.log("NOTION_MOBILE_NAVIGATION_PASS");
   }
   console.log("NOTION_LIVE_VIEWPORT_PASS",width);
  }
  await send("Emulation.clearDeviceMetricsOverride");
  // The workbench check does not mutate or assert layout ownership of Finder.
  const docStatus=await js("(async()=>{const r=await fetch('/doc');return r.status;})()");
  assert.equal(docStatus,200,"Finder route still serves the app");
  console.log("NOTION_LIVE_FINDER_HTTP_PASS");
  const dhfStatus=await js("(async()=>{const r=await fetch('/api/workbench/dhf/projects');return r.status;})()");
  assert.equal(dhfStatus,200,"DHF read API");
  console.log("NOTION_LIVE_DHF_API_READONLY_PASS");
  console.log("NOTION_V05_LIVE_READONLY_PASS");
 }else{
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

 // Simulate an independently saved revision. The editor must preserve the
 // local draft, expose the server version and require an explicit resolution.
 const externalText="其他编辑者提交 "+stamp;
 const external=await api("/knowledge/pages/"+grand.id);
 await api("/knowledge/pages/"+grand.id,"PUT",{
  title:external.title,revision:external.revision,
  blocks:[{id:blockId,type:"paragraph",text:externalText}]
 });
 const conflictText=altered+" / 冲突草稿";
 await js("(()=>{const el=document.querySelector('[data-kn-block="+JSON.stringify(blockId)+"] textarea');"
  +"const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;"
  +"setter.call(el,"+JSON.stringify(conflictText)+");el.dispatchEvent(new Event('input',{bubbles:true}));})()");
 await until("!!document.querySelector('.kn-conflict')","optimistic revision conflict");
 assert.equal(await js("document.querySelector('[data-kn-block="+JSON.stringify(blockId)+"] textarea')?.value"),
  conflictText,"conflicting user draft must remain untouched");
 assert.ok(await js("document.querySelector('.kn-conflict details')?.textContent.includes("+JSON.stringify(externalText)+")"),
  "latest server version shown for comparison");
 await js("(()=>{window.confirm=()=>true;[...document.querySelectorAll('.kn-conflict button')]"
  +".find(x=>x.textContent.includes('使用服务器版本'))?.click()})()");
 await until("!document.querySelector('.kn-conflict')&&document.querySelector('.kn-page-top')?.innerText.includes('已保存')",
  "server version restored");
 assert.equal(await js("document.querySelector('[data-kn-block="+JSON.stringify(blockId)+"] textarea')?.value"),
  externalText,"server resolution discards only the explicitly rejected draft");
 const secondLatest=await api("/knowledge/pages/"+grand.id);
 await api("/knowledge/pages/"+grand.id,"PUT",{
  title:secondLatest.title,revision:secondLatest.revision,
  blocks:[{id:blockId,type:"paragraph",text:externalText+" 最新修改"}]
 });
 await js("(()=>{const el=document.querySelector('[data-kn-block="+JSON.stringify(blockId)+"] textarea');"
  +"const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;"
  +"setter.call(el,"+JSON.stringify(altered)+");el.dispatchEvent(new Event('input',{bubbles:true}));})()");
 await until("!!document.querySelector('.kn-conflict')","second revision conflict");
 await js("(()=>{window.confirm=()=>true;[...document.querySelectorAll('.kn-conflict button')]"
  +".find(x=>x.textContent.includes('以我的草稿覆盖'))?.click()})()");
 await until("(async()=>{const r=await fetch('/api/knowledge/pages/"+grand.id+"');"
  +"const j=await r.json();return j.data?.blocks?.[0]?.text==="+JSON.stringify(altered)+";})()",
  "explicit local conflict resolution saved");
 await until("document.querySelector('.kn-page-top')?.innerText.includes('已保存')","conflict resolved status");
 console.log("NOTION_REVISION_CONFLICT_RECOVERY_PASS");

 // Notion-style block keyboard: heading shortcut, Enter split, arrow travel.
 await js("(()=>{const el=document.querySelector('[data-kn-block="+JSON.stringify(blockId)+"] textarea');"
  +"el.focus();el.dispatchEvent(new KeyboardEvent('keydown',{key:'1',ctrlKey:true,altKey:true,bubbles:true}));})()");
 await until("!!document.querySelector('[data-kn-block="+JSON.stringify(blockId)+"].kn-block-heading1')",
  "heading keyboard shortcut");
 await js("(()=>{const el=document.querySelector('[data-kn-block="+JSON.stringify(blockId)+"] textarea');"
  +"el.focus();el.setSelectionRange(el.value.length,el.value.length);"
  +"el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()");
 await until("document.querySelectorAll('.kn-block').length>=2","Enter creates following paragraph");
 assert.equal(await js("document.querySelectorAll('.kn-block')[1]?.classList.contains('kn-block-paragraph')"),
  true,"heading Enter creates normal body text");
 await js("(()=>{const el=document.querySelectorAll('.kn-block textarea')[1];"
  +"el.focus();el.setSelectionRange(0,0);"
  +"el.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));})()");
 await until("document.activeElement===document.querySelectorAll('.kn-block textarea')[0]",
  "ArrowUp moves to previous block");
 await js("(()=>{const el=document.activeElement;el.setSelectionRange(el.value.length,el.value.length);"
  +"el.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));})()");
 await until("document.activeElement===document.querySelectorAll('.kn-block textarea')[1]",
  "ArrowDown moves to following block");
 await until("document.querySelector('.kn-page-top')?.innerText.includes('已保存')","keyboard edits saved");
 console.log("NOTION_KEYBOARD_BLOCKS_PASS");

 for(const width of [1440,1024,760,390]){
  await send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
  await sleep(230);
  const dimensions=await js("({document:document.documentElement.scrollWidth,canvas:document.querySelector('.kn-canvas').getBoundingClientRect().right})");
  assert.ok(dimensions.document<=width+2&&dimensions.canvas<=width+2,"overflow "+width+" "+JSON.stringify(dimensions));
  console.log("NOTION_VIEWPORT_PASS",width);
 }
 await send("Emulation.clearDeviceMetricsOverride");
 const unsaved=altered+" / 尚未保存";
 await js("(()=>{window.__guardCount=0;window.confirm=()=>{window.__guardCount++;return false};"
  +"const el=document.querySelector('[data-kn-block="+JSON.stringify(blockId)+"] textarea');"
  +"const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;"
  +"setter.call(el,"+JSON.stringify(unsaved)+");el.dispatchEvent(new Event('input',{bubbles:true}));})()");
 await until("document.querySelector('.kn-page-top')?.innerText.includes('未保存')","unsaved edit visible");
 const blocked=await js("(()=>{const anchor=[...document.querySelectorAll('.wbn-page-link')]"
  +".find(el=>el.textContent.includes("+JSON.stringify(names[0])+"));anchor?.click();"
  +"return {clicked:!!anchor,confirmations:window.__guardCount,page:new URL(location.href).searchParams.get('page')};})()");
 assert.ok(blocked.clicked&&blocked.confirmations===1&&blocked.page===grand.id,
  "page tree navigation blocks unsaved changes "+JSON.stringify(blocked));
 assert.equal(await js("document.querySelector('.kn-block textarea')?.value"),unsaved,
  "cancelled navigation preserves the current draft");
 const blockedRail=await js("(()=>{const button=[...document.querySelectorAll('.cdw-rail-item')]"
  +".find(el=>el.textContent.includes('主页'));button?.click();"
  +"return {clicked:!!button,confirmations:window.__guardCount,page:new URL(location.href).searchParams.get('page')};})()");
 assert.ok(blockedRail.clicked&&blockedRail.confirmations===2&&blockedRail.page===grand.id,
  "workbench rail also blocks unsaved changes "+JSON.stringify(blockedRail));
 console.log("NOTION_UNSAVED_NAVIGATION_GUARD_PASS");
 await js("(()=>{window.confirm=()=>true;"
  +"[...document.querySelectorAll('.wbn-page-link')].find(el=>el.textContent.includes("
  +JSON.stringify(names[0])+"))?.click()})()");
 await until("new URL(location.href).searchParams.get('page')==="+JSON.stringify(created[0].id),
  "confirmed navigation");
 const persisted=await api("/knowledge/pages/"+grand.id);
 assert.equal(persisted.blocks[0].text,altered,"confirmed discard must not write unsaved data");
 console.log("NOTION_CONFIRMED_DISCARD_PASS");
 await js("(()=>{[...document.querySelectorAll('.wbn-page-link')]"
  +".find(x=>x.textContent.includes("+JSON.stringify(names[2])+"))?.click()})()");
 await until("new URL(location.href).searchParams.get('page')==="+JSON.stringify(grand.id),
  "reopen child page for browser history");
 const historyDraft=altered+" / 返回保护";
 await js("(()=>{const el=document.querySelector('[data-kn-block="+JSON.stringify(blockId)+"] textarea');"
  +"const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;"
  +"setter.call(el,"+JSON.stringify(historyDraft)+");el.dispatchEvent(new Event('input',{bubbles:true}));"
  +"window.__historyGuards=0;window.confirm=()=>{window.__historyGuards++;return false};})()");
 await until("document.querySelector('.kn-page-top')?.innerText.includes('未保存')","history draft dirty");
 await js("history.back()");
 await until("window.__historyGuards===1","back navigation intercepted");
 await sleep(300);
 assert.equal(await js("new URL(location.href).searchParams.get('page')"),grand.id,
  "cancelled back navigation restores the current URL");
 assert.equal(await js("document.querySelector('[data-kn-block="+JSON.stringify(blockId)+"] textarea')?.value"),
  historyDraft,"cancelled back navigation retains the unsaved block");
 await js("(()=>{window.confirm=()=>true;history.back()})()");
 await until("new URL(location.href).searchParams.get('page')==="+JSON.stringify(created[0].id),
  "confirmed browser back navigation");
 assert.equal((await api("/knowledge/pages/"+grand.id)).blocks[0].text,altered,
  "browser history discard does not silently write the draft");
 console.log("NOTION_BROWSER_HISTORY_GUARD_PASS");
 await send("Page.navigate",{url:base+"/workbench"});
 await until("!!document.querySelector('.wbn-home .wbn-page-links')","home");
 await until("!!document.querySelector('.wbn-page-links .wbn-line')","recent pages fetched");
 const first=await js("document.querySelector('.wbn-page-links .wbn-line')?.getAttribute('href')||''");
 assert.ok(first.includes(grand.id),"latest modified page first "+first);
 console.log("NOTION_RECENCY_PASS");
 console.log("NOTION_V05_BROWSER_PASS");
 }
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
