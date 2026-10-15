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
 await cdp.send("Page.navigate",{url:BASE+"/preview/"+encodeURIComponent(pdf.id)});
 const previewReady=await cdp.waitFor(`()=>!!document.querySelector('.file-pdf-viewer .file-pdf-image')&&
  !!document.querySelector('.file-workbench-nav-item')`,16000);
 assert("regular PDF preview opens with visible document",Boolean(previewReady));
 // Preview header collapses in normal flow, then pushes the workbench down.
 const initiallyHidden=await cdp.evaluate(`(()=>{
  const h=document.querySelector('.shell-preview-autoheader>.header');
  const shell=document.querySelector('.shell');
  const work=document.querySelector('.work');
  if(!h||!shell||!work)return null;
  const style=getComputedStyle(h);
  const rect=work.getBoundingClientRect(),parent=shell.getBoundingClientRect();
  return {hidden:style.visibility==='hidden',headerHeight:h.getBoundingClientRect().height,
   workOffset:Math.round(rect.top-parent.top),trigger:!!document.querySelector('.preview-header-reveal')};
 })()`);
 assert("preview initially hides system menu without reserving its height",
  !!initiallyHidden&&initiallyHidden.hidden&&initiallyHidden.trigger&&initiallyHidden.headerHeight<=1&&initiallyHidden.workOffset<24,
  JSON.stringify(initiallyHidden));
 const identityGeometry=await cdp.evaluate(`(()=>{
  const card=document.querySelector('.file-preview-identity');
  const back=card?.querySelector('.file-back')?.getBoundingClientRect();
  const svg=card?.querySelector('.file-back svg')?.getBoundingClientRect();
 const heading=card?.querySelector('h1');
 const title=heading?.getBoundingClientRect(),rect=card?.getBoundingClientRect();
  const toolbar=card?.closest('.file-workbench-toolbar')?.getBoundingClientRect();
  if(!back||!svg||!rect||!title||!toolbar)return null;
  return {width:rect.width,height:rect.height,titleClipped:heading.scrollWidth>heading.clientWidth,
   toolbarHeight:Math.round(toolbar.height),inFlow:getComputedStyle(card).position==='static',
   withinToolbar:rect.top>=toolbar.top-1&&rect.bottom<=toolbar.bottom+1,
   arrowCentered:Math.abs(back.x+back.width/2-svg.x-svg.width/2)<1&&
    Math.abs(back.y+back.height/2-svg.y-svg.height/2)<1,
   titleWithinCard:title.right<=rect.right+1};
 })()`);
 assert("file identity occupies the 48px flow toolbar with bounded title and centered back arrow",
  !!identityGeometry&&identityGeometry.toolbarHeight===48&&identityGeometry.height<=48&&
  identityGeometry.inFlow&&identityGeometry.withinToolbar&&
  identityGeometry.arrowCentered&&identityGeometry.titleWithinCard,JSON.stringify(identityGeometry));
 await cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:720,y:2});
 const headerShown=await cdp.waitFor(`()=>{
  const h=document.querySelector('.shell-preview-autoheader>.header');
  const work=document.querySelector('.file-preview-page');
  return h&&work&&getComputedStyle(h).visibility==='visible'&&
   h.getBoundingClientRect().height>40&&
   work.getBoundingClientRect().top>=h.getBoundingClientRect().bottom-1;
 }`,3500);
 assert("moving mouse to screen top reveals header with animation",Boolean(headerShown));
 const openGeometry=await cdp.evaluate(`(()=>{
  const h=document.querySelector('.shell-preview-autoheader>.header');
  const work=document.querySelector('.file-preview-page');
  const shell=document.querySelector('.shell');
  if(!h||!work||!shell)return null;
  return {position:getComputedStyle(h).position,headerHeight:h.getBoundingClientRect().height,
   pushedBy:work.getBoundingClientRect().top-shell.getBoundingClientRect().top};
 })()`);
 assert("revealed menu pushes the entire preview workbench below navigation",
  !!openGeometry&&openGeometry.position==='relative'&&
  openGeometry.pushedBy>=initiallyHidden.workOffset+openGeometry.headerHeight-2,
  JSON.stringify(openGeometry));
 await cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:720,y:450});
 await delay(500);
 const headerHeld=await cdp.evaluate(`(()=>{
  const h=document.querySelector('.shell-preview-autoheader>.header');
  return h&&getComputedStyle(h).visibility==='visible'&&h.getBoundingClientRect().height>40;
 })()`);
 assert("preview menu remains visible briefly after pointer leaves",Boolean(headerHeld));
 const headerHidden=await cdp.waitFor(`()=>{
  const h=document.querySelector('.shell-preview-autoheader>.header');
  const shell=document.querySelector('.shell');
  const work=document.querySelector('.file-preview-page');
  return h&&work&&shell&&getComputedStyle(h).visibility==='hidden'&&
   h.getBoundingClientRect().height<=1&&
   work.getBoundingClientRect().top-shell.getBoundingClientRect().top<24;
 }`,3500);
 assert("moving away from top dismisses header automatically",Boolean(headerHidden));

 for(const width of [1280,820,390]){
  await cdp.send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
  await cdp.evaluate(`(()=>document.querySelector('.preview-header-reveal')?.click())()`);
  const pushed=await cdp.waitFor(`()=>{
   const h=document.querySelector('.shell-preview-autoheader>.header');
   const work=document.querySelector('.file-preview-page');
   if(!h||!work)return false;
   const hRect=h.getBoundingClientRect(),workRect=work.getBoundingClientRect();
   return getComputedStyle(h).visibility==='visible'&&
    hRect.height>=50&&workRect.top>=hRect.bottom-1;
  }`,3500);
  assert(`preview navigation never overlays the workbench at ${width}px`,Boolean(pushed));
 }
 await cdp.send("Emulation.clearDeviceMetricsOverride");
 await cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:720,y:450});
 await cdp.waitFor(`()=>document.querySelector('.shell-preview-autoheader>.header')?.getBoundingClientRect().height<=1`,3500);

 const workspaceUI=await cdp.evaluate(`(()=>{
  const dock=document.querySelector('.header .global-utility-dock');
  const identity=document.querySelector('.file-workbench-main .file-preview-identity');
  const old=document.querySelector('.file-workbench-header');
  const viewer=document.querySelector('.file-pdf-viewer')?.getBoundingClientRect();
  const bottom=document.querySelector('.file-pdf-toolbar')?.getBoundingClientRect();
  return {global:!!dock&&!!dock.querySelector('.command-trigger')&&!!dock.querySelector('.account-trigger'),
   noExit:!document.querySelector('.header-exit-btn'),identity:!!identity&&!old,
   dockBottom:viewer&&bottom?Math.round(viewer.bottom-bottom.bottom):null,
   dockWidth:bottom?.width,viewerWidth:viewer?.width};
 })()`);
 assert("global utility dock groups search and account without duplicate logout",
  workspaceUI.global&&workspaceUI.noExit,JSON.stringify(workspaceUI));
 assert("file identity shares the flow preview toolbar, not a separate page header",
  workspaceUI.identity,JSON.stringify(workspaceUI));
 assert("PDF reader tools float in a compact bottom dock",
  workspaceUI.dockBottom!==null&&workspaceUI.dockBottom>=0&&workspaceUI.dockBottom<55&&workspaceUI.dockWidth<workspaceUI.viewerWidth*.94,
  JSON.stringify(workspaceUI));
 const topActions=await cdp.evaluate(`(()=>{
  const area=document.querySelector('.file-workbench-main')?.getBoundingClientRect();
  const actions=document.querySelector('.file-preview-action-dock')?.getBoundingClientRect();
  const old=document.querySelector('.file-workbench-sidebar .file-workbench-actions');
  const buttons=[...document.querySelectorAll('.file-preview-action-dock .file-workbench-actions>button')];
  return area&&actions?{count:buttons.length,top:actions.top-area.top,right:area.right-actions.right,
   emptySidebar:!old,buttonLabels:buttons.map(b=>b.getAttribute('aria-label'))}:null;
 })()`);
 assert("download print and more share the top-right toolbar, not sidebar",
  !!topActions&&topActions.count>=3&&topActions.buttonLabels.includes("下载")&&topActions.buttonLabels.includes("打印")&&topActions.buttonLabels.includes("更多文件操作")&&topActions.top>=0&&topActions.top<40&&topActions.right>=0&&topActions.right<40&&topActions.emptySidebar,
  JSON.stringify(topActions));

 await cdp.evaluate(`(()=>document.querySelector('.file-sidebar-collapse')?.click())()`);
 const collapsedReady=await cdp.waitFor(`()=>{
  const layout=document.querySelector('.file-workbench-layout');
  const sidebar=document.querySelector('.file-workbench-sidebar');
  return !!layout?.classList.contains('is-collapsed')&&sidebar?.getBoundingClientRect().width<90;
 }`,4000);
 const collapsed=await cdp.evaluate(`(()=>{
  const sidebar=document.querySelector('.file-workbench-sidebar');
  return {collapsed:document.querySelector('.file-workbench-layout')?.classList.contains('is-collapsed'),
   width:sidebar?.getBoundingClientRect().width,icon:!!sidebar?.querySelector('.file-workbench-nav-icon')};
 })()`);
 assert("sidebar top toggle collapses to icon-only rail",
  Boolean(collapsedReady)&&collapsed.collapsed&&collapsed.width<90&&collapsed.icon,JSON.stringify(collapsed));
 await cdp.evaluate(`(()=>document.querySelector('.file-sidebar-collapse')?.click())()`);
 const restoredReady=await cdp.waitFor(`()=>{
  const layout=document.querySelector('.file-workbench-layout');
  const sidebar=document.querySelector('.file-workbench-sidebar');
  return !layout?.classList.contains('is-collapsed')&&sidebar?.getBoundingClientRect().width>180;
 }`,4000);
 const restoredSidebar=await cdp.evaluate(`(()=>document.querySelector('.file-workbench-sidebar')?.getBoundingClientRect().width)()`);
 assert("sidebar toggle restores fixed 240px navigation",Boolean(restoredReady)&&Math.abs(restoredSidebar-240)<2,String(restoredSidebar));

 const clicked=await cdp.evaluate(`(()=>{
  const item=[...document.querySelectorAll('.file-workbench-nav-item')]
   .find(b=>b.textContent?.trim()==='签名与盖章');
  if(!item)return false;item.click();return true;
 })()`);
 assert("sidebar signing entry can be activated from normal preview",Boolean(clicked));
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
  assert("sidebar width stays fixed in signing and metadata modes",
   Math.abs(geometry.left-restoredSidebar)<2,JSON.stringify({signing:geometry.left,preview:restoredSidebar}));
  const signingDock=await cdp.evaluate(`(()=>{
   const stage=document.querySelector('.seal-file-preview')?.getBoundingClientRect();
   const dock=document.querySelector('.seal-page-toolbar')?.getBoundingClientRect();
   return stage&&dock?{bottom:Math.round(stage.bottom-dock.bottom),width:dock.width,stage:stage.width}:null;
  })()`);
  assert("signing view controls float below page without top toolbar",
   !!signingDock&&signingDock.bottom>=0&&signingDock.bottom<55&&signingDock.width<signingDock.stage*.94,
   JSON.stringify(signingDock));

  const compact=await cdp.evaluate(`(()=>{
   const history=document.querySelector('#file-seals-sidebar .seal-sidebar-history');
   return !!history&&!history.open&&!document.querySelector('#file-seals-sidebar .seal-submit-panel');
  })()`);
  assert("signing sidebar defaults to compact controls with history collapsed",compact);

  const clean=await cdp.evaluate(`(()=>{
   const page=document.querySelector('.seal-page-surface')?.getBoundingClientRect();
   const stage=document.querySelector('.seal-page-viewport');
   const css=stage&&getComputedStyle(stage);
   return !!page&&page.width<=764&&css?.backgroundColor==='rgb(241, 245, 249)'&&
    !document.querySelector('.seal-page-toolbar .seal-delete-action')&&
    !document.querySelector('.seal-page-toolbar .seal-confirm-action');
  })()`);
  assert("empty signing stage has grey A4 paper without permanent red action",clean);

  const historyActions=await cdp.evaluate(`(()=>{
   const history=document.querySelector('#file-seals-sidebar .seal-sidebar-history');
   history.open=true;
   const actions=history.querySelector('.seal-history-actions');
   const yes=!!actions;
   history.open=false;
   return yes;
  })()`);
  if(historyActions){
   await cdp.evaluate(`(()=>{
    const history=document.querySelector('#file-seals-sidebar .seal-sidebar-history');
    history.open=true;
    [...history.querySelectorAll('.seal-history-actions button')].find(b=>b.textContent.includes('选择删除'))?.click();
   })()`);
   const deletionFromHistory=await cdp.evaluate(`(()=>{
    return !!document.querySelector('.seal-history-pick')&&
     !document.querySelector('.seal-page-toolbar .seal-delete-action');
   })()`);
   assert("historical stamp removal starts from expanded signed records",deletionFromHistory);
   await cdp.evaluate(`(()=>document.querySelector('.seal-history-actions button')?.click())()`);
  }else console.log("SKIP historical removal: no deletable marks");

  const enabled=await cdp.evaluate(`(()=>[...document.querySelectorAll('#file-seals-sidebar .seal-stamp-card')].filter(b=>!b.disabled).length)()`);
  if(enabled){
   const clickedAsset=await cdp.evaluate(`(()=>{
    const cards=[...document.querySelectorAll('#file-seals-sidebar .seal-stamp-card')].filter(b=>!b.disabled);
    const card=cards.find(b=>b.textContent.includes('个人签名'))||cards[0];
    const kind=card.textContent.includes('个人签名')?'personal':'company';
    card.click();
    return kind;
   })()`);
   const mark=await cdp.waitFor(`()=>!!document.querySelector('.seal-position-mark.is-editable')`,4500);
   assert("visual stamp card places a movable mark on the PDF page",Boolean(mark));
   if(mark){
    const frame=await cdp.evaluate(`(()=>{
     const node=document.querySelector('.seal-position-mark');
     const img=node.querySelector('img');
     const toolbar=node.querySelector('.seal-stamp-mini-toolbar');
     const paper=document.querySelector('.seal-page-surface').getBoundingClientRect();
     const box=node.getBoundingClientRect();
     const handles=[...node.querySelectorAll('.seal-resize-handle')];
     return {corners:handles.length,toolbar:!!toolbar,ratio:box.width/box.height,
      nativeRatio:img.naturalWidth/img.naturalHeight,
      inside:box.left>=paper.left-4&&box.right<=paper.right+4,
      overlap:handles.some(h=>{const r=h.getBoundingClientRect(),tb=toolbar?.getBoundingClientRect();return !!tb&&r.left<tb.right&&r.right>tb.left&&r.top<tb.bottom&&r.bottom>tb.top})};
    })()`);
    assert("stamp preserves image proportions with four clean handles and floating mini toolbar",
     frame.corners===4&&frame.toolbar&&frame.inside&&!frame.overlap&&
     Math.abs(frame.ratio-frame.nativeRatio)/frame.nativeRatio<.12,JSON.stringify(frame));
    const advanced=await cdp.evaluate(`(()=>{
     const details=document.querySelector('#file-seals-sidebar .seal-advanced-settings');
     details?.querySelector('summary')?.click();
     const okay=details?.open&&!!details.querySelector('input[aria-label="旋转度数"]');
     details?.querySelector('summary')?.click();return !!okay;
    })()`);
    assert("precision inspector expands without another white container",advanced);

    const before=await cdp.evaluate(`(()=>{
     const mark=document.querySelector('.seal-position-mark');
     const r=mark.getBoundingClientRect();
     return {x:r.x+r.width*.45,y:r.y+r.height*.45,left:parseFloat(mark.style.left),width:parseFloat(mark.style.width)};
    })()`);
    await cdp.drag({x:before.x,y:before.y},{x:before.x+48,y:before.y-25});
    const moved=await cdp.evaluate(`(()=>parseFloat(document.querySelector('.seal-position-mark').style.left))()`);
    assert("stamp moves using pointer drag",moved>before.left+1);
    const handle=await cdp.evaluate(`(()=>{
     const node=document.querySelector('.seal-resize-handle.is-se');
     const r=node.getBoundingClientRect();
     const x=r.x+r.width/2,y=r.y+r.height/2;
     const target=document.elementFromPoint(x,y);
     return {x,y,target:target?.className,handlePointer:getComputedStyle(node).pointerEvents,markPointer:getComputedStyle(node.parentElement).pointerEvents};

    })()`);
    const beforeRatio=await cdp.evaluate(`(()=>{
     const el=document.querySelector('.seal-position-mark').getBoundingClientRect();
     return el.width/el.height;
    })()`);
    console.log("STAMP_RESIZE_HIT_DIAGNOSTIC",JSON.stringify(handle));
    await cdp.drag(handle,{x:handle.x+25,y:handle.y+12});
    const resized=await cdp.evaluate(`(()=>{
     const el=document.querySelector('.seal-position-mark');
     const r=el.getBoundingClientRect();
     return {width:parseFloat(el.style.width),ratio:r.width/r.height};
    })()`);
    assert("four-corner resizing preserves the original aspect ratio",
      resized.width>before.width+1&&Math.abs(resized.ratio-beforeRatio)<.09,JSON.stringify(resized));

    await cdp.evaluate(`(()=>[...document.querySelectorAll('.seal-stamp-mini-toolbar button')].find(b=>b.getAttribute('aria-label')?.includes('顺时针'))?.click())()`);
    const rotated=await cdp.evaluate(`(()=>document.querySelector('.seal-position-mark img')?.style.transform.includes('90deg'))()`);
    assert("floating stamp toolbar rotates by 90 degrees",rotated);
    assert("pending stamps show primary confirmation and secondary clear",
      await cdp.evaluate(`(()=>!!document.querySelector('.seal-page-toolbar .seal-confirm-action')&&!!document.querySelector('.seal-page-toolbar .seal-clear-action'))()`));
    if(clickedAsset==='personal'){
     await cdp.evaluate(`(()=>document.querySelector('.seal-confirm-action')?.click())()`);
     const passwordDialog=await cdp.waitFor(`()=>!!document.querySelector('dialog.seal-confirm-dialog[open] input[type=password]')`,3200);
     assert("personal signature confirmation requires password",Boolean(passwordDialog));
     await cdp.evaluate(`(()=>[...document.querySelectorAll('dialog.seal-confirm-dialog button')].find(b=>b.textContent?.includes('取消'))?.click())()`);
    }else console.log("SKIP submit company-only stamp (would persist a mark)");

    await cdp.evaluate(`(()=>document.querySelector('.seal-stamp-mini-toolbar .seal-mini-remove')?.click())()`);
    const removed=await cdp.waitFor(`()=>document.querySelectorAll('.seal-draft-row').length===0&&!document.querySelector('.seal-position-mark')`,3500);
    assert("floating toolbar removes only the pending mark",Boolean(removed));
    await cdp.evaluate(`(()=>[...document.querySelectorAll('#file-seals-sidebar .seal-stamp-card')].find(b=>!b.disabled)?.click())()`);
    const repopulated=await cdp.waitFor(`()=>document.querySelectorAll('.seal-draft-row').length===1`,3500);
    assert("same stamp can be placed again after removal",Boolean(repopulated));
    await cdp.send("Emulation.setDeviceMetricsOverride",{width:760,height:820,deviceScaleFactor:1,mobile:false});
    await delay(500);
    const narrow=await cdp.evaluate(`(()=>{
     const panel=document.querySelector('.seal-file-preview')?.getBoundingClientRect();
     const dock=document.querySelector('.seal-page-toolbar')?.getBoundingClientRect();
     const confirm=document.querySelector('.seal-confirm-action')?.getBoundingClientRect();
     return !!panel&&!!dock&&!!confirm&&confirm.left>=dock.left-1&&confirm.right<=dock.right+1&&
      dock.left>=panel.left-1&&dock.right<=panel.right+1&&document.documentElement.scrollWidth<=window.innerWidth+2;
    })()`);
    assert("narrow signing HUD remains within preview canvas",narrow);
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await delay(250);
   }
  }else console.log("SKIP draft editing: no authorized unused assets");

 }
 await cdp.evaluate(`(()=>{
  [...document.querySelectorAll('.file-workbench-nav-item')].find(b=>b.textContent.trim()==='预览')?.click();
 })()`);
 const persisted=await cdp.evaluate(`(()=>!!document.querySelector('#file-seals-sidebar[hidden] .seal-draft-row'))()`);
 assert("pending signing draft stays mounted while reading document",persisted);
 await cdp.evaluate(`(()=>{[...document.querySelectorAll('.file-workbench-nav-item')].find(b=>b.textContent.trim()==='签名与盖章')?.click()})()`);
 await delay(200);
 const restored=await cdp.evaluate(`(()=>!!document.querySelector('#file-seals-sidebar:not([hidden]) .seal-draft-row'))()`);
 assert("pending signing draft is restored after switching back",restored);
 await cdp.evaluate(`(()=>{[...document.querySelectorAll('.file-workbench-nav-item')].find(b=>b.textContent.trim()==='文件信息')?.click()})()`);
 const infoCompact=await cdp.evaluate(`(()=>{
  const s=document.querySelector('.file-details-panel');
  return !!s&&!!s.querySelector('.file-properties-compact')&&
   [...s.querySelectorAll('details.file-sidebar-disclosure')].length===2&&
   [...s.querySelectorAll('details.file-sidebar-disclosure')].every(x=>!x.open);
 })()`);
 assert("file details show essentials, hide classification and technical fields",infoCompact);
 await cdp.evaluate(`(()=>{[...document.querySelectorAll('.file-workbench-nav-item')].find(b=>b.textContent.trim()==='审查批注')?.click()})()`);
 const reviewCompact=await cdp.evaluate(`(()=>{
  const b=[...document.querySelectorAll('.file-review button')].find(b=>b.textContent?.includes('批注'));
  const initial=!document.querySelector('.file-review-form');
  b?.click();
  return initial&&!!b;
 })()`);
 const reviewExpanded=await cdp.waitFor(`()=>!!document.querySelector('.file-review-form')`,3000);
 assert("review composer opens only on demand",reviewCompact&&Boolean(reviewExpanded));
 await cdp.evaluate(`(()=>{[...document.querySelectorAll('.file-workbench-nav-item')].find(b=>b.textContent.trim()==='预览')?.click()})()`);
 const dock=await cdp.evaluate(`(()=>{
  const area=document.querySelector('.file-workbench-main')?.getBoundingClientRect();
  const group=document.querySelector('.file-preview-action-dock .file-workbench-actions');
  const buttons=[...(group?.querySelectorAll('button')??[])];
  if(buttons.length<3)return null;
  group.querySelector(".file-more-trigger")?.click();
  return {length:buttons.length,top:group.getBoundingClientRect().top-area.top,
    right:area.right-group.getBoundingClientRect().right,sidebarActions:!!document.querySelector('.file-workbench-sidebar .file-workbench-actions')};
 })()`);
 const expanded=await cdp.waitFor(`()=>!!document.querySelector('.file-preview-action-dock .file-action-expansion')`,3000);
 await delay(250);
 const dropdownBelow=await cdp.evaluate(`(()=>{
  const button=document.querySelector('.file-preview-action-dock .file-workbench-actions');
  const expanded=document.querySelector('.file-preview-action-dock .file-action-expansion');
  return !!button&&!!expanded&&expanded.getBoundingClientRect().top>=button.getBoundingClientRect().bottom;
 })()`);
 assert("download print more are top-right, not in left sidebar",
   !!dock&&dock.length>=3&&dock.top<40&&dock.right<40&&!dock.sidebarActions,JSON.stringify(dock));
 assert("more actions drop down under upper-right capsule",
   Boolean(expanded)&&Boolean(dropdownBelow));

 const video=(files.data?.items??[]).find(item=>/\.(mp4|webm|mov)$/i.test(item.name??""));
 if(video){
  await cdp.send("Page.navigate",{url:BASE+"/preview/"+encodeURIComponent(video.id)});
  const ready=await cdp.waitFor(`()=>!!document.querySelector('.media-video-stage video')`,14000);
  const media=await cdp.evaluate(`(()=>{
   const section=document.querySelector('.file-workbench-preview-surface .media-preview');
   const controls=section?.querySelector('video');
   return {stage:!!section,controls:!!controls?.controls,
    noRedundantRow:!section?.querySelector('.media-tools'),topDock:!!document.querySelector('.file-preview-action-dock')};
  })()`);
  assert("video preview uses native playback without duplicate help row",
   Boolean(ready)&&media.stage&&media.controls&&media.noRedundantRow&&media.topDock,JSON.stringify(media));
 }
 const cad=(files.data?.items??[]).find(item=>/\.(step|stp|stl|obj|dxf|dwg)$/i.test(item.name??""));
 if(cad){
  await cdp.send("Page.navigate",{url:BASE+"/preview/"+encodeURIComponent(cad.id)});
  // Supported CAD must auto-mount the actual viewer. The old assertion
  // expected an unsupported-file fallback and incorrectly required Print.
  const ready=await cdp.waitFor(`()=>!!document.querySelector('.file-workbench-preview-surface .cad-embedded .cad-viewport')`,18000);
  const ui=await cdp.evaluate(`(()=>{
   const stage=document.querySelector('.file-workbench-preview-surface .cad-embedded .cad-viewport');
   const panel=document.querySelector('.file-workbench-preview-surface');
   const box=stage?.getBoundingClientRect(),parent=panel?.getBoundingClientRect();
   const actions=[...document.querySelectorAll('.file-preview-action-dock .file-workbench-actions>button')];
   return {stage:!!box&&box.width>0&&box.height>100&&box.left>=parent.left-2&&box.right<=parent.right+2,
    loading:!!stage?.querySelector('.cad-loading-body'),canvas:!!stage?.querySelector('canvas'),
    unsupportedFallback:!!document.querySelector('.file-unsupported'),
    toolbar:!!stage?.querySelector('.cad-compact-toolbar'),
    topActions:actions.map(button=>button.getAttribute('aria-label'))};
  })()`);
  assert("CAD automatically mounts a viewer with the compact controls and no unsupported fallback",
   Boolean(ready)&&ui.stage&&(ui.loading||ui.canvas)&&!ui.unsupportedFallback&&
   ui.topActions.includes("下载")&&ui.topActions.includes("更多文件操作")&&!ui.topActions.includes("打印"),
   JSON.stringify(ui));
 }


}finally{
 cdp?.close();chrome.kill("SIGKILL");
}
const failed=checks.filter(([,ok])=>!ok);
console.log("SIGNING_WORKBENCH_BROWSER_"+(failed.length?"FAIL":"PASS")+" "+(checks.length-failed.length)+"/"+checks.length);
if(failed.length)process.exitCode=1;
