#!/usr/bin/env node
// Read-only Rare Workbench overlay regression: no resource writes. Uses a real
// browser on the remote developer server. Credentials are read only on target.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {readFileSync} from "node:fs";

const base="http://127.0.0.1:18091";
// Chrome chooses a free port for every run. A fixed debugging port can attach
// a fresh test to a stale browser from a terminated or concurrent job.
let port=0;
const chromeProfile="/tmp/fm-rare-overlay-"+process.pid;
const chrome=spawn("/usr/bin/google-chrome",[
 "--headless=new","--no-sandbox","--disable-gpu",
 "--user-data-dir="+chromeProfile,
 "--remote-debugging-port=0","--window-size=1440,900","about:blank"
],{stdio:"ignore"});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let ws,seq=0;
const requests=new Map();
function send(method,params={}){
 const id=++seq;
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{requests.delete(id);reject(Error("Chrome DevTools command timed out: "+method+" #"+id));},18000);
  requests.set(id,{resolve,reject,timer});
  ws.send(JSON.stringify({id,method,params}));
 });
}
async function evalJS(expression){
 const result=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
 if(result.exceptionDetails)throw Error("browser evaluation failed: "+JSON.stringify(result.exceptionDetails).slice(0,350));
 return result.result?.value;
}
async function waitFor(expression){
 for(let i=0;i<100;i++){await sleep(130);if(await evalJS(expression))return;}
 throw Error("browser timeout: "+expression);
}
async function navigate(path,ready){
 await send("Page.navigate",{url:base+path});
 await waitFor(ready);
}
async function click(selector){
 const p=await evalJS(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error("not found: "+${JSON.stringify(selector)});const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
 await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:p.x,y:p.y});
 await send("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",clickCount:1,x:p.x,y:p.y});
 await send("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",clickCount:1,x:p.x,y:p.y});
 await sleep(160);
}
async function key(name,code,keyCode){
 await send("Input.dispatchKeyEvent",{type:"rawKeyDown",key:name,code,windowsVirtualKeyCode:keyCode});
 await send("Input.dispatchKeyEvent",{type:"keyUp",key:name,code,windowsVirtualKeyCode:keyCode});
 await sleep(90);
}
async function viewport(width,height){
 await send("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
 await sleep(130);
}
function inside(rect,width,height){
 return rect&&rect.left>=-1&&rect.top>=-1&&rect.right<=width+1&&rect.bottom<=height+1;
}
try{
 for(let i=0;i<100;i++){
 await sleep(110);
 try{
   if(port===0){
    const first=readFileSync(chromeProfile+"/DevToolsActivePort","utf8").split("\n")[0];
    port=Number(first);
    if(!Number.isInteger(port)||port<=0)throw Error("Invalid Chrome debugging port");
   }
   const targets=await(await fetch("http://127.0.0.1:"+port+"/json/list")).json();
   const page=targets.find(t=>t.type==="page");
   if(page){ws=new WebSocket(page.webSocketDebuggerUrl);break;}
  }catch{}
 }
 if(!ws)throw Error("Chrome did not start");
 await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true});});
 ws.addEventListener("message",event=>{
  const response=JSON.parse(event.data),pending=requests.get(response.id);
  if(!pending)return;
  requests.delete(response.id);
  clearTimeout(pending.timer);
  response.error?pending.reject(Error(response.error.message)):pending.resolve(response.result);
 });
 await send("Page.enable");await send("Runtime.enable");
 await navigate("/login","!!document.querySelector('input[type=password]')");
 const password=readFileSync(".secrets/admin.password","utf8").trim();
 assert.equal(await evalJS(`(async()=>{const response=await fetch("/api/login",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({login:"admin",password:${JSON.stringify(password)}})});return response.ok;})()`),true);
 const results=[];
 let availablePreviewId="";
 for(const width of [1440,1280,1220,900,390]){
  const height=width===390?760:900;
  await viewport(width,height);
  await navigate("/doc","!!document.querySelector('.account-trigger')");
  const shellNav=await evalJS(`(()=>{const nav=document.querySelector('header.header nav[data-slot="gooey-nav"]'),
   links=[...nav.querySelectorAll('a[data-slot="gooey-nav-item"]')],
   segments=[...nav.querySelectorAll('[data-slot="gooey-nav-segment"]')],active=links.filter(x=>x.getAttribute('aria-current')==='page'),
   last=segments.at(-1)?.getBoundingClientRect(),right=document.querySelector('.header-right')?.getBoundingClientRect(),
   rect=nav.getBoundingClientRect();return{labels:links.map(x=>x.textContent.trim()),
   paths:links.map(x=>new URL(x.href).pathname),count:segments.length,active:active.map(x=>x.textContent.trim()),
   rendered:getComputedStyle(nav).display,navWidth:rect.width,navScroll:nav.scrollWidth,
   lastRight:last?.right,rightStart:right?.left,overflow:document.documentElement.scrollWidth-innerWidth};})()`);
  assert.deepEqual(shellNav.labels,["文档管理","全局搜索","共享/关注","统计","审批","生命周期","回收站","组织与权限"],
   "all eight global Rare UI navigation links");
  assert(shellNav.count===8&&shellNav.active.length===1&&shellNav.active[0]==="文档管理"&&shellNav.overflow<=1,
   "Rare shell nav selection/layout at "+width+": "+JSON.stringify(shellNav));
  if(width>1210){
   assert(shellNav.rendered!=="none"&&shellNav.lastRight<=shellNav.rightStart+2,
    "desktop GooeyNav fits before header actions at "+width+": "+JSON.stringify(shellNav));
   await evalJS(`(()=>document.querySelector('header.header nav[data-slot="gooey-nav"] a')?.focus())()`);
   await key("ArrowRight","ArrowRight",39);
   assert.equal(await evalJS("document.activeElement?.getAttribute('href')"),"/search","arrow moves focus between Rare navigation links");
   await click('header.header nav[data-slot="gooey-nav"] a[href="/search"]');
   await waitFor('location.pathname==="/search"');
  }else{
   assert.equal(shellNav.rendered,"none","narrow shell hides GooeyNav until requested");
   await click(".nav-toggle");
   await waitFor(`getComputedStyle(document.querySelector('header.header nav[data-slot="gooey-nav"]')).display!=="none"`);
   const mobileNav=await evalJS(`(()=>{const n=document.querySelector('header.header nav[data-slot="gooey-nav"]'),r=n.getBoundingClientRect();
    return{rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},items:[...n.querySelectorAll('a')].every(a=>{const b=a.getBoundingClientRect();return b.width>100&&b.right<=r.right+1})}})()`);
   assert(mobileNav.items&&inside(mobileNav.rect,width,height),
    "narrow GooeyNav expanded within viewport at "+width+": "+JSON.stringify(mobileNav));
   await key("Escape","Escape",27);
   await waitFor(`getComputedStyle(document.querySelector('header.header nav[data-slot="gooey-nav"]')).display==="none"`);
   assert.equal(await evalJS('document.activeElement?.classList.contains("nav-toggle")'),true,"escape returns focus to nav toggle");
   await click(".nav-toggle");
   await waitFor(`getComputedStyle(document.querySelector('header.header nav[data-slot="gooey-nav"]')).display!=="none"`);
   await click('header.header nav[data-slot="gooey-nav"] a[href="/search"]');
   await waitFor('location.pathname==="/search"');
   assert.equal(await evalJS('document.querySelector("#shell-main-navigation")?.classList.contains("open")'),false,
    "narrow nav closes on real client-side route change");
  }
  await navigate("/doc","!!document.querySelector('.account-trigger')");
  await click(".account-trigger");
  await waitFor(`!!document.querySelector('[role=menu][aria-label="账户操作菜单"]')`);
  const menu=await evalJS(`(()=>{const m=document.querySelector('[role=menu][aria-label="账户操作菜单"]');const r=m.getBoundingClientRect();return{portal:m.parentElement===document.body,rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},focused:m.contains(document.activeElement),overflow:document.documentElement.scrollWidth-innerWidth};})()`);
  assert(menu.portal&&menu.focused&&inside(menu.rect,width,height)&&menu.overflow<=1,"account menu overlay at "+width+": "+JSON.stringify(menu));
  await key("Escape","Escape",27);
  await waitFor(`!document.querySelector('[role=menu][aria-label="账户操作菜单"]')`);
  assert.equal(await evalJS('document.activeElement?.classList.contains("account-trigger")'),true,"Escape restores trigger");
  await waitFor('!!document.querySelector(".file-toolbar")');
  const folderTree=await evalJS(`(()=>{const input=document.querySelector('.tree-head input[aria-label="搜索目录"]'),
   current=document.querySelector('.tree li[aria-current="page"]>.tree-row'),
   rail=document.querySelector('.tree>.spring-rail-host');
   return{search:!!input,selected:!!current,rail:rail?getComputedStyle(rail).display:null,
    selectedBackground:current?getComputedStyle(current).backgroundColor:null,
    overflow:document.documentElement.scrollWidth-innerWidth};})()`);
  assert(folderTree.search&&folderTree.overflow<=1,"folder tree searchable at "+width+": "+JSON.stringify(folderTree));
  if(folderTree.selected)assert(folderTree.rail!=="none"&&folderTree.selectedBackground!=="rgba(0, 0, 0, 0)",
   "selected folder has visible Rare spring rail at "+width+": "+JSON.stringify(folderTree));
  if(width===1440){
   await evalJS(`(()=>{const input=document.querySelector('.tree-head input[aria-label="搜索目录"]');
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    setter.call(input,'test-rare-folder');input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
   await waitFor('!!document.querySelector(".tree-search-clear")');
   await click(".tree-search-clear");
   assert.equal(await evalJS(`document.querySelector('.tree-head input[aria-label="搜索目录"]')?.value`),"");
  }
  if(!availablePreviewId){
   await sleep(140);
   availablePreviewId=await evalJS('document.querySelector(".file-table tbody tr[data-id]")?.dataset.id')||"";
  }
  const grid=await evalJS(`(()=>{const table=document.querySelector(".file-table"),bar=document.querySelector(".file-toolbar"),r=bar.getBoundingClientRect();return{role:table?.getAttribute("role"),shared:table?.hasAttribute("data-rare-table"),idleBatch:!!bar.querySelector(".batch-actions-group"),rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},overflow:document.documentElement.scrollWidth-innerWidth};})()`);
  assert(grid.role==="grid"&&grid.shared&&!grid.idleBatch&&inside(grid.rect,width,height)&&grid.overflow<=1,
   "shared file grid + tidy idle toolbar at "+width+": "+JSON.stringify(grid));
  if(width===1440&&await evalJS('!!document.querySelector(".file-table tbody tr[data-id] .col-select input[type=checkbox]")')){
   await click(".file-table tbody tr[data-id] .col-select input[type=checkbox]");
   await waitFor('!!document.querySelector(".file-toolbar .batch-actions-group .file-selected-count")');
   await sleep(210);
   // Selection is conveyed by the native checkbox plus soft row tint.
   // A pointer click must NOT leave a thick row-long focus outline.
   const selectionStyle=await evalJS(`(()=>{
    const row=document.querySelector(".file-table tbody tr.selected");
    const check=row?.querySelector(".col-select input[type=checkbox]");
    const header=document.querySelector(".file-table thead .col-select input[type=checkbox]");
    return row&&check&&header?{
     checked:check.checked,selected:row.getAttribute("aria-selected"),
     shadow:getComputedStyle(row).boxShadow,
     outline:getComputedStyle(row).outlineStyle,
     fill:getComputedStyle(row).backgroundColor,
     tick:getComputedStyle(check,"::after").opacity,
     indeterminate:header.indeterminate,
     headerTabIndex:header.tabIndex,
     total:document.querySelectorAll(".file-table tbody tr[data-id]").length
    }:null;
   })()`);
   assert(selectionStyle&&selectionStyle.checked&&selectionStyle.selected==="true"
    &&selectionStyle.shadow==="none"&&selectionStyle.outline==="none"
    &&Number(selectionStyle.tick)>.95&&selectionStyle.headerTabIndex>=0
    &&(selectionStyle.total===1||selectionStyle.indeterminate),
    "quiet file selection/accessible mixed checkbox: "+JSON.stringify(selectionStyle));
   await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:2,y:2});
   await sleep(200);
   const idleActions=await evalJS(`(()=>{
    const row=document.querySelector(".file-table tbody tr.selected");
    const actions=row?.querySelector(".actions-hover-group");
    return actions?{opacity:getComputedStyle(actions).opacity,
     checked:row.querySelector(".col-select input").checked,
     alwaysVisible:matchMedia("(hover: none), (pointer: coarse)").matches||document.querySelector(".work-body").clientWidth<=820}:null;
   })()`);
   assert(idleActions&&Number(idleActions.opacity)===(idleActions.alwaysVisible?1:0)&&idleActions.checked,
    "selected file respects desktop hover / touch discoverability: "+JSON.stringify(idleActions));
   results.push("1440px: quiet selected file, mixed select-all, low-noise actions OK");
   const batch=await evalJS(`(()=>({count:document.querySelector(".file-selected-count")?.textContent?.trim(),
    buttons:[...document.querySelectorAll(".batch-actions-group button")].map(x=>x.textContent?.trim()||x.getAttribute("aria-label"))}))()`);
   assert(batch.count?.includes("1")&&batch.buttons.includes("移动")&&batch.buttons.includes("删除")&&batch.buttons.includes("取消全部选中"),
    "selection reveals actionable batch toolbar: "+JSON.stringify(batch));
   await click(".batch-clear-selection");
   await waitFor('!document.querySelector(".batch-actions-group")');
  }
  await navigate("/stats",`!!document.querySelector('.rare-select[aria-label="修改时间"]')`);
  await click('.rare-select[aria-label="修改时间"]');
  await waitFor('!!document.querySelector(".rare-select-menu [role=option]")');
  const select=await evalJS(`(()=>{const b=document.querySelector('.rare-select[aria-label="修改时间"]');const m=document.querySelector(".rare-select-menu");const r=m.getBoundingClientRect();return{role:b.getAttribute("role"),expanded:b.getAttribute("aria-expanded"),count:m.querySelectorAll('[role=option]').length,rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},overflow:document.documentElement.scrollWidth-innerWidth};})()`);
  assert(select.role==="combobox"&&select.expanded==="true"&&select.count>=3&&inside(select.rect,width,height)&&select.overflow<=1,"time dropdown at "+width+": "+JSON.stringify(select));
  await click('.rare-select-menu [role="option"]:nth-child(2)');
  assert.equal(await evalJS(`document.querySelector('.rare-select[aria-label="修改时间"]').getAttribute("aria-expanded")`),"false");
  results.push(width+"px: global Gooey nav / menu / combobox OK");
 }
 await viewport(1440,900);
 await navigate("/doc",'!!document.querySelector(".new-folder-wrapper > button")');
 await click(".new-folder-wrapper > button");
 await waitFor('!!document.querySelector("dialog:modal .dialog-close")');
 const dialog=await evalJS(`(()=>{const d=document.querySelector("dialog:modal"),c=d.querySelector(".dialog-close");const r=d.getBoundingClientRect();return{title:!!d.querySelector('.dialog-header .dialog-title'),close:c.getAttribute("aria-label"),focused:document.activeElement?.id,rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom}};})()`);
 assert(dialog.title&&dialog.close==="关闭弹窗"&&dialog.focused==="new-folder-modal-input"&&inside(dialog.rect,1440,900),"dialog title/first focus: "+JSON.stringify(dialog));
 await click("dialog:modal .dialog-close");
 await waitFor('!document.querySelector("dialog:modal")');
 assert.equal(await evalJS('document.activeElement?.classList.contains("action-btn-secondary")'),true,"dialog close restores trigger");
 await navigate("/org?tab=permissions&view=folder",`!!document.querySelector(".perm-subnav .perm-view-nav[data-slot=gooey-nav]")`);
 const permissions=await evalJS(`(()=>{const nav=document.querySelector(".perm-view-nav");
  const segments=[...nav.querySelectorAll('[data-slot="gooey-nav-segment"]')];
  const selected=nav.querySelector('[data-slot="gooey-nav-item"][aria-current="page"]');
  const tabs=document.querySelector(".perm-manage-tabs");
  return{count:segments.length,selected:selected?.textContent?.trim(),
   activeFill:getComputedStyle(segments[0]).backgroundColor,
   panelWidth:document.querySelector(".perm-workspace")?.getBoundingClientRect().width,
   tabs:!!tabs,scroll:document.documentElement.scrollWidth-innerWidth};})()`);
 assert(permissions.count===3&&permissions.selected==="资源授权"&&permissions.activeFill!=="rgba(0, 0, 0, 0)"&&permissions.scroll<=1,
  "real branded Gooey nav in permission workbench: "+JSON.stringify(permissions));
 await evalJS(`(()=>{document.querySelectorAll('.perm-view-nav [data-slot="gooey-nav-item"]')[1].click();return true})()`);
 await sleep(350);
 const navResult=await evalJS(`(()=>({url:location.href,view:new URLSearchParams(location.search).get("view"),
  modal:document.querySelector('dialog:modal')?.textContent?.slice(0,100),
  selected:document.querySelector('.perm-view-nav [aria-current="page"]')?.textContent?.trim(),
  count:document.querySelectorAll('.perm-view-nav [data-slot="gooey-nav-item"]').length}))()`);
 assert.equal(navResult.view,"audit","Gooey nav must navigate without unexpected dirty guard: "+JSON.stringify(navResult));
 assert.equal(await evalJS(`document.querySelector('.perm-view-nav [aria-current="page"]')?.textContent?.trim()`),"权限变更审计");
 // Workgroups are a task-first master/detail surface; the selected row and
 // detail heading must agree even when a filter changes the list.
 for(const width of [1440,900,390]){
  await viewport(width,width===390?760:900);
  await navigate("/org?tab=groups",'!!document.querySelector(".org-groups-stage")');
  const groupUI=await evalJS(`(()=>({rows:[...document.querySelectorAll(".org-group-card")].length,
   selected:[...document.querySelectorAll('.org-group-card[aria-pressed="true"]')].length,
   search:!!document.querySelector('input[aria-label="搜索工作组"]'),
   overflow:document.documentElement.scrollWidth-innerWidth}))()`);
  assert(groupUI.search&&groupUI.selected<=1&&groupUI.overflow<=1,
   "compact group workbench at "+width+": "+JSON.stringify(groupUI));
  if(groupUI.rows>1){
   await evalJS(`(()=>{document.querySelector(".org-group-card:not(.active)")?.click();return true})()`);
   await waitFor('!!document.querySelector(".org-group-card.active[aria-pressed=true]")');
   const selection=await evalJS(`(()=>({name:document.querySelector('.org-group-card.active .org-group-name')?.textContent?.trim(),
    inspector:document.querySelector('.org-group-detail-title')?.textContent?.trim()}))()`);
   assert(selection.name===selection.inspector,"group selected and inspector synchronized: "+JSON.stringify(selection));
  }
  results.push(width+"px: workgroup master/detail OK");
 }
 // Role ACL action presets are presentation-only until the separate preview
 // and confirmation workflow is submitted. Never submit a form in this test.
 await viewport(1440,900);
 console.log("RARE_ROLE_CHECK navigating to role editor");
 await navigate("/org?tab=roles",'!!document.querySelector(".org-role-editor")');
 console.log("RARE_ROLE_CHECK opening role selector");
 await click(".org-role-editor .perm-form-row>label:nth-child(2) .rare-select");
 await waitFor('!!document.querySelector(".rare-select-menu [role=option]")');
 console.log("RARE_ROLE_CHECK choosing folder permission administrator");
 await evalJS(`(()=>{const option=[...document.querySelectorAll(".rare-select-menu [role=option]")].find(x=>x.textContent.includes("目录权限管理员"));if(!option)throw Error("permission-admin role missing");option.click();return true})()`);
 await waitFor('!!document.querySelector(".org-role-action-tools")');
 console.log("RARE_ROLE_CHECK toggling action presets");
 const actionsBefore=await evalJS(`(()=>({total:document.querySelectorAll(".org-role-editor .perm-action-grid input[type=checkbox]").length,
  selected:[...document.querySelectorAll(".org-role-editor .perm-action-grid input[type=checkbox]")].filter(x=>x.checked).length}))()`);
 assert(actionsBefore.total>=8,"role action choices visible: "+JSON.stringify(actionsBefore));
 await click(".org-role-action-tools .rare-button:first-of-type");
 await waitFor(`[...document.querySelectorAll(".org-role-editor .perm-action-grid input[type=checkbox]")].every(x=>x.checked)`);
 await click(".org-role-action-tools .rare-button:last-of-type");
 await waitFor(`[...document.querySelectorAll(".org-role-editor .perm-action-grid input[type=checkbox]")].every(x=>!x.checked)`);
 results.push("1440px: role ACL select-all/clear without submission OK");
 // Deep-linking to the seal library must not lose its selected view on reload.
 for(const width of [1440,900,390]){
  await viewport(width,width===390?760:900);
  await navigate("/approvals?tab=seals",`!!document.querySelector(".approval-root-nav [data-slot=gooey-nav-item]")`);
  await waitFor('!!document.querySelector(".seal-library-container")');
  const approval=await evalJS(`(()=>{const n=document.querySelector(".approval-root-nav"),links=[...n.querySelectorAll('[data-slot="gooey-nav-item"]')];
   const s=[...n.querySelectorAll('[data-slot="gooey-nav-segment"]')];
   return{labels:links.map(x=>x.textContent.trim()),active:n.querySelector('[aria-current="page"]')?.textContent.trim(),
    activeFill:getComputedStyle(s[1]).backgroundColor,overflow:document.documentElement.scrollWidth-innerWidth};})()`);
  assert(approval.labels.length===2&&approval.active.includes("签章")&&approval.activeFill!=="rgba(0, 0, 0, 0)"&&approval.overflow<=1,
   "approval Rare view switch at "+width+": "+JSON.stringify(approval));
  await click('.approval-root-nav [data-slot="gooey-nav-item"]:first-child');
  await waitFor('new URLSearchParams(location.search).get("tab")!=="seals"');
  await waitFor('!!document.querySelector(".approval-page")');
  if(width<=900){
   await click(".approval-mobile-notes");
   await waitFor('getComputedStyle(document.querySelector(".approval-side")).display!=="none"');
  }
  const sideNav=await evalJS(`(()=>{const n=document.querySelector(".approval-side-nav"),
   items=[...n.querySelectorAll('[data-slot="gooey-nav-item"]')];
   return{count:items.length,current:n.querySelector('[aria-current="page"]')?.textContent.trim(),
    overflow:document.documentElement.scrollWidth-innerWidth};})()`);
  assert(sideNav.count===2&&sideNav.current==="申请详情"&&sideNav.overflow<=1,
   "approval inspector Rare navigation at "+width+": "+JSON.stringify(sideNav));
  await click('.approval-side-nav [data-slot="gooey-nav-item"]:nth-child(2)');
  await waitFor('!!document.querySelector(".approval-notification-list")');
  await click('.approval-side-nav [data-slot="gooey-nav-item"]:first-child');
  await waitFor('!!document.querySelector(".approval-side-nav [aria-current=page]")');
  const approvalRow=await evalJS('document.querySelector(".approval-table tbody tr .approval-file-name")?.closest("tr")?.getAttribute("tabindex")');
  if(approvalRow!==undefined&&approvalRow!==null)assert.equal(approvalRow,"0","approval rows keyboard-focusable");
  assert.equal(await evalJS('document.querySelector(".approval-root-nav [aria-current=page]")?.textContent.trim()'),"审批工作台");
  await evalJS("history.back()");
  await waitFor('new URLSearchParams(location.search).get("tab")==="seals"');
  await waitFor('!!document.querySelector(".seal-library-container")');
  results.push(width+"px: approval URL/Gooey view switch OK");
 }
 if(availablePreviewId){
  for(const width of [1440,390]){
   await viewport(width,width===390?760:900);
   await navigate("/preview/"+encodeURIComponent(availablePreviewId),'!!document.querySelector(".file-workbench-actions .file-more-trigger")');
   const preview=await evalJS(`(()=>{const a=document.querySelector(".file-workbench-actions"),r=a.getBoundingClientRect();
    const tabs=[...document.querySelectorAll(".file-workbench-tabs [role=tab]")];
    return{buttons:[...a.children].filter(x=>x.tagName==="BUTTON").map(x=>x.textContent.trim()),
     tabCount:tabs.length,selected:tabs.filter(x=>x.getAttribute("aria-selected")==="true").length,
     rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},overflow:document.documentElement.scrollWidth-innerWidth};})()`);
   assert(preview.buttons.includes("下载")&&preview.buttons.some(x=>x.includes("更多操作"))&&preview.buttons.length<=4&&preview.tabCount===6&&preview.selected===1&&preview.overflow<=1,
    "compact file actions and Rare tabs at "+width+": "+JSON.stringify(preview));
   await click(".file-more-trigger");
   await waitFor(`!!document.querySelector('[role=menu][aria-label="文件更多操作"]')`);
   const actionMenu=await evalJS(`(()=>({labels:[...document.querySelectorAll('[role=menu][aria-label="文件更多操作"] [role=menuitem]')].map(x=>x.textContent.trim()),
    portal:document.querySelector('[role=menu][aria-label="文件更多操作"]')?.parentElement===document.body}))()`);
   assert(actionMenu.portal&&actionMenu.labels.includes("重命名")&&actionMenu.labels.includes("移动文件")&&actionMenu.labels.includes("移入回收站"),
    "all secondary file actions preserved: "+JSON.stringify(actionMenu));
   await key("Escape","Escape",27);
   await waitFor(`!document.querySelector('[role=menu][aria-label="文件更多操作"]')`);
   assert.equal(await evalJS('document.activeElement?.classList.contains("file-more-trigger")'),true);
   await evalJS(`(()=>{document.querySelector("#file-tab-versions")?.scrollIntoView({block:"nearest",inline:"nearest"});return true})()`);
   await sleep(120);
   await click("#file-tab-versions");
   await waitFor('!!document.querySelector("#file-panel-versions")');
   assert.equal(await evalJS('document.querySelector("#file-tab-versions")?.getAttribute("aria-selected")'),"true");
   results.push(width+"px: preview actions/menu/Rare tabs OK");
  }
 }
 console.log("RARE_OVERLAY_READONLY_PASS "+results.join("; ")+"; file grid, permission Gooey, dialog and focus OK"+(availablePreviewId?"":"; preview fixture absent"));
}catch(error){
 console.error("RARE_OVERLAY_READONLY_FAIL",error.message);
 try{
  const snapshot=await evalJS(`(()=>({url:location.href,ready:document.readyState,
   title:document.title,body:document.body.innerText.slice(0,450),
   stats:!!document.querySelector(".stats-workbench"),selects:document.querySelectorAll(".rare-select").length}))()`);
  console.error("RARE_OVERLAY_BROWSER_STATE",JSON.stringify(snapshot));
 }catch(snapshotError){console.error("RARE_OVERLAY_BROWSER_STATE_UNAVAILABLE",snapshotError.message);}
 process.exitCode=1;
}
finally{ws?.close();chrome.kill("SIGTERM");}
