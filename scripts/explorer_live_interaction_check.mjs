#!/usr/bin/env node
// Development-only authenticated Chrome check of actual pointer events and
// favorite persistence. It restores a tested favorite to its initial state.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {readFileSync,rmSync} from "node:fs";

const origin="http://127.0.0.1:18091";
const profile="/tmp/fm-explorer-real-"+process.pid;
const chrome=spawn("/usr/bin/google-chrome",[
 "--headless=new","--no-sandbox","--disable-gpu","--disable-dev-shm-usage",
 "--user-data-dir="+profile,"--remote-debugging-port=0","--window-size=1440,900","about:blank"
],{stdio:"ignore"});
const delay=ms=>new Promise(done=>setTimeout(done,ms));
let ws,port=0,seq=0;
const pending=new Map();
function send(method,params={}){
 const id=++seq;
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{pending.delete(id);reject(Error("CDP timeout "+method));},16000);
  pending.set(id,{resolve,reject,timer});
  ws.send(JSON.stringify({id,method,params}));
 });
}
async function evaluate(source){
 const r=await send("Runtime.evaluate",{expression:source,returnByValue:true,awaitPromise:true});
 if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);
 return r.result?.value;
}
async function until(expression,description=expression){
 for(let i=0;i<120;i++){if(await evaluate(expression))return;await delay(130);}
 throw Error("Timeout: "+description);
}
async function navigate(path,selector){
 await send("Page.navigate",{url:origin+path});
 await until(selector);
}
async function click(selector,index=0,modifiers=0){
 // An animated scroll can move an icon tile between the mouse press and
 // release; wait for the target coordinates to settle before dispatching.
 await evaluate(`(()=>{
  const node=document.querySelectorAll(${JSON.stringify(selector)})[${index}];
  node?.scrollIntoView({behavior:"instant",block:"center",inline:"center"});
 })()`);
 await delay(100);
 const rect=await evaluate(`(()=>{
  const node=document.querySelectorAll(${JSON.stringify(selector)})[${index}];
  if(!node)return null;
  const b=node.getBoundingClientRect();
  return {x:b.left+b.width/2,y:b.top+b.height/2};
 })()`);
 assert(rect,"missing clickable "+selector+"["+index+"]");
 await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:rect.x,y:rect.y,modifiers});
 await send("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",clickCount:1,x:rect.x,y:rect.y,modifiers});
 await send("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",clickCount:1,x:rect.x,y:rect.y,modifiers});
}
const selectedFiles=()=>evaluate('document.querySelectorAll("tr.file-entry[aria-selected=true]").length');
const selectionText=()=>evaluate('document.querySelector(".file-selected-count")?.textContent||""');
const favoriteRead=()=>evaluate('(async()=>{const response=await fetch("/api/favorites",{cache:"no-store"});const json=await response.json();return {status:response.status,ok:json.ok,rows:json.data};})()');

let tested=null,originalFavorite=false;
let testedFolder=null,originalFolderFavorite=false;
let copiedTestId=null,copyDestination=null;
let copyBeforeIds=[];
try{
 for(let i=0;i<120;i++){
  await delay(90);
  try{
   if(!port)port=Number(readFileSync(profile+"/DevToolsActivePort","utf8").split("\n")[0]);
   const targets=await(await fetch("http://127.0.0.1:"+port+"/json/list")).json();
   const page=targets.find(x=>x.type==="page");
   if(page){ws=new WebSocket(page.webSocketDebuggerUrl);break;}
  }catch{}
 }
 assert(ws,"Chrome startup failure");
 await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true});});
 ws.addEventListener("message",ev=>{
  const result=JSON.parse(ev.data);
  const item=pending.get(result.id);
  if(!item)return;
  pending.delete(result.id);clearTimeout(item.timer);
  result.error?item.reject(Error(result.error.message)):item.resolve(result.result);
 });
 await send("Page.enable");await send("Runtime.enable");
 await navigate("/login",'!!document.querySelector("input[type=password]")');
 const password=readFileSync(".secrets/admin.password","utf8").trim();
 assert(await evaluate(`(async()=>{const r=await fetch("/api/login",{method:"POST",credentials:"same-origin",
  headers:{"Content-Type":"application/json"},body:JSON.stringify({login:"admin",password:${JSON.stringify(password)}})});return r.ok;})()`),
  "Development admin authentication failed");
 await navigate("/doc",'!!document.querySelector(".folder-view-switch")');
 await click('.folder-view-switch button[aria-label="列表视图"]');
 await until('document.querySelector(".work-body")?.dataset.explorerView==="list"');
 await until('document.querySelectorAll("tr.file-entry,.explorer-list-folder").length>0',
  "Initial folder rows must finish rendering before checking file count");
 const folderDate=await evaluate(`(async()=>{
  const tree=await(await fetch("/api/folders/tree",{cache:"no-store"})).json();
  const row=document.querySelector(".explorer-list-folder");
  const data=tree.data?.find(entry=>entry.id===row?.dataset.uploadFolderId);
  return {api:data?.updatedAt,displayed:row?.querySelector("td.col-date")?.textContent.trim(),raw:row?.querySelector("td.col-date")?.getAttribute("title")};
 })()`);
 assert(folderDate.api&&folderDate.raw===folderDate.api&&/^(?:今天|昨天|(?:\d{4}年)?\d{1,2}月\d{1,2}日) \d{2}:\d{2}$/.test(folderDate.displayed),
  "Folder modified date must preserve the API time and show Finder-style local text: "+JSON.stringify(folderDate));
 console.log("EXPLORER_FOLDER_MTIME_PASS",JSON.stringify(folderDate));
 // Inspect the real Finder rail in every view instead of assuming presence
 // of a sidebar node means its content is visible. Keep probes long enough
 // to catch repeated remounts or collapsing scroll ports.
 for(const mode of ["icons","list"]){
  await evaluate(`(()=>document.querySelector('.folder-view-switch button[aria-label="${mode==="icons"?"图标视图":"列表视图"}"]')?.click())()`);
  await until(`document.querySelector('.work-body')?.dataset.explorerView==="${mode}"`);
  for(let pass=0;pass<12;pass++){
   await delay(250);
   const rail=await evaluate(`(()=>{
    const get=selector=>document.querySelector(selector);
    const rect=element=>element?.getBoundingClientRect();
    const sidebar=get('.finder-sidebar'),scroll=get('.finder-sidebar .sidebar-scroll'),
     nav=get('.finder-navigation'),item=get('.finder-nav-item'),home=get('.finder-sidebar-home');
    const s=rect(scroll),n=rect(nav),r=rect(item),h=rect(home);
    const over=r?document.elementFromPoint(r.left+12,r.top+r.height/2):null;
    return {mode:get('.work-body')?.dataset.explorerView,
     sidebar:rect(sidebar)?.width,scrollHeight:s?.height,navTop:n?.top,navHeight:n?.height,
     itemTop:r?.top,itemHeight:r?.height,homeHeight:h?.height,
     hit:over?.className??null,hidden:nav?getComputedStyle(nav).visibility:'missing',
     visible:!!s&&!!r&&r.top>=s.top-1&&r.bottom<=s.bottom+1&&r.height>=27&&
      !!over&&(over===item||item.contains(over))};
   })()`);
   console.log("EXPLORER_SIDEBAR_STABILITY",mode,pass,JSON.stringify(rail));
   assert(rail.visible&&rail.homeHeight===48,
    "Finder sidebar disappeared or is occluded in "+mode+" view: "+JSON.stringify(rail));
  }
 }
 // The command row is portalled into the folder toolbar. Verify its actual
 // geometry, not just the absence of a page-wide overflow scrollbar.
 for(const viewport of [{name:"wide",width:1920},{name:"laptop",width:1366},{name:"compact",width:820}]){
  await send("Emulation.setDeviceMetricsOverride",{width:viewport.width,height:900,deviceScaleFactor:1,mobile:false});
  await delay(140);
  const layout=await evaluate(`(()=>{
   const bounds=s=>document.querySelector(s)?.getBoundingClientRect();
   const inBounds=(rect,clip)=>!!rect&&!!clip&&rect.width>10&&rect.height>10&&rect.left>=clip.left-2&&rect.right<=clip.right+2;
   const bar=bounds('.folder-context-bar'),host=bounds('.folder-file-toolbar-host'),command=bounds('.folder-file-toolbar-host .file-toolbar');
   const toolbar=document.querySelector('.folder-file-toolbar-host .file-toolbar');
   const uploads=bounds('.folder-file-toolbar-host .upload-button'),folders=bounds('.folder-file-toolbar-host .new-folder-wrapper');
   const views=bounds('.folder-file-toolbar-host .folder-view-switch');
   const search=bounds('.folder-file-toolbar-host .filter-search-wrap');
   const table=bounds('.explorer-striped-list table.file-table'),list=bounds('.work-body>.explorer-striped-list');
   const header=bounds('.shell>.header'),dock=bounds('.global-utility-dock'),nav=bounds('.header-gooey-nav');
   const sizeHead=document.querySelector('.file-table th.col-size'),sizeCell=document.querySelector('.file-table tbody td.col-size');
   const sizeButton=sizeHead?.querySelector('.file-column-sort'),range=document.createRange();
   if(sizeCell)range.selectNodeContents(sizeCell);
   const sizeText=sizeCell?.getClientRects().length?range.getBoundingClientRect():null;
   const history=[...document.querySelectorAll('.folder-history-controls button')];
   const status=document.querySelector('.work-body>.status-bar'),statusStyle=status&&getComputedStyle(status);
   const navRow=document.querySelector('.finder-nav-item'),tagRow=document.querySelector('.finder-tag-link');
   const chrome=document.querySelector('.folder-context-bar');
   const controls=[...chrome.querySelectorAll('.folder-file-toolbar-host .upload-button,.folder-file-toolbar-host .action-btn-secondary,.folder-file-toolbar-host .explorer-tool-icon,.folder-file-toolbar-host .folder-view-switch,.folder-file-toolbar-host .folder-view-switch button,.folder-file-toolbar-host input.filter-search-input')];
   const headerButtons=[...chrome.querySelectorAll('button[aria-label="更多操作"]')];
   const tinyIcons=[...document.querySelectorAll('.finder-favorite-item svg')];
   const group=document.querySelector('.finder-nav-section'),heading=group?.querySelector('.finder-nav-label'),sideIcon=group?.querySelector('.finder-nav-item svg');
   const footer=document.querySelector('.finder-bottom-bar'),footerCount=footer?.querySelector('.finder-bottom-count'),footerPath=footer?.querySelector('.finder-bottom-path');
   const names=document.querySelectorAll('.file-entry .finder-list-filename');
   const brand=bounds('.finder-sidebar-home'),brandLogo=bounds('.finder-sidebar-logo'),brandName=bounds('.finder-sidebar-home>span');
   const work=bounds('.document-explorer>.work'),pane=bounds('.panels.document-explorer');
   const workStyle=getComputedStyle(document.querySelector('.document-explorer>.work'));
   const paneStyle=getComputedStyle(document.querySelector('.panels.document-explorer'));
   const headerStyle=getComputedStyle(document.querySelector('.shell>.header'));
   const railStyle=getComputedStyle(document.querySelector('.finder-sidebar'));
   const centre=rect=>(rect.top+rect.bottom)/2;
   const tagFixture=document.createElement('span');
   tagFixture.className='file-finder-mark-overflow';tagFixture.textContent='+4';
   (document.querySelector('.file-table .file-name-group')||document.querySelector('.work-body')).append(tagFixture);
   const tagStyle=getComputedStyle(tagFixture);
   const tagPill=tagStyle.marginLeft==='4px'&&tagStyle.paddingTop==='1px'&&tagStyle.paddingLeft==='5px'&&
    tagStyle.borderTopLeftRadius==='999px'&&tagStyle.backgroundColor==='rgba(15, 23, 42, 0.05)'&&
    tagStyle.fontSize==='11px'&&tagStyle.fontWeight==='500'&&tagStyle.color===getComputedStyle(document.querySelector('.finder-bottom-count')).color;
   tagFixture.remove();
   const getTextRect=element=>{const node=[...element?.childNodes||[]].find(x=>x.nodeType===3&&x.textContent.trim());if(!node)return null;const r=document.createRange();r.selectNodeContents(node);return r.getBoundingClientRect();};
   const nameHead=getTextRect(document.querySelector('th.col-name .file-column-sort')),nameIcon=bounds('.explorer-list-folder .file-cell-wrap>.resource-folder-icon');
   const dateHead=getTextRect(document.querySelector('th.col-date .file-column-sort')),dateCell=document.querySelector('tbody td.col-date'),dateRange=document.createRange();
   if(dateCell)dateRange.selectNodeContents(dateCell);
   const dateText=dateCell?.getClientRects().length?dateRange.getBoundingClientRect():null;
   return {barHeight:bar?.height,portalled:!!toolbar&&document.querySelector('.work-body>.file-toolbar')===null,
    oneRow:inBounds(command,bar),uploads:inBounds(uploads,host),folders:inBounds(folders,host),
    views:inBounds(views,host),search:inBounds(search,host),
    overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
    sidebar:bounds('.finder-sidebar')?.height,header:bounds('.header')?.top,sidebarTop:bounds('.finder-sidebar')?.top,
    tableFills:!!table&&!!list&&table.width>=list.width-20&&table.right>=list.right-19&&table.right<=list.right+1,
    sizeAligned:!sizeText||!sizeButton||Math.abs(sizeButton.getBoundingClientRect().right-sizeText.right)<2,
    headerDockRight:!!dock&&!!header&&Math.abs((header.right-dock.right)-16)<=2,
    navCentered:innerWidth<=1210||!!nav&&!!header&&nav.left>=header.left+10&&nav.left<=header.left+24,
    navRowHeight:navRow?.getBoundingClientRect().height,tagRowHeight:tagRow?.getBoundingClientRect().height,
    historyPair:history.length===2&&history.every(button=>button.getBoundingClientRect().width>=25&&getComputedStyle(button).visibility!=='hidden'),
    statusSeam:!!statusStyle&&statusStyle.borderTopLeftRadius==='0px'&&statusStyle.borderBottomLeftRadius==='0px'&&statusStyle.borderBottomWidth==='0px'&&statusStyle.borderLeftWidth==='0px'&&statusStyle.borderTopWidth==='1px',
    toolbarSeam:getComputedStyle(document.querySelector('.folder-context-bar')).borderTopLeftRadius==='0px',
    singleMore:headerButtons.length===1&&chrome.querySelectorAll('.folder-more-wrapper').length===0,
    controls28:controls.length>=8&&controls.every(el=>Math.abs(el.getBoundingClientRect().height-28)<=1),
    corners6:controls.every(el=>getComputedStyle(el).borderTopLeftRadius==='6px'),
    nav26:history.every(el=>Math.abs(el.getBoundingClientRect().height-26)<1),
    nameLine:!nameHead||!nameIcon||Math.abs(nameHead.left-nameIcon.left)<=1.5,
    dateLine:!dateHead||!dateText||Math.abs(dateHead.left-dateText.left)<=1.5,
    sidebarLine:!heading||!sideIcon||Math.abs(heading.getBoundingClientRect().left+parseFloat(getComputedStyle(heading).paddingLeft)-sideIcon.getBoundingClientRect().left)<1.5,
    monochrome:tinyIcons.every(el=>el.classList.contains('finder-line-icon')&&el.getBoundingClientRect().width===16&&getComputedStyle(el).strokeWidth==='1.75px'),
    footer28:!!footer&&Math.abs(footer.getBoundingClientRect().height-28)<1&&
     !!footerPath&&!!footerCount&&Math.abs((footerCount.getBoundingClientRect().left+footerCount.getBoundingClientRect().right)/2-(footer.getBoundingClientRect().left+footer.getBoundingClientRect().right)/2)<1.5&&
     footer.querySelectorAll('.finder-bottom-node svg').length>0&&document.querySelectorAll('.work-body>.finder-bottom-path').length===0,
    nameTokens:names.length===0||[...names].every(el=>el.querySelector('.finder-name-prefix')&&(!el.textContent.match(/\.[a-z0-9]+$/i)||el.querySelector('.finder-name-extension'))),
    brandHeaderAligned:!!brand&&!!header&&!!brandLogo&&!!brandName&&
     Math.abs(brand.top-header.top)<=1&&Math.abs(brand.height-48)<=.5&&Math.abs(header.height-48)<=.5&&
     Math.abs(centre(brandLogo)-centre(header))<=1&&Math.abs(centre(brandName)-centre(header))<=1&&
     (!nav?.width||Math.abs(centre(nav)-centre(header))<=1),
    greyChrome:headerStyle.backgroundColor==='rgb(244, 245, 247)'&&
     railStyle.backgroundColor==='rgb(244, 245, 247)'&&paneStyle.backgroundColor==='rgb(244, 245, 247)',
    insetCanvas:!!work&&workStyle.borderTopLeftRadius==='10px'&&workStyle.borderBottomLeftRadius==='0px'&&
     workStyle.borderBottomRightRadius==='0px'&&workStyle.overflowX==='hidden'&&workStyle.backgroundColor==='rgb(255, 255, 255)',
    bottomFlush:!!work&&!!pane&&!!footer&&Math.abs(footer.getBoundingClientRect().bottom-work.bottom)<=1.5&&
     paneStyle.borderBottomLeftRadius==='0px'&&paneStyle.borderBottomRightRadius==='0px'&&
     statusStyle.borderBottomLeftRadius==='0px'&&statusStyle.borderBottomRightRadius==='0px',
    tagOverflowPill:tagPill};
  })()`);
  console.log('EXPLORER_UNIFIED_TOOLBAR_GEOMETRY',viewport.name,JSON.stringify(layout));
  assert(layout.portalled&&layout.barHeight>=43&&layout.barHeight<=45&&layout.oneRow&&layout.uploads&&layout.folders&&layout.views&&layout.search&&layout.overflow<=1,
   'One accessible, unclipped Finder toolbar at '+viewport.width+': '+JSON.stringify(layout));
  assert(layout.sidebarTop<=layout.header+2,'Finder sidebar extends to header at '+viewport.width);
  assert(layout.tableFills&&layout.sizeAligned&&layout.headerDockRight&&layout.navCentered&&
   layout.navRowHeight<=29&&layout.tagRowHeight<=29&&layout.historyPair&&layout.statusSeam&&layout.toolbarSeam,
   'Full-width columns, dock alignment and continuous Finder chrome at '+viewport.width+': '+JSON.stringify(layout));
  assert(layout.singleMore&&layout.controls28&&layout.corners6&&layout.nav26&&layout.nameLine&&layout.dateLine&&
   layout.sidebarLine&&layout.monochrome&&layout.footer28&&layout.nameTokens,
   'Sonoma/Sequoia pixel contract at '+viewport.width+': '+JSON.stringify(layout));
  assert(layout.brandHeaderAligned&&layout.greyChrome&&layout.insetCanvas&&layout.bottomFlush&&layout.tagOverflowPill,
   '48px Finder shared baseline, 10px inset canvas, seamless footer, +N tag pill at '+viewport.width+': '+JSON.stringify(layout));
 }
 await send('Emulation.clearDeviceMetricsOverride');
 await click('.folder-file-toolbar-host button[aria-label="更多操作"]');
 await until('!!document.querySelector(\'[role="menu"][aria-label="更多操作"]\')');
 const mergedMenuLabels=await evaluate('[...document.querySelectorAll(\'[role="menu"][aria-label="更多操作"] [role="menuitem"]\')].map(item=>item.textContent.trim())');
 assert(mergedMenuLabels.some(label=>label.includes("显示勾选框"))&&
  mergedMenuLabels.some(label=>label.includes("授权管理"))&&
  mergedMenuLabels.some(label=>label.includes("重命名当前目录"))&&
  mergedMenuLabels.some(label=>label.includes("移动当前目录"))&&
  mergedMenuLabels.some(label=>label.includes("删除当前目录")),
  "One overflow popup must retain all display and folder management actions: "+JSON.stringify(mergedMenuLabels));
 await click('[role="menu"][aria-label="更多操作"] [role="menuitem"]',mergedMenuLabels.findIndex(label=>label.includes("重命名当前目录")));
 await until('!!document.querySelector("dialog[open]")',"Rename modal must open from the unified popup");
 assert(await evaluate('document.querySelector("dialog[open]")?.textContent.includes("重命名目录")'),
  "Existing folder rename workflow must remain reachable");
 await click('dialog[open] .dialog-close');
 await until('!document.querySelector("dialog[open]")');
 console.log("EXPLORER_UNIFIED_FOLDER_ACTIONS_PASS",JSON.stringify(mergedMenuLabels));
 let count=await evaluate('document.querySelectorAll("tr.file-entry").length');
 if(count<4){
  const queue=await evaluate('[...document.querySelectorAll(".explorer-list-folder")].map(el=>el.dataset.uploadFolderId).filter(Boolean)');
  const visited=new Set();
  while(queue.length&&count<4&&visited.size<60){
   const id=queue.shift();
   if(visited.has(id))continue;
   visited.add(id);
   await navigate("/doc?folder="+encodeURIComponent(id),'!!document.querySelector(".folder-file-toolbar-host .file-toolbar")');
   await until('!document.querySelector(".work-body .table .brand-loading-label")');
   await delay(450);
   count=await evaluate('document.querySelectorAll("tr.file-entry").length');
   if(count<4){
    const children=await evaluate('[...document.querySelectorAll(".explorer-list-folder")].map(el=>el.dataset.uploadFolderId).filter(Boolean)');
    queue.push(...children.filter(child=>!visited.has(child)));
   }
  }
 }
 if(count<4){
  const diagnostics=await evaluate(`(async()=>{
   const tree=await(await fetch("/api/folders/tree")).json();
   const root=tree.data?.find(item=>item.parentId===null);
   const files=root?await(await fetch("/api/files?folder="+encodeURIComponent(root.id)+"&sort=updated_desc&limit=50")).json():null;
   return {path:location.pathname+location.search,treeCount:tree.data?.length,
    root:root?.id,fileCount:files?.data?.items?.length,fileError:files?.error,
    pageText:document.body.textContent.slice(-250)};
  })()`);
  console.error("EXPLORER_REAL_DATA_DIAGNOSTIC",JSON.stringify(diagnostics));
 }
 assert(count>=4,"Need at least four authorized file rows for real input regression; loaded="+count);
 await click("tr.file-entry .file-name",0);
 await until('(document.querySelector(".file-selected-count")?.textContent||"").includes("已选 1")');
 await click("tr.file-entry .file-name",1);
 await until('document.querySelectorAll("tr.file-entry[aria-selected=true]").length===1');
 assert.equal(await evaluate('document.querySelectorAll("tr.file-entry")[1]?.getAttribute("aria-selected")'),"true",
  "Second plain click should replace the first selection");
 await click("tr.file-entry .file-name",0,2);
 await until('(document.querySelector(".file-selected-count")?.textContent||"").includes("已选 2")');
 assert.equal(await selectedFiles(),2,"Ctrl-click must add an earlier file");
 await click("tr.file-entry .file-name",2,2);
 await until('(document.querySelector(".file-selected-count")?.textContent||"").includes("已选 3")');
 assert.equal(await selectedFiles(),3,"Ctrl-click should add a third file");
 assert(await evaluate('!document.querySelector("tr.file-entry input[type=checkbox]")'),
  "checkboxes must not exist before enabling the option");
 await click('button[aria-label="更多操作"]');
 await until('!!document.querySelector(\'[role="menu"][aria-label="更多操作"]\')');
 await click('[role="menu"][aria-label="更多操作"] [role="menuitem"]',0);
 await until('!!document.querySelector("tr.file-entry input[type=checkbox]")');
 await click('tr.file-entry .col-select input[type="checkbox"]',3);
 await until('(document.querySelector(".file-selected-count")?.textContent||"").includes("已选 4")');
 assert.equal(await selectedFiles(),4,"Checkbox should preserve three earlier selections");
 await click("tr.file-entry .file-name",1,2);
 await until('(document.querySelector(".file-selected-count")?.textContent||"").includes("已选 3")');
 await click(".batch-clear-selection");
 await until('!document.querySelector(".batch-actions-group")');
 await click('button[aria-label="更多操作"]');
 await until('!!document.querySelector(\'[role="menu"][aria-label="更多操作"]\')');
 await click('[role="menu"][aria-label="更多操作"] [role="menuitem"]',0);
 await until('!document.querySelector("tr.file-entry input[type=checkbox]")');
 console.log("EXPLORER_LIVE_MULTI_SELECT_PASS",JSON.stringify({count:4,plainSingle:true,ctrlClick:true,checkbox:true,toggleOff:true}));

 const path=await evaluate('location.pathname+location.search');
 await click('.folder-view-switch button[aria-label="图标视图"]');
 await until('document.querySelector(".work-body")?.dataset.explorerView==="icons"');
 const points=await evaluate(`(()=>{
  const grid=document.querySelector(".explorer-icon-grid"),surface=document.querySelector(".explorer-surface");
  const cards=[...grid.querySelectorAll(".explorer-item")];
  if(cards.length<2)return null;
  const g=grid.getBoundingClientRect(),a=cards[0].getBoundingClientRect(),b=cards[1].getBoundingClientRect();
  return {start:{x:g.left+3,y:g.top+3},end:{x:Math.max(a.right,b.right)-3,y:Math.max(a.bottom,b.bottom)-2}};
 })()`);
 assert(points,"Icon view must have at least two resources to marquee-select");
 await send("Input.dispatchMouseEvent",{type:"mouseMoved",...points.start});
 await send("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",clickCount:1,...points.start});
 for(let i=1;i<=8;i++){
  await send("Input.dispatchMouseEvent",{type:"mouseMoved",buttons:1,button:"left",
   x:points.start.x+(points.end.x-points.start.x)*i/8,
   y:points.start.y+(points.end.y-points.start.y)*i/8});
 }
 await until('!!document.querySelector(".explorer-marquee")');
 await send("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",clickCount:1,...points.end});
 await until('[...document.querySelectorAll(".explorer-item[aria-selected=true]")].length>=2');
 await until('!document.querySelector(".explorer-marquee")',"Marquee should disappear on release");
 console.log("EXPLORER_FINDER_MARQUEE_PASS");
 await click('.folder-view-switch button[aria-label="列表视图"]');
 await until('document.querySelector(".work-body")?.dataset.explorerView==="list"');

 // Exercise a real Ctrl+C -> directory navigation -> Ctrl+V round-trip.
 // The source is an existing small file; only the new duplicate is deleted.
 const clipboardFixture=await evaluate(`(async()=>{
  const tree=await(await fetch("/api/folders/tree")).json();
  const sourceFolder=new URLSearchParams(location.search).get("folder")||tree.data?.find(row=>!row.parentId)?.id;
  const source=await(await fetch("/api/files?"+new URLSearchParams({folder:sourceFolder,sort:"updated_desc",limit:"50"}))).json();
  const rows=source.data?.items||[];
  const file=rows.find(row=>row.sizeBytes<131072&&row.name.endsWith(".txt")&&
    !!document.querySelector('tr.file-entry[data-id="'+row.id+'"]'));
  const child=[...document.querySelectorAll(".explorer-list-folder")].map(row=>row.dataset.uploadFolderId)
   .find(id=>id&&id!==sourceFolder);
  return file&&child?{fileId:file.id,name:file.name,sha:file.sha256,target:child}:null;
 })()`);
 if(clipboardFixture){
  copyDestination=clipboardFixture.target;
  const current=await evaluate(`(async()=>{
   const r=await fetch("/api/files?"+new URLSearchParams({folder:${JSON.stringify(copyDestination)},sort:"updated_desc",limit:"50"}));
   const data=await r.json();return (data.data?.items||[]).map(file=>file.id);
  })()`);
  copyBeforeIds=current;
  await click('tr.file-entry[data-id="'+clipboardFixture.fileId+'"] .file-name');
  const shortcut=async(key,code)=>{
   await send("Input.dispatchKeyEvent",{type:"keyDown",modifiers:2,key,code});
   await send("Input.dispatchKeyEvent",{type:"keyUp",modifiers:2,key,code});
  };
  await shortcut("c","KeyC");
  const afterCopy=await evaluate('({toasts:[...document.querySelectorAll("[role=status],[role=alert]")].map(x=>x.textContent.slice(0,140)),selected:document.querySelector(".file-selected-count")?.textContent,active:document.activeElement?.tagName})');
  console.log("COPY_SHORTCUT_DEBUG",JSON.stringify(afterCopy));
  await navigate("/doc?folder="+encodeURIComponent(copyDestination),'!!document.querySelector(".folder-file-toolbar-host .file-toolbar")');
  await shortcut("v","KeyV");
  await delay(350);
  const afterPaste=await evaluate('({toasts:[...document.querySelectorAll("[role=status],[role=alert]")].map(x=>x.textContent.slice(0,140)),progress:document.querySelector(".file-paste-status")?.textContent,path:location.pathname+location.search,active:document.activeElement?.tagName})');
  console.log("PASTE_SHORTCUT_DEBUG",JSON.stringify(afterPaste));
  const newCopy=async()=>evaluate(`(async()=>{
   const r=await fetch("/api/files?"+new URLSearchParams({folder:${JSON.stringify(copyDestination)},sort:"updated_desc",limit:"50"}));
   const data=await r.json();return (data.data?.items||[]).find(row=>!${JSON.stringify(copyBeforeIds)}.includes(row.id)&&row.sha256===${JSON.stringify(clipboardFixture.sha)})||null;
  })()`);
  for(let i=0;i<120;i++){const copy=await newCopy();if(copy){copiedTestId=copy.id;break;}await delay(150);}
  if(!copiedTestId){
   const diagnostic=await evaluate(`(async()=>{
    const r=await fetch("/api/files?"+new URLSearchParams({folder:${JSON.stringify(copyDestination)},sort:"updated_desc",limit:"50"}));
    const body=await r.json();
    return {items:(body.data?.items||[]).map(item=>({id:item.id,name:item.name,sha:item.sha256})).slice(0,10),
     toasts:[...document.querySelectorAll("[role=alert],[role=status]")].map(x=>x.textContent.slice(0,130)),
     progress:document.querySelector(".file-paste-status")?.textContent};
   })()`);
   console.log("PASTE_FAILURE_DIAGNOSTIC",JSON.stringify(diagnostic));
  }
  assert(copiedTestId,"Ctrl+V must persist a new content-identical file in the destination directory");
  const copy=await newCopy();
  assert(copy.name.includes("副本")||copy.name===clipboardFixture.name,"Pasted file must keep original name or use a safe copy suffix");
  await until('!document.querySelector(".file-paste-status")',"Paste operation finished");
  console.log("EXPLORER_LIVE_COPY_PASTE_PASS",JSON.stringify({source:clipboardFixture.fileId,destination:copyDestination,copied:copiedTestId,hashMatches:true}));
  const cleanup=await evaluate(`(async()=>{
   const response=await fetch("/api/files/"+${JSON.stringify(copiedTestId)},{method:"DELETE"});
   return response.ok;
  })()`);
  assert(cleanup,"Temporary copied file must be cleaned up");
  copiedTestId=null;
  await navigate(path,'!!document.querySelector("tr.file-entry")');
 }

 const initial=await favoriteRead();
 assert(initial.ok&&Array.isArray(initial.rows),"Real favorites GET must succeed");
 const target=await evaluate('(()=>{const row=document.querySelector("tr.file-entry");return row?{id:row.dataset.id,name:row.querySelector(".file-name")?.textContent}:null;})()');
 assert(target?.id,"Missing real file for favorite test");
 tested=target.id;
 originalFavorite=initial.rows.some(row=>row.kind==="file"&&row.fileId===tested);
 await until('!!document.querySelector("tr.file-entry .action-star-btn:not(:disabled)")',
  "Favorite control must finish loading after cross-directory navigation");
 await click("tr.file-entry .action-star-btn",0);
 const expected=!originalFavorite;
 await until(`document.querySelector("tr.file-entry .action-star-btn")?.classList.contains("favorited")===${expected}`,"favorite feedback");
 for(let i=0;i<50;i++){
  const saved=await favoriteRead();
  if(saved.ok&&saved.rows.some(row=>row.kind==="file"&&row.fileId===tested)===expected)break;
  await delay(130);
 }
 const persisted=await favoriteRead();
 assert.equal(persisted.rows.some(row=>row.kind==="file"&&row.fileId===tested),expected,"Server favorite must persist after click");
 await navigate(path,'!!document.querySelector("tr.file-entry .action-star-btn")');
 await until(`document.querySelector("tr.file-entry .action-star-btn")?.classList.contains("favorited")===${expected}`,"favorite after reload");
 console.log("EXPLORER_LIVE_FAVORITE_PERSIST_PASS",JSON.stringify({id:tested,changed:true,afterReload:true}));

 // Verify the same file's actual Finder icon star hit target, not only its
 // list-row star. Clicking this second star restores the original state.
 await click('.folder-view-switch button[aria-label="图标视图"]');
 await until('document.querySelector(".work-body")?.dataset.explorerView==="icons"');
 const fileIconStar='.explorer-icon-grid [data-id="'+tested+'"] .explorer-item-star';
 await until(`!!document.querySelector(${JSON.stringify(fileIconStar)}+":not(:disabled)")`,"icon file star");
 await click(fileIconStar);
 await until(`document.querySelector(${JSON.stringify(fileIconStar)})?.classList.contains("favorited")===${originalFavorite}`,"icon file favorite feedback");
 for(let i=0;i<50;i++){
  const read=await favoriteRead();
  if(read.ok&&read.rows.some(row=>row.kind==="file"&&row.fileId===tested)===originalFavorite)break;
  await delay(130);
 }
 const iconFileFavorites=await favoriteRead();
 assert.equal(iconFileFavorites.rows.some(row=>row.kind==="file"&&row.fileId===tested),originalFavorite,
  "File icon star must persist its favorite change");
 console.log("EXPLORER_ICON_FILE_FAVORITE_PASS",JSON.stringify({id:tested,persisted:true}));

 // The user-facing Finder cards also have folder stars. Confirm native mouse
 // clicks toggle one actual folder, survive navigation, and are restored.
 await navigate("/doc",'!!document.querySelector(".folder-view-switch")');
 await click('.folder-view-switch button[aria-label="图标视图"]');
 await until('!!document.querySelector(".explorer-icon-grid .explorer-folder[data-folder-id] .explorer-item-star")',
  "root folder star");
 const folderId=await evaluate('document.querySelector(".explorer-icon-grid .explorer-folder[data-folder-id]")?.getAttribute("data-folder-id")');
 assert(folderId,"Folder favorite fixture must have a real server id");
 const folderInitial=await favoriteRead();
 assert(folderInitial.ok&&Array.isArray(folderInitial.rows),"Initial folder favorites must load");
 testedFolder=folderId;
 originalFolderFavorite=folderInitial.rows.some(row=>row.kind==="folder"&&row.folderId===testedFolder);
 const folderStar='.explorer-icon-grid .explorer-folder[data-folder-id="'+testedFolder+'"] .explorer-item-star';
 await click(folderStar);
 const folderExpected=!originalFolderFavorite;
 await until(`document.querySelector(${JSON.stringify(folderStar)})?.classList.contains("favorited")===${folderExpected}`,"folder star feedback");
 for(let i=0;i<50;i++){
  const read=await favoriteRead();
  if(read.ok&&read.rows.some(row=>row.kind==="folder"&&row.folderId===testedFolder)===folderExpected)break;
  await delay(130);
 }
 const savedFolder=await favoriteRead();
 assert.equal(savedFolder.rows.some(row=>row.kind==="folder"&&row.folderId===testedFolder),folderExpected,
  "Folder icon star must persist its favorite change");
 await navigate("/doc",'!!document.querySelector(".folder-view-switch")');
 await click('.folder-view-switch button[aria-label="图标视图"]');
 await until(`document.querySelector(${JSON.stringify(folderStar)})?.classList.contains("favorited")===${folderExpected}`,
  "folder star after reload");
 console.log("EXPLORER_ICON_FOLDER_FAVORITE_PASS",JSON.stringify({id:testedFolder,persisted:true,afterReload:true}));
}catch(error){
 console.error("EXPLORER_LIVE_INTERACTION_FAIL",error?.stack||error);
 process.exitCode=1;
}finally{
 if(copiedTestId&&ws?.readyState===WebSocket.OPEN){
  try{
   await evaluate(`(async()=>{await fetch("/api/files/"+${JSON.stringify(copiedTestId)},{method:"DELETE"});return true})()`);
  }catch(error){console.error("COPY_FIXTURE_RESTORE_FAILED",error?.message);process.exitCode=1;}
 }
 if(tested&&ws?.readyState===WebSocket.OPEN){
  try{
   const result=await evaluate(`(async()=>{
    const response=await fetch("/api/favorites/file/"+${JSON.stringify(tested)},{method:${JSON.stringify(originalFavorite?"PUT":"DELETE")}});
    const read=await fetch("/api/favorites",{cache:"no-store"});
    const json=await read.json();
    return {write:response.ok,verified:json.ok&&json.data.some(row=>row.kind==="file"&&row.fileId===${JSON.stringify(tested)})===${originalFavorite}};
   })()`);
   if(!result.write||!result.verified){console.error("FAVORITE_RESTORE_FAILED");process.exitCode=1;}
  }catch(error){console.error("FAVORITE_RESTORE_FAILED",error?.message);process.exitCode=1;}
 }
 if(testedFolder&&ws?.readyState===WebSocket.OPEN){
  try{
   const result=await evaluate(`(async()=>{
    const response=await fetch("/api/favorites/folder/"+${JSON.stringify(testedFolder)},{method:${JSON.stringify(originalFolderFavorite?"PUT":"DELETE")}});
    const read=await fetch("/api/favorites",{cache:"no-store"});
    const json=await read.json();
    return {write:response.ok,verified:json.ok&&json.data.some(row=>row.kind==="folder"&&row.folderId===${JSON.stringify(testedFolder)})===${originalFolderFavorite}};
   })()`);
   if(!result.write||!result.verified){console.error("FOLDER_FAVORITE_RESTORE_FAILED");process.exitCode=1;}
  }catch(error){console.error("FOLDER_FAVORITE_RESTORE_FAILED",error?.message);process.exitCode=1;}
 }
 ws?.close();chrome.kill("SIGTERM");await delay(200);
 rmSync(profile,{recursive:true,force:true});
}
