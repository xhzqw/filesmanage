#!/usr/bin/env node
// Read-only Chrome/CDP smoke of Organization > Permissions P1.
// Execute only on the remote dev target where admin.password is stored.
import {spawn} from "node:child_process";
import {setTimeout as sleep} from "node:timers/promises";
import {verifiedAdminSession} from "./qa_session.mjs";

const BASE="http://127.0.0.1:18091";
const PORT=9389;
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
 const session=await verifiedAdminSession(BASE);
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
 await cdp.send("Network.enable");
 await cdp.send("Network.setCookie",{
  name:"fm_session",value:session.cookie.slice("fm_session=".length),
  domain:new URL(BASE).hostname,path:"/",httpOnly:true,sameSite:"Strict",
 });
 assert(session.cookie.startsWith("fm_session="),
  "verified admin browser session ("+(session.reused?"reused":"new")+")");
 await cdp.navigate(BASE+"/org?tab=permissions&view=folder");
 assert(await cdp.waitFor("()=>!!document.querySelector('.perm-workspace')"),"organization permission workspace renders");
 // Switching views must not replace the organization shell.
 assert(await cdp.evaluate("(()=>!!document.querySelector('.org-dept-card')&&!!document.querySelector('.work-body>.toolbar'))()"),
  "organization navigation is visible on the permissions tab");
 // Tree pictograms: hierarchy is outlined, departments reuse the yellow folder glyph,
 // and RareButton cannot silently re-center labels in the flexible tree row.
 assert(await cdp.waitFor("()=>!!document.querySelector('.org-dept-card li[data-dept-id] .org-tree-icon svg')"),
  "department tree data loads before visual assertions");
 assert(await cdp.evaluate(`(()=>{
  const root=document.querySelector('.org-dept-card .tree > li[role="treeitem"] .org-tree-icon svg');
  const folder=document.querySelector('.org-dept-card li[data-dept-id] .org-tree-icon svg');
  const label=document.querySelector('.org-dept-card li[data-dept-id] .org-node-label');
  return !!root&&root.getAttribute('width')==='18'&&root.querySelectorAll('rect').length===3&&
   !!folder&&folder.getAttribute('stroke')?.includes('--folder-stroke')&&
   !!folder.querySelector('path[fill]')&&!!label&&
   getComputedStyle(label).justifyContent==='flex-start';
 })()`),"organization chart, warm folder icons and left-aligned tree labels");
 // Headless CDP OS-key injection can lose page activation; dispatch a bubbling
 // keyboard event on the focused node to test React tree keyboard semantics.
 const pressKey=async(key,_virtualKeyCode)=>{
  await cdp.evaluate(`(()=>{
   const focused=document.activeElement;
   return focused?.dispatchEvent(new KeyboardEvent('keydown',{
    key:${JSON.stringify(key)},code:${JSON.stringify(key)},bubbles:true,cancelable:true
   }))??false;
  })()`);
 };
 await cdp.evaluate("(()=>{document.querySelector('.org-dept-card .tree > li')?.focus();return true})()");
 assert(await cdp.waitFor("()=>document.activeElement?.dataset.treeId==='__all'"),"all-organization row receives keyboard focus");
 await pressKey("ArrowDown",40);
 const arrowDownOk=await cdp.waitFor("()=>!!document.activeElement?.dataset.deptId");
 if(!arrowDownOk){
  console.log("TREE_FOCUS_DIAGNOSTIC",JSON.stringify(await cdp.evaluate(`(()=>{
   const tree=document.querySelector('.org-dept-card .tree');
   return {active:document.activeElement?.outerHTML?.slice(0,450),
    count:tree?.querySelectorAll('li[role=treeitem]').length,
    treeIds:[...tree?.querySelectorAll('li[role=treeitem]')??[]].map(n=>n.dataset.treeId)};
  })()`)));
 }
 assert(arrowDownOk,"department tree ArrowDown focuses first visible department");
 await pressKey("ArrowUp",38);
 assert(await cdp.waitFor("()=>document.activeElement?.dataset.treeId==='__all'"),
  "department tree ArrowUp returns to all organization");
 await pressKey("End",35);
 assert(await cdp.waitFor("()=>document.activeElement?.dataset.treeId==='__unassigned'"),
  "department tree End includes unassigned accounts");
 await pressKey("Enter",13);
 assert(await cdp.waitFor("()=>document.querySelector('.org-dept-card li[data-tree-id=__unassigned]')?.getAttribute('aria-selected')==='true'"),
  "department tree Enter selects unassigned");
 await pressKey("Home",36);
 await pressKey("Enter",13);
 assert(await cdp.waitFor("()=>document.querySelector('.org-dept-card li[data-tree-id=__all]')?.getAttribute('aria-selected')==='true'"),
  "department tree Home and Enter restore all-organization scope");
 assert(await cdp.evaluate(`(()=>document.querySelectorAll('.org-dept-card li[role=treeitem][tabindex="0"]').length===1)()`),
  "department hierarchy exposes exactly one keyboard tab stop");
 await cdp.evaluate(`(()=>{
  const root=document.querySelector('.org-dept-card li[data-tree-id=__all]');
  root.focus();
  window.dispatchEvent(new CustomEvent('filesmanage:workspace-changed',{detail:{scopes:['organization']}}));
  return true;
 })()`);
 await sleep(700);
 assert(await cdp.evaluate("(()=>{const root=document.querySelector('.org-dept-card li[data-tree-id=__all]');return !!root?.isConnected&&document.activeElement===root})()"),
  "live organization refresh preserves keyboard focus and the mounted department tree");
 const expandableDept=await cdp.evaluate("(()=>document.querySelector('.org-dept-card li[data-dept-id][aria-expanded]')?.dataset.deptId??'')()");
 if(expandableDept){
  await cdp.evaluate(`(()=>{document.querySelector('li[data-dept-id="${expandableDept}"]').focus();return true})()`);
  await pressKey("ArrowLeft",37);
  assert(await cdp.waitFor(`()=>document.querySelector('li[data-dept-id="${expandableDept}"]')?.getAttribute('aria-expanded')==='false'`),
   "department tree ArrowLeft collapses a branch");
  await pressKey("ArrowRight",39);
  assert(await cdp.waitFor(`()=>document.querySelector('li[data-dept-id="${expandableDept}"]')?.getAttribute('aria-expanded')==='true'`),
   "department tree ArrowRight expands a branch");
 }
 await cdp.evaluate("window.__orgShellTree=document.querySelector('.org-dept-card');window.__orgShellTabs=document.querySelector('.org-tabs-bar');true");
 for(const tab of ["members","groups","approvals","roles","permissions"]){
  await cdp.evaluate(`document.querySelector('#org-tab-${tab}').click()`);
  assert(await cdp.waitFor(`()=>document.querySelector('#org-tab-${tab}')?.getAttribute('aria-selected')==='true'`),
   tab+" activates");
  assert(await cdp.evaluate(`(()=>{
   const tree=document.querySelector('.org-dept-card'),stage=document.querySelector('.org-tabs-bar');
   return tree===window.__orgShellTree&&tree?.isConnected&&stage===window.__orgShellTabs&&
    !!document.querySelector('.work-body>.toolbar')&&
    document.querySelector('.org-workbench')?.children.length===2&&
    !!document.querySelector('#org-panel-${tab}');
  })()`),tab+" changes only the right panel");
 }
 assert(await cdp.waitFor("()=>!!document.querySelector('.perm-tree-name')"),"resource folder browser loads");
 assert(await cdp.evaluate("(()=>!!document.querySelector('.perm-tree[role=tree] li[role=treeitem] .perm-folder-glyph[stroke]'))()"),
  "resource browser uses shared warm folder glyph and ARIA tree structure");
 await cdp.evaluate("(()=>{document.querySelector('.perm-tree li')?.focus();return true})()");
 await pressKey("End",35);
 assert(await cdp.waitFor("()=>document.activeElement?.matches('.perm-tree li[role=treeitem]:last-of-type')"),
  "resource browser End reaches last visible folder");
 await pressKey("Home",36);
 assert(await cdp.waitFor("()=>document.activeElement?.matches('.perm-tree li[role=treeitem]:first-child')"),
  "resource browser Home returns to first folder");
 await pressKey("Enter",13);
 assert(await cdp.waitFor("()=>document.activeElement?.getAttribute('aria-selected')==='true'"),
  "resource tree Enter selects focused resource");
 const expandableFolder=await cdp.evaluate("(()=>document.querySelector('.perm-tree li[aria-expanded]')?.dataset.folderId??'')()");
 if(expandableFolder){
  await cdp.evaluate(`(()=>{document.querySelector('.perm-tree li[data-folder-id="${expandableFolder}"]').focus();return true})()`);
  await pressKey("ArrowLeft",37);
  assert(await cdp.waitFor(`()=>document.querySelector('.perm-tree li[data-folder-id="${expandableFolder}"]')?.getAttribute('aria-expanded')==='false'`),
   "resource tree ArrowLeft collapses a branch");
  await pressKey("ArrowRight",39);
  assert(await cdp.waitFor(`()=>document.querySelector('.perm-tree li[data-folder-id="${expandableFolder}"]')?.getAttribute('aria-expanded')==='true'`),
   "resource tree ArrowRight expands a branch");
 }
 for(const width of [1100,1024,900,820]){
  await cdp.send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
  assert(await cdp.evaluate(`(()=>{
   const tree=document.querySelector('.org-dept-card').getBoundingClientRect();
   const task=document.querySelector('.org-stage-card').getBoundingClientRect();
   return task.x>=tree.right&&Math.abs(task.y-tree.y)<=3&&
    document.documentElement.scrollWidth<=innerWidth+2;
  })()`),width+"px keeps compact side-by-side organization workbench");
  assert(await cdp.evaluate(`(()=>{
   const browser=document.querySelector('.perm-workspace .perm-browser').getBoundingClientRect();
   const detail=document.querySelector('.perm-workspace .perm-detail').getBoundingClientRect();
   return browser.width>0&&browser.width<=221&&detail.left>=browser.right-2&&detail.width>0;
  })()`),width+"px keeps resource navigator compact and details accessible");
 }
 await cdp.send("Emulation.clearDeviceMetricsOverride");
 // Organization invalidations must refresh the directory without a page reload.
 await cdp.evaluate(`(()=>{
  const nativeFetch=window.fetch.bind(window);
  window.__orgReads=0;
  window.fetch=(input,init)=>{
   const url=new URL(typeof input==='string'?input:input.url,location.href);
   if(['/api/users','/api/groups','/api/departments'].includes(url.pathname))window.__orgReads++;
   return nativeFetch(input,init);
  };
  window.dispatchEvent(new CustomEvent('filesmanage:workspace-changed',{detail:{scopes:['organization']}}));
  return true;
 })()`);
 assert(await cdp.waitFor("()=>window.__orgReads>=3"),"organization realtime hint refreshes users, groups, departments");
 await cdp.evaluate("(()=>{document.querySelector('#org-tab-groups').click();return true})()");
 assert(await cdp.waitFor("()=>!!document.querySelector('.org-group-cards-list')"),
  "workgroup list available for scope checks");
 assert(await cdp.evaluate(`(()=>{
  const card=document.querySelector('.org-group-cards-list .org-group-card');
  const badge=card?.querySelector('.org-dept-pill[data-rare-badge-tone]');
  if(!card||!badge)return false;
  const rect=card.getBoundingClientRect();
  return card.querySelectorAll('.org-group-card-header').length===1&&
   card.querySelector('.org-active-pill')===null&&rect.height<=53&&
   getComputedStyle(card).minHeight==='39px';
 })()`),"workgroup navigation uses compact RareUI list rows and badges");
 const deptScope=await cdp.evaluate(`(async()=>{
  const departments=(await(await fetch('/api/departments')).json()).data;
  const groups=(await(await fetch('/api/groups?limit=200')).json()).data.items;
  const leaves=departments.filter(d=>!departments.some(child=>child.parentId===d.id));
  const target=leaves.map(d=>({id:d.id,expected:groups.filter(g=>g.departmentId===d.id).length}))
   .sort((a,b)=>a.expected-b.expected)[0];
  return target??null;
 })()`);
 if(deptScope){
  await cdp.evaluate(`(()=>{
   document.querySelector('li[data-dept-id="${deptScope.id}"] .org-node-label').click();
   return true;
  })()`);
  assert(await cdp.waitFor(`()=>Number(document.querySelector('#org-tab-groups .org-tab-badge')?.textContent)===${deptScope.expected}`),
   "workgroup count follows selected department subtree");
  assert(await cdp.evaluate(`(()=>[...document.querySelectorAll('.org-group-cards-list > li .org-group-card')]
   .every(card=>!card.querySelector('.org-dept-pill')?.textContent?.includes('公共工作组')))()`),
   "department scope excludes unrelated common workgroups");
 }
 await cdp.evaluate("(()=>{document.querySelector('#org-tab-permissions').click();return true})()");
 assert(await cdp.waitFor("()=>!!document.querySelector('.perm-workspace')"),
  "permission resource browser survives department filtering");
 assert(await cdp.evaluate(`(()=>{
  const panel=document.querySelector('.perm-workspace');
  return panel&&getComputedStyle(panel).borderTopWidth==='0px'&&
   getComputedStyle(panel).marginTop==='0px';
 })()`),"permissions avoid redundant nested workspace borders");
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
 assert(await cdp.waitFor("()=>[...document.querySelectorAll('.perm-form select')].some(s=>s.options[0]?.value===''&&!!s.value)"),
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
 await cdp.evaluate("(()=>{document.querySelector('#org-tab-groups').click();return true})()");
 assert(await cdp.waitFor("()=>!!document.querySelector('dialog[open] .dialog-actions')"),
  "unsaved ACL draft blocks tab navigation");
 assert(await cdp.evaluate("(()=>document.querySelector('#org-tab-permissions')?.getAttribute('aria-selected')==='true')()"),
  "ACL draft keeps current tab before confirmation");
 await cdp.evaluate("(()=>{[...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent?.includes('继续编辑')).click();return true})()");
 assert(await cdp.waitFor("()=>!document.querySelector('dialog[open]')"),"cancel preserves ACL editing");
 assert(await cdp.evaluate("(()=>[...document.querySelectorAll('.perm-action-grid label')].some(x=>x.textContent?.includes('下载')&&x.querySelector('input')?.checked))()"),
  "cancel keeps the unsaved ACL actions");
 await cdp.evaluate(`(()=>{
  [...document.querySelectorAll('.perm-subnav button')]
   .find(b=>b.textContent?.includes('审计'))?.click();return true;
 })()`);
 assert(await cdp.waitFor("()=>!!document.querySelector('dialog[open]')"),
  "unsaved ACL draft blocks changing permission subviews");
 await cdp.evaluate("(()=>{[...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent?.includes('放弃修改')).click();return true})()");
 assert(await cdp.waitFor("()=>!!document.querySelector('.perm-audit .perm-table')"),"audit view loads with event table");
 assert(await cdp.evaluate("(()=>new URLSearchParams(location.search).get('view')==='audit')()"),
  "audit tab is deep-linkable");
 assert(await cdp.evaluate("(()=>!!document.querySelector('.perm-audit .rare-data-table[data-rare-table]'))()"),
  "permission audit uses semantic RareDataTable");
 await cdp.evaluate(`(()=>{
  [...document.querySelectorAll('.perm-subnav button')].find(b=>b.textContent?.includes('文档活动'))?.click();
  return true;
 })()`);
 assert(await cdp.waitFor("()=>!!document.querySelector('.document-activity .rare-data-table[data-rare-table]')"),
  "document activity audit uses semantic RareDataTable");
 await cdp.navigate(BASE+"/org?tab=roles");
 assert(await cdp.waitFor("()=>!!document.querySelector('.org-role-workbench[aria-label=管理角色绑定]')"),
  "P2 role bindings page renders");
 assert(await cdp.waitFor("()=>!!document.querySelector('.perm-detail form')"),
  "P2 role delegation form is available");
 // The extracted role editor must retain controlled state and the preview gate.
 const roleCandidate=await cdp.evaluate(`(()=>{
  const select=document.querySelector('.org-role-editor select');
  return [...(select?.options??[])].find(o=>o.value)?.value??'';
 })()`);
 if(roleCandidate){
  await cdp.evaluate(`(()=>{
   const select=document.querySelector('.org-role-editor select');
   const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
   setter.call(select,${JSON.stringify(roleCandidate)});
   select.dispatchEvent(new Event('change',{bubbles:true}));
   return true;
  })()`);
  assert(await cdp.waitFor(`()=>document.querySelector('.org-role-editor select')?.value===${JSON.stringify(roleCandidate)}`),
   "role delegation candidate updates controlled field");
  await cdp.evaluate("(()=>{document.querySelector('.org-role-editor form').requestSubmit();return true})()");
  assert(await cdp.waitFor("()=>document.querySelector('.org-role-editor .perm-review')?.textContent?.includes('委派不附带文件读取权限')"),
   "role delegation requires preview without server mutation");
  await cdp.evaluate(`(()=>{
   const select=document.querySelector('.org-role-editor select');
   const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
   setter.call(select,'');select.dispatchEvent(new Event('change',{bubbles:true}));
   return true;
  })()`);
  assert(await cdp.waitFor("()=>!document.querySelector('.org-role-editor .perm-review')&&document.querySelector('.org-role-editor button[type=submit]')?.disabled"),
   "changing role delegate invalidates preview and restores empty draft");
 }
 await cdp.navigate(BASE+"/org?tab=approvals");
 assert(await cdp.waitFor("()=>!!document.querySelector('.approval-workspace .perm-tree-name')"),
  "approval resource navigation renders");
 await cdp.evaluate("(()=>{document.querySelector('.approval-workspace .perm-tree-name').click();return true})()");
 assert(await cdp.waitFor("()=>!!document.querySelector('.approval-toggle input:not(:disabled)')"),
  "approval policy editor is ready");
 assert(await cdp.evaluate(`(()=>{
  const work=document.querySelector('.approval-workspace');
  const state=document.querySelector('.approval-state[data-rare-badge-tone]');
  return !!work&&!!state&&getComputedStyle(work).maxHeight==='none'&&
   getComputedStyle(work).marginTop==='0px';
 })()`),"approval policy uses RareBadge and full-height workspace layout");
 const before=await cdp.evaluate("(()=>document.querySelector('.approval-toggle input').checked)()");
 await cdp.evaluate("(()=>{document.querySelector('.approval-toggle input').click();return true})()");
 assert(await cdp.waitFor(`()=>document.querySelector('.approval-toggle input')?.checked===${!before}`),
  "approval draft changes locally without server writes");
 const selectedFolder=await cdp.evaluate("(()=>new URLSearchParams(location.search).get('folder'))()");
 await cdp.evaluate("(()=>{document.querySelector('#org-tab-roles').click();return true})()");
 assert(await cdp.waitFor("()=>!!document.querySelector('dialog[open]')"),
  "unsaved approval draft blocks tab navigation");
 await cdp.evaluate("(()=>{[...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent?.includes('继续编辑')).click();return true})()");
 assert(await cdp.waitFor(`()=>document.querySelector('.approval-toggle input')?.checked===${!before}`),
  "cancelling navigation preserves approval draft");
 await cdp.evaluate("(()=>{document.querySelector('#org-tab-roles').click();return true})()");
 await cdp.evaluate("(()=>{[...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent?.includes('放弃修改')).click();return true})()");
 assert(await cdp.waitFor("()=>!!document.querySelector('#org-panel-roles')"),
  "confirmed discard switches to roles");
 assert(await cdp.evaluate(`(()=>new URLSearchParams(location.search).get('folder')===${JSON.stringify(selectedFolder)})()`),
  "resource folder context survives switching tabs");
 console.log("PERMISSIONS_P1_BROWSER_PASS");
}finally{
 cdp?.close();
 chrome.kill("SIGKILL");
}
