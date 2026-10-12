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
 // Preview uses a real hidden shell header, not a fixed bar consuming content height.
 const initiallyHidden=await cdp.evaluate(`(()=>{
  const h=document.querySelector('.shell-preview-autoheader>.header');
  const shell=document.querySelector('.shell');
  const work=document.querySelector('.work');
  if(!h||!shell||!work)return null;
  const style=getComputedStyle(h);
  const rect=work.getBoundingClientRect(),parent=shell.getBoundingClientRect();
  return {hidden:style.visibility==='hidden',headBottom:h.getBoundingClientRect().bottom,
   workOffset:Math.round(rect.top-parent.top),trigger:!!document.querySelector('.preview-header-reveal')};
 })()`);
 assert("preview initially hides system menu without reserving its height",
  !!initiallyHidden&&initiallyHidden.hidden&&initiallyHidden.trigger&&initiallyHidden.workOffset<24,
  JSON.stringify(initiallyHidden));
 const identityGeometry=await cdp.evaluate(`(()=>{
  const card=document.querySelector('.file-preview-identity');
  const back=card?.querySelector('.file-back')?.getBoundingClientRect();
  const svg=card?.querySelector('.file-back svg')?.getBoundingClientRect();
  const heading=card?.querySelector('h1');
  const title=heading?.getBoundingClientRect(),rect=card?.getBoundingClientRect();
  if(!back||!svg||!rect||!title)return null;
  return {width:rect.width,height:rect.height,titleClipped:heading.scrollWidth>heading.clientWidth,
   arrowCentered:Math.abs(back.x+back.width/2-svg.x-svg.width/2)<1&&
    Math.abs(back.y+back.height/2-svg.y-svg.height/2)<1,
   titleWithinCard:title.right<=rect.right+1};
 })()`);
 assert("file identity is compact, title bounded and return arrow centered",
  !!identityGeometry&&identityGeometry.width<540&&identityGeometry.height<70&&
  identityGeometry.arrowCentered&&identityGeometry.titleWithinCard,JSON.stringify(identityGeometry));
 await cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:720,y:2});
 const headerShown=await cdp.waitFor(`()=>{
  const h=document.querySelector('.shell-preview-autoheader>.header');
  return h&&getComputedStyle(h).visibility==='visible'&&h.getBoundingClientRect().top>0;
 }`,3500);
 assert("moving mouse to screen top reveals header with animation",Boolean(headerShown));
 await cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:720,y:450});
 const headerHidden=await cdp.waitFor(`()=>{
  const h=document.querySelector('.shell-preview-autoheader>.header');
  return h&&getComputedStyle(h).visibility==='hidden'&&h.getBoundingClientRect().bottom<=0;
 }`,3500);
 assert("moving away from top dismisses header automatically",Boolean(headerHidden));

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
 assert("file identity floats inside preview, not in a separate header",
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
 assert("download print and more are in one top-right floating dock, not sidebar",
  !!topActions&&topActions.count===3&&topActions.top>=0&&topActions.top<40&&topActions.right>=0&&topActions.right<40&&topActions.emptySidebar,
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
  const redDelete=await cdp.evaluate(`(()=>{
    const button=document.querySelector('.seal-page-toolbar .seal-delete-action');
    if(!button)return null;
    return {tone:button.dataset.rareIntent,emphasis:button.dataset.rareEmphasis,
      label:button.textContent.trim(),visible:button.getBoundingClientRect().height>26};
  })()`);
  if(redDelete){
   assert("global solid red danger button appears in the bottom signing capsule",
    redDelete.tone==='danger'&&redDelete.emphasis==='solid'&&redDelete.visible,
    JSON.stringify(redDelete));
   await cdp.evaluate(`(()=>document.querySelector('.seal-delete-action')?.click())()`);
   const target=await cdp.waitFor(`()=>!!document.querySelector('.seal-delete-target')`,3500);
   if(target){
    await cdp.evaluate(`(()=>document.querySelector('.seal-delete-target')?.click())()`);
    const highlighted=await cdp.evaluate(`(()=>{
     const t=document.querySelector('.seal-delete-target');
     return !!t?.classList.contains('is-selected')&&t.getAttribute('aria-pressed')==='true';
    })()`);
    assert("clicking a signed personal mark highlights it for deletion",highlighted);
    await cdp.evaluate(`(()=>document.querySelector('.seal-delete-action')?.click())()`);
    const revokeModal=await cdp.waitFor(`()=>!!document.querySelector('dialog.seal-confirm-dialog[open] input[aria-label="删除签名密码"]')`,3500);
    assert("deleting an existing signature asks for password",Boolean(revokeModal));
    await cdp.evaluate(`(()=>[...document.querySelectorAll('dialog.seal-confirm-dialog[open] button')].find(b=>b.textContent?.includes('取消'))?.click())()`);
    const revokedNone=await cdp.waitFor(`()=>!document.querySelector('dialog.seal-confirm-dialog[open]')`,2500);
    assert("canceling removal preserves original signed PDF evidence",Boolean(revokedNone));
   }else console.log("SKIP signed signature selection: none removable on current page");
   await cdp.evaluate(`(()=>document.querySelector('.seal-cancel-delete')?.click())()`);
  }else console.log("SKIP signature-removal button: no personal signatures exist");

  const enabled=await cdp.evaluate(`(()=>{
   const list=document.querySelector('#file-seals-sidebar select');
   return [...(list?.options??[])].filter(o=>o.value&&!o.disabled).length;
  })()`);
  if(enabled){
   await cdp.evaluate(`(()=>{document.querySelector('#file-seals-sidebar .rare-select')?.click()})()`);
   const chose=await cdp.waitFor(`()=>[...document.querySelectorAll('[role="option"]')].some(o=>!o.disabled&&o.textContent.trim()!=='选择人员或公章')`,4500);
   assert("signing asset selection opens RareUI listbox",Boolean(chose));
   if(chose){
    await cdp.evaluate(`(()=>{
      const options=[...document.querySelectorAll('[role="option"]')].filter(o=>!o.disabled&&o.textContent.trim()!=='选择人员或公章');
      // Prefer a personal signature for a password-modal test. Never submit a
      // company-only stamp during the browser regression: that would be real.
      (options.find(o=>!o.textContent.trim().startsWith('公章 ·'))||options[0])?.click();
    })()`);
    const selectedType=await cdp.evaluate(`(()=>{
      const native=document.querySelector('#file-seals-sidebar select');
      return native?.selectedOptions?.[0]?.textContent.trim().startsWith('公章 ·')?'company':'personal';
    })()`);
    const mark=await cdp.waitFor(`()=>!!document.querySelector('.seal-position-mark.is-editable')`,4500);
    assert("selected signing asset has movable page overlay",Boolean(mark));
    const advanced=await cdp.evaluate(`(()=>{
     const section=document.querySelector('#file-seals-sidebar .seal-advanced-settings');
     if(!section||section.open)return false;
     section.querySelector('summary')?.click();
     const visible=section.open&&!!section.querySelector('input[aria-label="旋转度数"]');
     section.querySelector('summary')?.click();
     return visible&&!section.open;
    })()`);
    assert("precision controls expand on demand without replacing stamp",advanced);

    if(mark){
     const before=await cdp.evaluate(`(()=>{
      const p=document.querySelector('.seal-position-mark').getBoundingClientRect();
      return {x:p.x+p.width*.45,y:p.y+p.height*.45,left:parseFloat(document.querySelector('.seal-position-mark').style.left),width:parseFloat(document.querySelector('.seal-position-mark').style.width)};
     })()`);
     await cdp.drag({x:before.x,y:before.y},{x:before.x+48,y:before.y-25});
     const after=await cdp.evaluate(`(()=>parseFloat(document.querySelector('.seal-position-mark').style.left))()`);
     assert("mark moves through real pointer drag",after>before.left+1,"left "+before.left+" → "+after);
     const handle=await cdp.evaluate(`(()=>{
      const h=document.querySelector('.seal-resize-handle.is-se').getBoundingClientRect();
      return {x:h.x+h.width/2,y:h.y+h.height/2};
     })()`);
     await cdp.drag(handle,{x:handle.x+25,y:handle.y+12});
     const width=await cdp.evaluate(`(()=>parseFloat(document.querySelector('.seal-position-mark').style.width))()`);
     assert("mark resizes through pointer handle",width>before.width+1,"width "+before.width+" → "+width);
     const autoDraft=await cdp.evaluate(`(()=>{
      return !!document.querySelector('.seal-draft-row')&&
       ![...document.querySelectorAll('#file-seals-sidebar button')].some(b=>b.textContent?.includes('加入待签清单'));
     })()`);
     assert("selecting an asset automatically places its draft without add-list action",autoDraft);
     const frame=await cdp.evaluate(`(()=>{
      const mark=document.querySelector('.seal-position-mark');
      const paper=document.querySelector('.seal-page-surface');
      const controls=mark?.querySelectorAll('.seal-resize-handle');
      return {corners:controls?.length,remove:!!mark?.querySelector('.seal-remove-mark'),
       inside:mark&&paper?mark.getBoundingClientRect().left>=paper.getBoundingClientRect().left-4&&
       mark.getBoundingClientRect().right<=paper.getBoundingClientRect().right+4:null};
     })()`);
     assert("stamp has four resize corners and in-bounds upper-right remove control",
      frame.corners===4&&frame.remove&&frame.inside,JSON.stringify(frame));
     const bottomConfirm=await cdp.evaluate(`(()=>{
      const button=document.querySelector('.seal-page-toolbar .seal-confirm-action');
      return !!button&&!button.disabled&&button.textContent.includes('确认签署')&&
       !document.querySelector('#file-seals-sidebar input[type=password]');
     })()`);
     assert("single blue signing action lives in the bottom capsule without sidebar password",bottomConfirm);
     if(selectedType==='personal'){
      await cdp.evaluate(`(()=>document.querySelector('.seal-confirm-action')?.click())()`);
      const modal=await cdp.waitFor(`()=>!!document.querySelector('dialog.seal-confirm-dialog[open] input[type=password]')`,3200);
      assert("personal signature prompts for password at bottom confirmation",Boolean(modal));
      await cdp.evaluate(`(()=>{
       [...document.querySelectorAll('dialog.seal-confirm-dialog button')].find(b=>b.textContent?.includes('取消'))?.click();
      })()`);
      const canceled=await cdp.waitFor(`()=>!document.querySelector('dialog.seal-confirm-dialog[open]')`,3000);
      assert("cancelling personal signing modal preserves draft",
       Boolean(canceled)&&await cdp.evaluate(`(()=>document.querySelectorAll('.seal-draft-row').length===1)()`));
     }else{
      // Never click "confirm" for a company stamp in tests. Company stamping
      // is intentionally passwordless and would immediately persist a mark.
      assert("company stamp offers direct confirmation with no password entry",
       await cdp.evaluate(`(()=>!document.querySelector('#file-seals-sidebar input[type=password]')&&!document.querySelector('dialog.seal-confirm-dialog[open]'))()`));
     }
     await cdp.evaluate(`(()=>document.querySelector('.seal-remove-mark')?.click())()`);
     const removed=await cdp.waitFor(`()=>document.querySelectorAll('.seal-draft-row').length===0&&!document.querySelector('.seal-position-mark')`,3500);
     assert("upper-right X removes staged seal without signing",Boolean(removed));
     await cdp.evaluate(`(()=>document.querySelector('#file-seals-sidebar .rare-select')?.click())()`);
     await cdp.waitFor(`()=>[...document.querySelectorAll('[role="option"]')].some(o=>!o.disabled&&o.textContent.trim()!=='选择人员或公章')`,3200);
     await cdp.evaluate(`(()=>[...document.querySelectorAll('[role="option"]')].find(o=>!o.disabled&&o.textContent.trim()!=='选择人员或公章')?.click())()`);
     const repopulated=await cdp.waitFor(`()=>document.querySelectorAll('.seal-draft-row').length===1`,3500);
     assert("asset can be selected again after X removal",Boolean(repopulated));

     await cdp.send("Emulation.setDeviceMetricsOverride",{width:760,height:820,deviceScaleFactor:1,mobile:false});
     await delay(380);
     const narrow=await cdp.evaluate(`(()=>{
      const panel=document.querySelector('.seal-file-preview')?.getBoundingClientRect();
      const dock=document.querySelector('.seal-page-toolbar')?.getBoundingClientRect();
      const confirm=document.querySelector('.seal-confirm-action')?.getBoundingClientRect();
      return panel&&dock&&confirm?{
       inside:confirm.left>=dock.left-1&&confirm.right<=dock.right+1&&
        dock.left>=panel.left-1&&dock.right<=panel.right+1,
       visible:confirm.width>70&&confirm.height>=28,
       pageOverflow:document.documentElement.scrollWidth>window.innerWidth+2,
       dockWidth:dock.width,confirmWidth:confirm.width
      }:null;
     })()`);
     assert("narrow viewport keeps blue confirmation inside the bottom capsule",
       !!narrow&&narrow.inside&&narrow.visible&&!narrow.pageOverflow,JSON.stringify(narrow));
     await cdp.send("Emulation.clearDeviceMetricsOverride");
     await delay(300);


     const availableSecond=await cdp.evaluate(`(()=>{
      const select=document.querySelector('#file-seals-sidebar select');
      if(!select)return null;
      const option=[...select.options].find(o=>o.value&&!o.disabled&&o.value!==select.value);
      return option?.textContent?.trim()??null;
     })()`);
     if(availableSecond){
      await cdp.evaluate(`(()=>document.querySelector('#file-seals-sidebar .rare-select')?.click())()`);
      await cdp.waitFor(`()=>[...document.querySelectorAll('[role="option"]')].some(o=>o.textContent.trim()===${JSON.stringify(availableSecond)})`,3000);
      await cdp.evaluate(`(()=>{
       const target=${JSON.stringify(availableSecond)};
       [...document.querySelectorAll('[role="option"]')].find(o=>o.textContent.trim()===target)?.click();
      })()`);
      const two=await cdp.waitFor(`()=>document.querySelectorAll('.seal-draft-row').length===2`,3500);
      assert("additional distinct signature/seal auto-joins same batch",Boolean(two));
      if(two){
       await cdp.evaluate(`(()=>document.querySelector('.seal-remove-mark')?.click())()`);
       const one=await cdp.waitFor(`()=>document.querySelectorAll('.seal-draft-row').length===1`,3500);
       assert("removing one signature preserves other batch members",Boolean(one));
      }
     }else console.log("SKIP multiple assets: no second unused authorized signature");




    }
   }
  }else console.log("SKIP asset editing: no unconsumed authorized signing assets");
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
  if(buttons.length!==3)return null;
  buttons[2].click();
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
   !!dock&&dock.length===3&&dock.top<40&&dock.right<40&&!dock.sidebarActions,JSON.stringify(dock));
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
  const ready=await cdp.waitFor(`()=>!!document.querySelector('.file-unsupported .preview-reader-dock')`,14000);
  const ui=await cdp.evaluate(`(()=>{
   const stage=document.querySelector('.file-unsupported')?.getBoundingClientRect();
   const dock=document.querySelector('.file-unsupported .preview-reader-dock')?.getBoundingClientRect();
   return {bottom:stage&&dock?Math.round(stage.bottom-dock.bottom):null,
    actionCount:document.querySelectorAll('.file-unsupported .preview-reader-dock button').length,
    topActions:document.querySelectorAll('.file-preview-action-dock .file-workbench-actions>button').length};
  })()`);
  assert("CAD fallback uses one bottom refresh control and upper-right file actions",
   Boolean(ready)&&ui.bottom!==null&&ui.bottom>=0&&ui.bottom<55&&ui.actionCount===1&&ui.topActions===3,
   JSON.stringify(ui));
 }


}finally{
 cdp?.close();chrome.kill("SIGKILL");
}
const failed=checks.filter(([,ok])=>!ok);
console.log("SIGNING_WORKBENCH_BROWSER_"+(failed.length?"FAIL":"PASS")+" "+(checks.length-failed.length)+"/"+checks.length);
if(failed.length)process.exitCode=1;
