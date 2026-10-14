#!/usr/bin/env node
// Development-only authenticated Chrome check of actual pointer events and
// favorite persistence. It restores a tested favorite to its initial state.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {readFileSync,rmSync} from "node:fs";

const origin="http://127.0.0.1:18091";
const profile="/tmp/fm-explorer-real-"+process.pid;
const chrome=spawn("/usr/bin/google-chrome",[
 "--headless=new","--no-sandbox",...(process.env.FINDER_GPU_CHECK==="1"?[]:["--disable-gpu"]),"--disable-dev-shm-usage",
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
// DOM hit-testing cannot detect GPU raster blanking. Examine captured pixels
// in the brand and navigation rail, while the page is actually composited.
async function sidebarRaster(){
 const result=await send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
 const imageUrl="data:image/png;base64,"+result.data;
 return evaluate(`(async()=>{
  const picture=new Image();
  picture.src=${JSON.stringify(imageUrl)};
  await picture.decode();
  const canvas=document.createElement('canvas');
  canvas.width=picture.naturalWidth;canvas.height=picture.naturalHeight;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(picture,0,0);
  const width=Math.min(canvas.width,230),height=Math.min(canvas.height,350);
  const pixels=ctx.getImageData(0,0,width,height).data;
  let dark=0,samples=0;
  for(let y=65;y<Math.min(height,310);y+=2){
   for(let x=12;x<Math.min(width,205);x+=2){
    const offset=(y*width+x)*4;
    if(pixels[offset+3]<200)continue;
    samples++;
    if(pixels[offset]<155&&pixels[offset+1]<175&&pixels[offset+2]<190)dark++;
   }
  }
  return {dark,samples,width,height};
 })()`);
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
   if(pass===0||pass===5||pass===11){
    const raster=await sidebarRaster();
    console.log("EXPLORER_SIDEBAR_RASTER",mode,pass,JSON.stringify(raster));
    assert(raster.dark>35,
     "Composited Finder navigation pixels disappeared despite live DOM: "+JSON.stringify(raster));
   }
  }
 }
 // Finder white slider needs dark hover text, and the work canvas must be the
 // only edge painter at the rounded sidebar/work seam.
 for(const width of [1920,1366,820]){
  await send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
  // Chrome preserves the pointer position across viewport emulation. Reset
  // the preceding iteration's hovered inactive nav item before idle sampling.
  await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:Math.max(10,width-24),y:110});
  await delay(210);
  const result=await evaluate(`(()=>{
   const nav=document.querySelector('.header nav[data-slot="gooey-nav"][data-appearance="pill"]');
   const active=nav?.querySelector('[data-slot="gooey-nav-item"][data-active="true"]');
   const inactive=nav?.querySelector('[data-slot="gooey-nav-item"][data-active="false"]');
   const pane=document.querySelector('.panels.document-explorer');
   const side=pane?.querySelector('.finder-sidebar'),work=pane?.querySelector('.work');
   const handle=side?.querySelector('.sidebar-resizer'),bar=work?.querySelector('.folder-context-bar');
   const style=e=>e&&getComputedStyle(e),box=e=>e?.getBoundingClientRect();
   const token=document.createElement('span');token.style.color='var(--text-primary)';document.body.appendChild(token);
   const primary=style(token).color;token.style.color='var(--text-secondary)';
   const secondary=style(token).color;token.remove();
   const borders=e=>['Top','Right','Bottom','Left'].map(part=>style(e)?.['border'+part+'Width']);
   const r=box(active),n=box(inactive);
   return {primary,secondary,activeColor:style(active)?.color,inactiveColor:style(inactive)?.color,
    active:r&&{x:r.x+r.width/2,y:r.y+r.height/2},
    inactive:n&&{x:n.x+n.width/2,y:n.y+n.height/2},
    panelBorders:borders(pane),sideBorders:borders(side),workBorders:borders(work),
    sideRadius:style(side)?.borderTopRightRadius,sideShadow:style(side)?.boxShadow,
    workRadius:style(work)?.borderTopLeftRadius,workOverflow:style(work)?.overflow,
    handleTop:box(handle)?.top-box(work)?.top,handleBorders:borders(handle),
    handleBackground:style(handle)?.backgroundColor,
    toolbarTop:style(bar)?.borderTopWidth,toolbarLeft:style(bar)?.borderLeftWidth,
    toolbarRadius:style(bar)?.borderTopLeftRadius};
  })()`);
  assert(result.active&&result.inactive&&result.activeColor===result.primary&&
   result.inactiveColor===result.secondary&&result.panelBorders.every(v=>v==="0px")&&
   result.sideBorders.every(v=>v==="0px")&&result.sideRadius==="0px"&&result.sideShadow==="none"&&
   JSON.stringify(result.workBorders)===JSON.stringify(["1px","0px","0px","1px"])&&
   result.workRadius==="10px"&&result.workOverflow==="hidden"&&
   Math.abs(result.handleTop-10)<1&&result.handleBorders.every(v=>v==="0px")&&
   result.toolbarTop==="0px"&&result.toolbarLeft==="0px"&&result.toolbarRadius==="0px",
   "Finder seam or idle navigation regression "+width+": "+JSON.stringify(result));
  await send("Input.dispatchMouseEvent",{type:"mouseMoved",...result.active});
  await delay(210);
  const selectedHover=await evaluate(`getComputedStyle(document.querySelector('.header nav[data-slot="gooey-nav"][data-appearance="pill"] [data-slot="gooey-nav-item"][data-active="true"]')).color`);
  assert(selectedHover===result.primary,"Active white pill turns white on hover "+width+": "+JSON.stringify({selectedHover,result}));
  await send("Input.dispatchMouseEvent",{type:"mouseMoved",...result.inactive});
  await delay(210);
  const otherHover=await evaluate(`getComputedStyle(document.querySelector('.header nav[data-slot="gooey-nav"][data-appearance="pill"] [data-slot="gooey-nav-item"][data-active="false"]')).color`);
  assert(otherHover===result.primary,"Inactive pill hover not dark "+width+": "+JSON.stringify({otherHover,result}));
  console.log("FINDER_NAV_HOVER_AND_SEAM_PASS",width,JSON.stringify(result));
 }
 // View switching is pure content navigation: toolbar buttons and their
 // painted positions must remain exactly fixed through all four layouts.
 for(const width of [1920,1366,820]){
  await send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
  await delay(130);
  const dock=await evaluate(`(()=>{
   const select=selector=>document.querySelector(selector);
   const rect=selector=>select(selector)?.getBoundingClientRect();
   const style=selector=>{const e=select(selector);return e?getComputedStyle(e):null};
   const shell=rect('.shell.shell-finder'),panels=rect('.shell.shell-finder>.panels.document-explorer'),
    work=rect('.document-explorer>.work'),header=rect('.shell.shell-finder>.header'),
    bar=rect('.document-explorer .folder-context-bar'),
    account=rect('.global-utility-dock .account-trigger'),
    avatar=rect('.global-utility-dock .account-avatar'),
    avatarGlyph=rect('.global-utility-dock .account-avatar svg'),
    bell=rect('.global-utility-dock .rare-notification-bell'),
    bellGlyph=rect('.global-utility-dock .rare-notification-bell svg'),
    command=rect('.global-utility-dock .command-trigger'),
    commandGlyph=rect('.global-utility-dock .command-trigger svg'),
    more=rect('.document-explorer .folder-context-bar button[aria-label="更多操作"]');
   return {viewport:window.innerWidth,
    shellRight:shell?.right,panelsRight:panels?.right,workRight:work?.right,
    headerRight:header?.right,barRight:bar?.right,
    accountRight:account?.right,moreRight:more?.right,
    accountHeight:account?.height,commandHeight:command?.height,
    commandWidth:command?.width,bellHeight:bell?.height,bellWidth:bell?.width,
    avatarWidth:avatar?.width,avatarHeight:avatar?.height,
    avatarRadius:style('.global-utility-dock .account-avatar')?.borderRadius,
    avatarGlyph:avatarGlyph?.width,bellGlyph:bellGlyph?.width,commandGlyph:commandGlyph?.width,
    commandLabel:select('.global-utility-dock .command-keys')?.textContent?.trim(),
    accountFont:style('.global-utility-dock .account-name')?.fontSize,
    dockHeight:rect('.global-utility-dock')?.height,
    workBorder:style('.document-explorer>.work')?.borderRightWidth,
    panelsBorder:style('.panels.document-explorer')?.borderRightWidth,
    shellPadding:style('.shell.shell-finder')?.paddingRight,
    scrollbarOverflow:document.documentElement.scrollWidth>window.innerWidth+1};
  })()`);
  assert(dock.avatarWidth===22&&dock.avatarHeight===22&&dock.avatarRadius==="50%"&&dock.avatarGlyph===13&&
   dock.commandHeight===30&&dock.bellHeight===30&&dock.accountHeight===30&&dock.dockHeight===30&&
   dock.bellWidth===30&&dock.bellGlyph===15&&dock.commandGlyph===14&&dock.commandLabel==="⌘K"&&
   dock.accountFont==="12.5px"&&dock.commandWidth>30,
   "Finder global utility geometry at "+width+": "+JSON.stringify(dock));
  assert(Math.abs(dock.accountRight-dock.moreRight)<=.5&&
   Math.abs(dock.workRight-dock.viewport)<=.5&&
   Math.abs(dock.panelsRight-dock.viewport)<=.5&&
   Math.abs(dock.headerRight-dock.viewport)<=.5&&
   dock.shellPadding==="0px"&&dock.workBorder==="0px"&&dock.panelsBorder==="0px"&&
   !dock.scrollbarOverflow,
   "Finder header/footer right reference line or canvas seam at "+width+": "+JSON.stringify(dock));
  console.log("FINDER_GLOBAL_DOCK_PIXEL_PASS",width,JSON.stringify(dock));
  let baseline=null;
  for(const [mode,label] of [["icons","图标视图"],["list","列表视图"],["columns","分栏视图"],["gallery","画廊视图"]]){
   await evaluate(`(()=>document.querySelector('.folder-view-switch button[aria-label="${label}"]')?.click())()`);
   await until(`document.querySelector('.work-body')?.dataset.explorerView==="${mode}"`);
   await delay(125);
   const geometry=await evaluate(`(()=>{
    const bar=document.querySelector('.folder-context-bar');
    const paths=['.upload-button','.new-folder-wrapper','.folder-view-switch',
     'button[aria-label="排序方式"]','button[aria-label="文件类型筛选"]',
     '.filter-search-input','button[aria-label="更多操作"]'];
    const shapes=paths.map(selector=>{
     const e=bar?.querySelector(selector),r=e?.getBoundingClientRect();
     return {selector,x:r?.left??null,y:r?.top??null,w:r?.width??null,h:r?.height??null};
    });
    const active=bar?.querySelector('.folder-view-switch button[aria-pressed="true"]');
    return {shapes,sortCount:bar?.querySelectorAll('button[aria-label="排序方式"]').length,
     focusOutline:active?getComputedStyle(active).outlineStyle:null,
     scrollGutter:getComputedStyle(document.querySelector('.explorer-surface')||document.querySelector('.explorer-striped-list')).scrollbarGutter};
   })()`);
   assert(geometry.sortCount===1&&geometry.shapes.every(shape=>shape.x!==null&&shape.h>0)&&
    geometry.focusOutline==="none"&&geometry.scrollGutter==="stable",
    "Finder toolbar button contract in "+mode+": "+JSON.stringify(geometry));
   if(!baseline)baseline=geometry.shapes;
   else assert(geometry.shapes.every((shape,i)=>Math.abs(shape.x-baseline[i].x)<=.5&&Math.abs(shape.y-baseline[i].y)<=.5),
    "Finder toolbar shifted at "+width+" "+mode+": "+JSON.stringify({baseline,current:geometry.shapes}));
   console.log("FINDER_FOUR_VIEW_TOOLBAR",width,mode,JSON.stringify(geometry));
   if(mode==="icons"){
    const gridArt=await evaluate(`(()=>{
     const folders=[...document.querySelectorAll('.explorer-icon-grid .explorer-folder')];
     const folder=folders[0],art=folder?.querySelector('.explorer-item-art');
     const star=folder?.querySelector('.explorer-item-star');
     const picture=folder?.querySelector('[data-slot="rare-folder-component"][data-folder-scale="large"]');
     const artBox=art?.getBoundingClientRect(),starBox=star?.getBoundingClientRect();
     const firstOther=folders.find(row=>row!==folder&&row.getBoundingClientRect().top===folder.getBoundingClientRect().top);
     return {largeRareFolder:!!picture,papers:picture?.querySelectorAll('.rare-folder-card').length??0,
      starAgainstArt:!!artBox&&!!starBox&&Math.abs(starBox.right-artBox.right)<=5&&Math.abs(starBox.top-artBox.top)<=5,
      artworkRowAligned:!firstOther||Math.abs(artBox.top-firstOther.querySelector('.explorer-item-art').getBoundingClientRect().top)<=1,
      fixedMeta:!!folder?.querySelector('.explorer-item-meta')&&
       getComputedStyle(folder.querySelector('.explorer-item-meta')).height==='15px'};
    })()`);
    assert(gridArt.largeRareFolder&&gridArt.papers===3&&gridArt.starAgainstArt&&
     gridArt.artworkRowAligned&&gridArt.fixedMeta,
     "Rare Folder grid artwork/stars/metadata alignment at "+width+": "+JSON.stringify(gridArt));
    console.log("FINDER_ICON_GRID_RARE_PASS",width,JSON.stringify(gridArt));
    // Inspect actual hovered/selected tile geometry: menus must occupy only
    // the artwork band, never the filename, version text, or Finder tag dots.
    for(const selector of [".explorer-icon-grid .explorer-folder",".explorer-icon-grid .file-entry"]){
     const anchor=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});
      const r=e?.getBoundingClientRect();return r?{x:r.left+r.width/2,y:r.top+20}:null})()`);
     if(!anchor)continue;
     await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:anchor.x,y:anchor.y});
     await delay(95);
     const collision=await evaluate(`(()=>{
      const e=document.querySelector(${JSON.stringify(selector)});
      const rect=node=>node?.getBoundingClientRect();
      const more=e?.querySelector('.explorer-item-more'),star=e?.querySelector('.explorer-item-star'),
       svg=more?.querySelector('svg'),art=e?.querySelector('.explorer-item-art'),
       name=e?.querySelector('.explorer-item-name'),meta=e?.querySelector('.explorer-item-meta');
      const m=rect(more),s=rect(star),v=rect(svg),a=rect(art),n=rect(name),t=rect(meta),card=rect(e);
      const isOverlap=(x,y)=>!!x&&!!y&&x.width>0&&y.width>0&&
       x.left<y.right-.4&&y.left<x.right-.4&&x.top<y.bottom-.4&&y.top<x.bottom-.4;
      const marks=[...e.querySelectorAll('.explorer-item-meta .file-finder-mark')];
      const markDimensions=marks.map(node=>({height:rect(node).height,width:rect(node).width,
       center:(rect(node).top+rect(node).bottom)/2}));
      const baseline=rect(e.querySelector('.explorer-item-sub'));
      const controls={menu:more&&getComputedStyle(more),star:star&&getComputedStyle(star)};
      const oldSelected=e.classList.contains('selected');
      e.classList.add('selected');
      const selectedOverlap=isOverlap(rect(more),rect(meta))||isOverlap(rect(more),rect(name));
      if(!oldSelected)e.classList.remove('selected');
      return {exists:!!m&&!!s&&!!a,hovered:e.matches(':hover'),
       menuPosition:controls.menu?.position,menuBottom:controls.menu?.bottom,
       menuTop:m&&card?m.top-card.top:null,menuRight:m&&card?card.right-m.right:null,
       menuWidth:m?.width,menuHeight:m?.height,svgWidth:v?.width,svgHeight:v?.height,
       svgCenterDelta:v&&m?Math.max(Math.abs((v.left+v.right-m.left-m.right)/2),
         Math.abs((v.top+v.bottom-m.top-m.bottom)/2)):null,
       iconCentres:svg?[...svg.querySelectorAll('circle')].map(c=>c.getAttribute('cy')):[],
       menuOpacity:controls.menu?.opacity,starOverlap:isOverlap(m,s),
       metaOverlap:isOverlap(m,t),nameOverlap:isOverlap(m,n),
       markOverlap:marks.some(mark=>isOverlap(m,rect(mark))),
       selectedOverlap,metaGap:meta&&name?t.top-n.bottom:null,
       markDimensions,textBaselineCenter:baseline?(baseline.top+baseline.bottom)/2:null,
       metaAlign:meta?getComputedStyle(meta).alignItems:null,
       metaGapStyle:meta?getComputedStyle(meta).columnGap:null};
     })()`);
     assert(collision.exists&&collision.hovered&&collision.menuPosition==="absolute"&&
      Math.abs(collision.menuTop-6)<=1&&Math.abs(collision.menuRight-6)<=1&&
      collision.menuWidth===22&&collision.menuHeight===22&&collision.svgWidth===14&&
      collision.svgHeight===14&&collision.svgCenterDelta<=.5&&
      collision.iconCentres.join(",")==="12,12,12"&&
      !collision.starOverlap&&!collision.metaOverlap&&!collision.nameOverlap&&
      !collision.markOverlap&&!collision.selectedOverlap&&collision.metaAlign==="center"&&
      collision.metaGapStyle==="5px"&&
      collision.markDimensions.every(mark=>mark.width===7&&mark.height===7&&
       (!collision.textBaselineCenter||Math.abs(mark.center-collision.textBaselineCenter)<2)),
      "Finder visual item hover collides with badges/text at "+width+" "+selector+": "+JSON.stringify(collision));
     console.log("FINDER_ICON_HOVER_ACTIONS_PASS",width,selector,JSON.stringify(collision));
    }
   }
   if(mode==="gallery"){
    const gallery=await evaluate(`(()=>{
     const item=document.querySelector('.explorer-gallery-strip .explorer-item');
     if(!item)return null;
     const more=item.querySelector('.explorer-item-more'),star=item.querySelector('.explorer-item-star');
     const m=more?.getBoundingClientRect(),s=star?.getBoundingClientRect();
     return {svg:!!more?.querySelector('svg circle'),moreTop:getComputedStyle(more).top,
      starRight:getComputedStyle(star).right,
      overlap:!!m&&!!s&&m.left<s.right-.5&&s.left<m.right-.5&&m.top<s.bottom-.5&&s.top<m.bottom-.5};
    })()`);
    assert(gallery&&!gallery.overlap&&gallery.svg&&gallery.moreTop==="6px",
     "Gallery toolbar regression after moving Finder icon actions: "+JSON.stringify(gallery));
    console.log("FINDER_GALLERY_MORE_ACTIONS_PASS",width,JSON.stringify(gallery));
   }
   if(mode==="columns"){
    const point=await evaluate(`(()=>{
     const row=document.querySelector('.explorer-current-column .explorer-folder');
     const box=row?.getBoundingClientRect();
     return box?{x:box.x+Math.max(30,box.width/2),y:box.y+box.height/2}:null;
    })()`);
    if(point){
     await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:point.x,y:point.y});
     await delay(115);
     const collision=await evaluate(`(()=>{
      const row=document.querySelector('.explorer-current-column .explorer-folder');
      if(!row)return null;
      const nodes=['.explorer-item-name','.explorer-item-meta','.explorer-item-star','.explorer-item-more']
       .map(sel=>row.querySelector(sel));
      const bounds=nodes.map(n=>n?.getBoundingClientRect());
      const intersects=(a,b)=>!!a&&!!b&&a.width>0&&b.width>0&&a.left<b.right-.5&&b.left<a.right-.5;
      return {overlap:bounds.some((r,i)=>bounds.slice(i+1).some(s=>intersects(r,s))),
       positions:bounds.map(r=>r&&{left:r.left,right:r.right}),
       chevronOpacity:getComputedStyle(row,'::after').opacity,
       filler:!!document.querySelector('.explorer-column-filler'),
       actionPositions:getComputedStyle(nodes[2]).position+','+getComputedStyle(nodes[3]).position};
     })()`);
     assert(collision&&!collision.overlap&&collision.chevronOpacity==="0"&&collision.filler&&
      collision.actionPositions==="relative,relative",
      "Finder column hover collision at "+width+": "+JSON.stringify(collision));
     console.log("FINDER_COLUMN_HOVER_PASS",width,JSON.stringify(collision));
    }
   }
  }
 }
 // Resolution-independent Finder geometry. Validate paint boxes rather than
 // merely checking computed CSS: sidebars may be resized, and cqw != vw.
 for(const width of [780,980,1280,1440,1920,2560,3840]){
  await send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
  for(const [mode,label] of [["list","列表视图"],["icons","图标视图"],["columns","分栏视图"]]){
   await evaluate('document.querySelector('+JSON.stringify('.folder-view-switch button[aria-label="'+label+'"]')+')?.click()');
   await until('document.querySelector(".work-body")?.dataset.explorerView==='+JSON.stringify(mode));
   const dimensions=await evaluate(`(()=>{
    const rect=e=>e?.getBoundingClientRect(),css=(e,pseudo)=>e&&getComputedStyle(e,pseudo);
    const work=document.querySelector('.work-body'),surface=document.querySelector('.explorer-surface');
    if(document.querySelector('.work-body')?.dataset.explorerView==='list'){
     const header=document.querySelector('table.file-table thead'),table=header?.closest('table');
     const widths={};
     for(const key of ['select','size','version','date','actions']){
      const cell=header?.querySelector('th.col-'+key);
      widths[key]=cell?rect(cell)?.width:null;
     }
     return {mode:'list',widths,nameWidth:rect(header?.querySelector('th.col-name'))?.width,tableWidth:rect(table)?.width,
      canvasWidth:rect(work)?.width};
    }
    if(document.querySelector('.work-body')?.dataset.explorerView==='icons'){
     const grid=document.querySelector('.explorer-icon-grid'),cards=[...grid.querySelectorAll(':scope>.explorer-item')];
     const top=rect(cards[0])?.top,firstRow=cards.filter(card=>Math.abs(rect(card).top-top)<1);
     const last=firstRow.at(-1),a=rect(firstRow[0]),b=rect(last),g=rect(grid);
     const selected=cards.find(card=>card.querySelector('.file-finder-marks'));
     const title=rect(selected?.querySelector('.explorer-item-name')),tags=rect(selected?.querySelector('.explorer-item-meta'));
     const star=rect(cards.find(card=>card.classList.contains('file-entry'))?.querySelector('.explorer-item-star'));
     const art=rect(cards.find(card=>card.classList.contains('file-entry'))?.querySelector('.explorer-item-art'));
     const tracks=css(grid).gridTemplateColumns.split(' ').filter(Boolean);
     return {mode:'icons',gridColumns:css(grid).gridTemplateColumns,firstRow:firstRow.length,
      tracks:tracks.length,paddedLeft:a.left-g.left,
      edgeDelta:firstRow.length===tracks.length?Math.abs((a.left-g.left)-(g.right-b.right)):null,
      tagsGap:tags&&title?tags.top-title.bottom:null,
      starWidth:star?.width,starInner:star&&art?star.right<art.right:null,
      artWidth:art?.width,overflow:grid.scrollWidth>grid.clientWidth+2};
    }
    const pane=document.querySelector('.explorer-surface-columns'),columns=document.querySelector('.explorer-columns');
    const col=columns?.querySelector('.explorer-column-list');
    const folder=columns?.querySelector('.explorer-current-column .explorer-folder');
    const file=columns?.querySelector('.explorer-current-column .file-entry');
    const starA=rect(folder?.querySelector('.explorer-item-star')),starB=rect(file?.querySelector('.explorer-item-star'));
    const colWidth=rect(col)?.width,paneWidth=pane?.clientWidth;
    return {mode:'columns',paneWidth,colWidth,
     numberOfTracks:css(columns).getPropertyValue('--finder-column-count').trim(),
     trackRemainder:colWidth?Math.min(paneWidth%colWidth,colWidth-(paneWidth%colWidth)):null,
     starsAligned:starA&&starB?Math.abs(starA.left-starB.left)<=.75:null,
     arrowSlots:!!folder&&!!file&&css(folder,'::after').width===css(file,'::after').width};
   })()`);
   if(mode==="list"&&width>=980){
    for(const [name,value] of [["size",96],["version",72],["date",148],["actions",56]]){
     assert(dimensions.widths[name]!==null&&Math.abs(dimensions.widths[name]-value)<=1,
      "File metadata grew with screen size "+width+": "+JSON.stringify(dimensions));
    }
    assert(dimensions.nameWidth>120);
   }
   if(mode==="icons"){
    assert(dimensions.firstRow>=1&&dimensions.paddedLeft>=19&&
     (dimensions.edgeDelta===null||dimensions.edgeDelta<=2)&&!dimensions.overflow,
     "Finder responsive grid edge imbalance "+width+": "+JSON.stringify(dimensions));
    if(dimensions.tagsGap!==null)assert(Math.abs(dimensions.tagsGap-4)<=1,
     "Finder one-line tags detached from name "+width+": "+JSON.stringify(dimensions));
    assert(dimensions.starWidth===18&&dimensions.starInner,
     "Finder favorite badge outside document artwork "+width+": "+JSON.stringify(dimensions));
   }
   if(mode==="columns"){
    assert(dimensions.colWidth>170&&dimensions.colWidth<=281&&
     dimensions.starsAligned!==false&&dimensions.arrowSlots,
     "Finder column star/track width diverged "+width+": "+JSON.stringify(dimensions));
    if(width>=980)assert(dimensions.trackRemainder<=20,
     "Finder trailing column track clipped "+width+": "+JSON.stringify(dimensions));
   }
   console.log("FINDER_RESOLUTION_GEOMETRY_PASS",width,mode,JSON.stringify(dimensions));
  }
 }
 await send("Emulation.clearDeviceMetricsOverride");
 // Sort is one shared state across all four views. Verify the actual row
 // order, not merely that the sort glyph remains mounted.
 await send("Emulation.setDeviceMetricsOverride",{width:1366,height:900,deviceScaleFactor:1,mobile:false});
 const sortOptions=[{index:1,label:"名称 A→Z"},{index:2,label:"名称 Z→A"},{index:3,label:"大小降序"}];
 for(const choice of sortOptions){
  await evaluate('document.querySelector(".folder-view-switch button[aria-label=列表视图]")?.click()');
  await until('document.querySelector(".work-body")?.dataset.explorerView==="list"');
  await click('button[aria-label="排序方式"]');
  await until('document.querySelectorAll("[role=menu] [role=menuitem]").length===4');
  await click('[role=menu] [role=menuitem]',choice.index);
  await delay(850);
  const expected=await evaluate('(()=>({folders:[...document.querySelectorAll(".explorer-striped-list tr.explorer-list-folder")].map(e=>e.dataset.uploadFolderId),files:[...document.querySelectorAll(".explorer-striped-list tr.file-entry")].map(e=>e.dataset.id),sort:document.querySelector("button[aria-label=排序方式]")?.title}))()');
  assert(expected.sort===choice.label&&expected.files.length>0,"Sorter not updated: "+JSON.stringify(expected));
  for(const [mode,label,container] of [["icons","图标视图",".explorer-icon-grid"],["columns","分栏视图",".explorer-current-column"],["gallery","画廊视图",".explorer-gallery-strip"]]){
   await evaluate('document.querySelector('+JSON.stringify('.folder-view-switch button[aria-label="'+label+'"]')+')?.click()');
   await until('document.querySelector(".work-body")?.dataset.explorerView==='+JSON.stringify(mode));
   const order=await evaluate('(()=>{const host=document.querySelector('+JSON.stringify(container)+');return {folders:[...host.querySelectorAll(".explorer-folder")].map(e=>e.dataset.folderId),files:[...host.querySelectorAll(".file-entry")].map(e=>e.dataset.id)}})()');
   assert.deepEqual(order,{folders:expected.folders,files:expected.files},
    "Sort differs between list and "+mode+" for "+choice.label+": "+JSON.stringify({expected,order}));
  }
  console.log("FINDER_CROSS_VIEW_SORT_PASS",choice.label,JSON.stringify({folders:expected.folders.length,files:expected.files.length}));
 }
 // Fixture-based density / zoom test: do not create real files in the LAN.
 // Clone layout-only tiles to expose wrapping and overlay errors at 300+ items.
 await evaluate('document.querySelector(".folder-view-switch button[aria-label=图标视图]")?.click()');
 await until('document.querySelector(".work-body")?.dataset.explorerView==="icons"');
 const highVolume=await evaluate('(()=>{const grid=document.querySelector(".explorer-icon-grid");const source=grid?.querySelector(".explorer-folder");if(!grid||!source)return null;const fragment=document.createDocumentFragment();for(let i=0;i<300;i++){const tile=source.cloneNode(true);tile.dataset.stressFixture=String(i);tile.removeAttribute("data-folder-id");tile.removeAttribute("data-upload-folder-id");const name=tile.querySelector(".explorer-item-name");if(name)name.textContent="长中文文件名和混合ASCII标识-"+i+"-校准项目-旅程目录-1791769428124";const meta=tile.querySelector(".explorer-item-meta");if(meta)meta.textContent="● ● +4";fragment.appendChild(tile);}grid.appendChild(fragment);const measurements=[];for(const zoom of [0.8,1,1.25,1.5]){document.documentElement.style.zoom=String(zoom);const tiles=[...grid.querySelectorAll(".explorer-item")];const art=tiles.slice(-10).map(e=>e.querySelector(".explorer-item-art")?.getBoundingClientRect());const cards=tiles.slice(-20).map(e=>e.getBoundingClientRect());const overlap=cards.some((a,i)=>cards.slice(i+1).some(b=>a.left<b.right-.5&&b.left<a.right-.5&&a.top<b.bottom-.5&&b.top<a.bottom-.5));measurements.push({zoom,tiles:tiles.length,overlap,artAligned:art.every(a=>!!a&&art.some(b=>Math.abs(a.top-b.top)<1)),scrollWidth:grid.scrollWidth,clientWidth:grid.clientWidth});}document.documentElement.style.zoom="";grid.querySelectorAll("[data-stress-fixture]").forEach(el=>el.remove());return measurements;})()');
 assert(highVolume&&highVolume.every(item=>item.tiles>=300&&!item.overlap&&item.scrollWidth<=item.clientWidth+2),
  "Large Finder icon-grid overflow/wrapping: "+JSON.stringify(highVolume));
 console.log("FINDER_GRID_300_ZOOM_PASS",JSON.stringify(highVolume));
 // Repeatedly enter different large folder icons while the compositor is
 // active. Hover animation must retain three paper cards and the rail must
 // remain visibly painted; no special animation is required for test clones.
 const iconPoints=await evaluate('(()=>[...document.querySelectorAll(".explorer-icon-grid .explorer-folder")].slice(0,12).map(el=>{const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}}))()');
 for(let cycle=0;cycle<3;cycle++){
  for(const point of iconPoints){
   await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:point.x,y:point.y});
   await delay(20);
  }
 }
 await delay(180);
 const hoverRender=await evaluate('(()=>{const folders=[...document.querySelectorAll(".explorer-icon-grid .explorer-folder")];return {folders:folders.length,allPapers:folders.every(row=>row.querySelectorAll(".rare-folder-card").length===3),active:folders.filter(row=>row.querySelector("[data-folder-open=true]")).length,blank:document.querySelector(".finder-navigation")?.getBoundingClientRect().height<100}})()');
 const rasterAfterHover=await sidebarRaster();
 assert(hoverRender.allPapers&&!hoverRender.blank&&rasterAfterHover.dark>35,
  "Rapid folder-hover composite regression: "+JSON.stringify({hoverRender,rasterAfterHover}));
 console.log("FINDER_RARE_HOVER_STRESS_PASS",JSON.stringify({hoverRender,rasterAfterHover}));
 // Navigate into an actual subdirectory without mutating server data.
 // Ancestor columns must receive the same sort state and never append a page
 // from the previous sort generation.
 const depthFolder=await evaluate('document.querySelector(".explorer-icon-grid .explorer-folder")?.dataset.folderId');
 if(depthFolder){
  await evaluate('document.querySelector(".explorer-icon-grid .explorer-folder")?.dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');
  await until('location.search.includes("folder=")');
  await evaluate('document.querySelector(".folder-view-switch button[aria-label=分栏视图]")?.click()');
  await until('document.querySelector(".work-body")?.dataset.explorerView==="columns"');
  await until('document.querySelectorAll(".finder-path-list").length>0');
  await click('button[aria-label="排序方式"]');
  await until('document.querySelectorAll("[role=menu] [role=menuitem]").length===4');
  await click('[role=menu] [role=menuitem]',1);
  await until('document.querySelector(".finder-path-list")?.dataset.sort==="name_asc"');
  await delay(400);
  const ancestor=await evaluate('(()=>{const col=document.querySelector(".finder-path-list");return {sort:col?.dataset.sort,folderRows:col?.querySelectorAll(".finder-folder-row").length,fileRows:col?.querySelectorAll(".finder-file-row").length,scrollable:!!col&&getComputedStyle(col).overflowY==="auto",toolbar:document.querySelector("button[aria-label=排序方式]")?.title}})()');
  assert(ancestor.sort==="name_asc"&&ancestor.scrollable&&ancestor.toolbar==="名称 A→Z",
   "Ancestor Finder column must follow the active sort: "+JSON.stringify(ancestor));
  console.log("FINDER_DEEP_COLUMN_SORT_PASS",JSON.stringify(ancestor));
  await navigate("/doc",'!!document.querySelector(".folder-view-switch")');
 }
 // Restore the initial sort for the remaining clipboard/selection tests.
 await evaluate('document.querySelector(".folder-view-switch button[aria-label=列表视图]")?.click()');
 await until('document.querySelector(".work-body")?.dataset.explorerView==="list"');
 await until('document.querySelectorAll("tr.file-entry,.explorer-list-folder").length>0');
 await click('button[aria-label="排序方式"]');
 await until('document.querySelectorAll("[role=menu] [role=menuitem]").length===4');
 await click('[role=menu] [role=menuitem]',0);
 await delay(600);
 await evaluate(`(()=>document.querySelector('.folder-view-switch button[aria-label="列表视图"]')?.click())()`);
 await until('document.querySelector(".work-body")?.dataset.explorerView==="list"');
 await send("Emulation.clearDeviceMetricsOverride");
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
   const listScrollPort=document.querySelector('.work-body>.explorer-striped-list');
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
    tableFills:!!table&&!!list&&!!listScrollPort&&table.width>=listScrollPort.clientWidth-20&&
     table.right>=list.left+listScrollPort.clientWidth-10&&table.right<=list.right+1,
    tableMetrics:table&&list&&listScrollPort?{width:table.width,right:table.right,listWidth:list.width,
     listRight:list.right,listLeft:list.left,clientWidth:listScrollPort.clientWidth,
     computedGutter:getComputedStyle(listScrollPort).scrollbarGutter}:null,
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
