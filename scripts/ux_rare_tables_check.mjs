#!/usr/bin/env node
// Real Chrome acceptance for four compact Rare data lists. Only an isolated
// UX fixture server/database is eligible; this script writes disposable rows.
import {spawn} from "node:child_process";
import {readFileSync} from "node:fs";
import {setTimeout as delay} from "node:timers/promises";
import {assertIsolatedFixtures} from "./ux_fixture_guard.mjs";

const args=process.argv.slice(2),value=(k,d)=>{const i=args.indexOf("--"+k);return i<0?d:args[i+1];};
const BASE=value("base","").replace(/\/+$/,"");
assertIsolatedFixtures({base:BASE,args,explicitBase:args.includes("--base")});
const password=readFileSync(value("password-file",""),"utf8").trim();
const stamp="UX-TABLE-"+Date.now();
const port=Number(value("port","9377"));
let cookie="",folderId="",fileId="",deletedId="",chrome,cdp;
const seen=[];
function check(label,valid,details=""){
 console.log((valid?"PASS ":"FAIL ")+label+(details?" :: "+details:""));
 seen.push(valid);
 if(!valid)throw Error("failed: "+label);
}
async function api(method,path,body){
 const response=await fetch(BASE+"/api"+path,{method,headers:{
  Cookie:cookie,Origin:BASE,...(body===undefined?{}:{"Content-Type":"application/json"})
 },body:body===undefined?undefined:JSON.stringify(body)});
 const data=await response.json().catch(()=>null);
 if(!response.ok||data?.ok===false)throw Error(method+" "+path+" "+response.status+" "+JSON.stringify(data?.error));
 return data?.data;
}
async function upload(name){
 const body=new FormData();
 body.set("folderId",folderId);
 body.set("file",new Blob(["RARE-"+stamp+"\n"],{type:"text/plain"}),name);
 const res=await fetch(BASE+"/api/files",{method:"POST",headers:{Cookie:cookie,Origin:BASE},body});
 const json=await res.json();
 if(!res.ok||!json.data?.fileId)throw Error("upload returned "+res.status);
 return json.data.fileId;
}
class Browser{
 constructor(ws){this.ws=ws;this.n=0;this.pending=new Map();
  ws.addEventListener("message",event=>{const data=JSON.parse(event.data);
   if(!data.id||!this.pending.has(data.id))return;
   const {resolve,reject}=this.pending.get(data.id);this.pending.delete(data.id);
   data.error?reject(Error(data.error.message)):resolve(data.result);
  });
 }
 static async create(url){const ws=new WebSocket(url);
  await new Promise((ok,fail)=>{ws.addEventListener("open",ok,{once:true});ws.addEventListener("error",fail,{once:true});});
  return new Browser(ws);
 }
 send(method,params={}){const id=++this.n;
  return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));});
 }
 async eval(text){const result=await this.send("Runtime.evaluate",{expression:text,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails)throw Error("Chrome JS evaluation failed: "+text.slice(0,90));
  return result.result?.value;
 }
 async wait(predicate,timeout=18000){const end=Date.now()+timeout;
  while(Date.now()<end){if(await this.eval("("+predicate+")()"))return;await delay(200);}
  throw Error("Chrome wait expired: "+predicate.slice(0,90));
 }
 async goto(path,selector){await this.send("Page.navigate",{url:BASE+path});
  await this.wait("()=>location.pathname==="+JSON.stringify(path.split("?")[0])+"&&!!document.querySelector("+JSON.stringify(selector)+")",24000);
 }
 close(){this.ws.close();}
}
async function setInput(selector,content){
 await cdp.eval("(()=>{const el=document.querySelector("+JSON.stringify(selector)+");const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(el,"+JSON.stringify(content)+");el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()");
}
async function inspect(label,selector,expectedText,primary,action){
 await cdp.wait("()=>[...document.querySelectorAll("+JSON.stringify(selector+" tbody tr")+")]"
  +".some(r=>r.textContent?.includes("+JSON.stringify(expectedText)+"))");
 const js="(()=>{const grid=document.querySelector("+JSON.stringify(selector)+");"
 +"const row=[...grid.querySelectorAll('tbody tr')].find(r=>r.textContent?.includes("+JSON.stringify(expectedText)+"));"
 +"const parent=grid.parentElement;const visible=q=>{const el=row?.querySelector(q);if(!el)return false;"
 +"const r=el.getBoundingClientRect(),s=getComputedStyle(el);return s.display!=='none'&&r.width>0&&r.height>0&&r.left>=-1&&r.right<=innerWidth+1;};"
 +"return {width:innerWidth,documentOverflow:document.documentElement.scrollWidth-innerWidth,"
 +"gridOverflow:grid.scrollWidth-parent.clientWidth,"
 +"primary:visible("+JSON.stringify(primary)+"),action:visible("+JSON.stringify(action)+"),"
 +"hasSharedTable:grid.hasAttribute('data-rare-table'),"
 +"primaryWidth:row?.querySelector("+JSON.stringify(primary)+")?.getBoundingClientRect().width};})()";
 const result=await cdp.eval(js);
 check(label+" primary, action, shared table and fit",
  result.primary&&result.action&&result.hasSharedTable&&result.documentOverflow<=2&&result.gridOverflow<=2&&result.width>0,
  JSON.stringify(result));
}
async function run(){
 const login=await fetch(BASE+"/api/login",{method:"POST",headers:{"Content-Type":"application/json"},
  body:JSON.stringify({login:"admin",password})});
 cookie=login.headers.getSetCookie().find(s=>s.startsWith("fm_session="))?.split(";")[0]??"";
 check("isolated session",login.ok&&!!cookie);
 const me=await api("GET","/me");
 const folders=await api("GET","/folders/tree");
 const root=folders.find(f=>f.id==="folder_root")??folders.find(f=>!f.parentId);
 folderId=(await api("POST","/folders",{parentId:root.id,name:stamp})).id;
 const fileName=stamp+"-active.txt",deletedName=stamp+"-deleted.txt";
 fileId=await upload(fileName);
 const lock=await api("POST","/files/"+fileId+"/lock",{baseSeq:1});
 await api("POST","/files/"+fileId+"/save",{
  baseSeq:1,lockToken:lock.lockToken,
  data:Buffer.from("SECOND RARE VERSION "+stamp+"\n").toString("base64"),
  idempotencyKey:"ux-rare-version-"+stamp
 });
 deletedId=await upload(deletedName);
 await api("PUT","/favorites/file/"+fileId);
 // Use a valid recipient other than the admin to verify share status.
 const recipients=await api("GET","/users").catch(()=>[]);
 const recipient=Array.isArray(recipients)?recipients.find(u=>u.id!==me.id):null;
 if(recipient){
  await api("POST","/shares",{resourceKind:"file",resourceId:fileId,recipientKind:"user",
   recipientId:recipient.id,actions:["preview"],includeDescendants:false});
 }
 await api("DELETE","/files/"+deletedId);
 chrome=spawn("/usr/bin/google-chrome",["--headless=new","--no-sandbox","--disable-gpu",
  "--disable-dev-shm-usage","--remote-debugging-port="+port,"--window-size=1440,900","about:blank"],{stdio:"ignore"});
 let page;
 for(let i=0;i<60&&!page;i++){await delay(200);
  try{const pages=await (await fetch("http://127.0.0.1:"+port+"/json/list")).json();page=pages.find(x=>x.type==="page");}catch{}
 }
 if(!page)throw Error("headless Chrome not ready");
 cdp=await Browser.create(page.webSocketDebuggerUrl);
 await cdp.send("Page.enable");await cdp.send("Runtime.enable");await cdp.send("Network.enable");
 await cdp.send("Network.setCookie",{name:"fm_session",value:cookie.slice(11),url:BASE+"/workspace",httpOnly:true});
 for(const width of [390,760,1366]){
  await cdp.send("Emulation.setDeviceMetricsOverride",{width,height:840,deviceScaleFactor:1,mobile:false});
  await cdp.goto("/workspace",".collab-favorites-table");
  await inspect("favorites "+width+"px",".collab-favorites-table",fileName,"td:first-child a",".collab-action-cell button");
  if(recipient){
   await cdp.eval("(()=>{[...document.querySelectorAll('.collab-tablist button')].find(b=>b.textContent?.trim()==='我共享的').click();return true;})()");
   await inspect("shares "+width+"px",".collab-shares-table",fileName,"td:first-child a","td:nth-last-child(2) .rare-badge");
  }
  await cdp.goto("/trash",".trash-table");
  await setInput('input[aria-label="搜索删除记录"]',stamp);
  await inspect("trash "+width+"px",".trash-table",deletedName,".trash-resource-text strong",".trash-row-actions button");
  await cdp.goto("/search","#search-q");
  await setInput("#search-q",fileName);
  await cdp.eval("(()=>{document.querySelector('.search-primary button[type=submit]').click();return true;})()");
  await inspect("search "+width+"px",".search-data-table",fileName,"td:first-child a","td:last-child a");
  await cdp.goto("/doc?folder="+encodeURIComponent(folderId),".file-table");
  await cdp.wait("()=>[...document.querySelectorAll('.file-table tbody tr')].some(r=>r.textContent?.includes("+JSON.stringify(fileName)+"))");
  const files=await cdp.eval("(()=>{const tr=[...document.querySelectorAll('.file-table tbody tr')].find(x=>x.textContent?.includes("+JSON.stringify(fileName)+"));const name=tr?.querySelector('.file-name'),menu=tr?.querySelector('.file-mobile-actions'),r=name?.getBoundingClientRect(),m=menu?.getBoundingClientRect();return {width:innerWidth,overflow:document.documentElement.scrollWidth-innerWidth,nameVisible:r?.width>35&&r.left>=0&&r.right<=innerWidth+1,menuVisible:m?.width>0&&m.left>=0&&m.right<=innerWidth+1,nameRect:r?{left:r.left,right:r.right,width:r.width}:null,tableRect:tr?.closest('table')?.getBoundingClientRect().toJSON(),paneRect:tr?.closest('.table')?.getBoundingClientRect().toJSON(),version:tr?.querySelector('.version-badge')?.textContent,hasGrid:!!tr?.closest('[role=grid]')};})()");
  check("file explorer "+width+"px name, version and access to actions",files.overflow<=2&&files.nameVisible&&files.version==="v2"&&files.hasGrid&&(width>700||files.menuVisible),JSON.stringify(files));
  await setInput('input[aria-label="当前已加载文件名过滤"]',"not-a-matching-name-"+stamp);
  await cdp.wait("()=>!!document.querySelector('.file-table .empty-title')&&document.querySelector('.file-table .empty-title')?.textContent==='无匹配文件'");
  await cdp.eval("(()=>{[...document.querySelectorAll('.file-table .empty button')].find(b=>b.textContent?.includes('清除筛选'))?.click();return true;})()");
  await cdp.wait("()=>[...document.querySelectorAll('.file-table tbody tr')].some(r=>r.textContent?.includes("+JSON.stringify(fileName)+"))");
  check("file explorer "+width+"px reset clears filename and category filters",
   await cdp.eval(`(()=>document.querySelector('input[aria-label="当前已加载文件名过滤"]')?.value==='')()`));
  await cdp.goto("/preview/"+fileId,"#file-tab-versions");
  await cdp.eval("(()=>{document.querySelector('#file-tab-versions').click();return true;})()");
  await cdp.wait("()=>document.querySelectorAll('.file-versions-table tbody tr').length===2");
  const versions=await cdp.eval("(()=>{const table=document.querySelector('.file-versions-table table'),wrap=table?.parentElement,rows=[...table.querySelectorAll('tbody tr')],rollback=rows.find(r=>r.textContent?.includes('v1'))?.querySelector('button'),r=rollback?.getBoundingClientRect();return {width:innerWidth,overflow:document.documentElement.scrollWidth-innerWidth,hasRare:table?.hasAttribute('data-rare-table'),rows:rows.length,scroll:table.scrollWidth-wrap.clientWidth,current:!!rows[0]?.querySelector('.rare-badge'),rollback:!!rollback&&!rollback.disabled&&r.width>0&&r.left>=0&&r.right<=innerWidth+1};})()");
  check("version history "+width+"px compact Rare and rollback visible",versions.hasRare&&versions.rows===2&&versions.overflow<=2&&versions.scroll<=2&&versions.current&&versions.rollback,JSON.stringify(versions));
  await cdp.goto("/org",".org-members-table");
  await inspect("organization members "+width+"px",".org-members-table",me.displayName,".org-user-name",".org-member-actions button");
  check("organization "+width+"px create stays in dialog",
   !(await cdp.eval("(()=>!!document.querySelector('.org-create-user-card'))()")));
  await cdp.eval("(()=>{document.querySelector('.org-add-member').click();return true;})()");
  await cdp.wait("()=>!!document.querySelector('dialog.org-create-user-dialog[open] #org-new-login')");
  const dialog=await cdp.eval("(()=>{const el=document.querySelector('dialog.org-create-user-dialog[open]');const r=el.getBoundingClientRect();return {left:r.left,right:r.right,modal:el.matches(':modal'),fields:el.querySelectorAll('.org-field').length};})()");
  check("organization "+width+"px add member is accessible modal",
   dialog.left>=-1&&dialog.right<=width+1&&dialog.modal&&dialog.fields===4,JSON.stringify(dialog));
  await cdp.eval("(()=>{document.querySelector('dialog.org-create-user-dialog .dialog-actions button[type=button]').click();return true;})()");
  await cdp.wait("()=>!document.querySelector('dialog.org-create-user-dialog[open]')");
  await cdp.eval("(()=>{document.querySelector('#org-tab-permissions').click();return true;})()");
  await cdp.wait("()=>!!document.querySelector('.perm-compose-card')&&!!document.querySelector('.perm-browser')");
  const acl=await cdp.eval("(()=>{const rect=q=>{const e=document.querySelector(q),r=e?.getBoundingClientRect();return r?{left:r.left,right:r.right,width:r.width,top:r.top}:null;};return {width:innerWidth,overflow:document.documentElement.scrollWidth-innerWidth,tree:rect('.perm-browser'),inspection:rect('.perm-inspection-column'),editor:rect('.perm-compose-card')};})()");
  check("permissions "+width+"px tree/list/editor fit the page",
   acl.overflow<=2&&acl.tree?.right<=width+2&&acl.inspection?.right<=width+2&&acl.editor?.right<=width+2&&acl.editor?.width>140,JSON.stringify(acl));
  await cdp.eval("(()=>{document.querySelector('#org-tab-roles').click();return true;})()");
  await cdp.wait("()=>!!document.querySelector('.org-role-layout .org-role-editor')");
  const roles=await cdp.eval("(()=>{const e=document.querySelector('.org-role-layout'),list=e.querySelector('.org-role-list'),edit=e.querySelector('.org-role-editor'),r=e.getBoundingClientRect();return {width:innerWidth,overflow:document.documentElement.scrollWidth-innerWidth,right:r.right,list: list.getBoundingClientRect().width,editor:edit.getBoundingClientRect().width};})()");
  check("roles "+width+"px list/editor fit the page",
   roles.overflow<=2&&roles.right<=width+2&&roles.list>140&&roles.editor>140,JSON.stringify(roles));
 }
 console.log("UX_RARE_TABLES_PASS checks="+seen.length);
}
try{await run();}
catch(error){console.error("UX_RARE_TABLES_FAILED: "+String(error?.message??error));process.exitCode=1;}
finally{
 cdp?.close();chrome?.kill("SIGKILL");
 if(fileId)await api("DELETE","/files/"+fileId).catch(()=>{});
 if(folderId)await api("DELETE","/folders/"+folderId).catch(()=>{});
}
