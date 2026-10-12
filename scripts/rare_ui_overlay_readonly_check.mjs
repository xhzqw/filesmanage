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
const browserExceptions=[];
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
  if(response.method==="Runtime.exceptionThrown")browserExceptions.push({
   text:response.params?.exceptionDetails?.text,
   description:response.params?.exceptionDetails?.exception?.description?.slice(0,650)});
  if(!pending)return;
  requests.delete(response.id);
  clearTimeout(pending.timer);
  response.error?pending.reject(Error(response.error.message)):pending.resolve(response.result);
 });
 await send("Page.enable");await send("Runtime.enable");
 await navigate("/login","!!document.querySelector('input[type=password]')");
 const password=readFileSync(".secrets/admin.password","utf8").trim();
 assert.equal(await evalJS(`(async()=>{const response=await fetch("/api/login",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({login:"admin",password:${JSON.stringify(password)}})});return response.ok;})()`),true);
 if(process.env.PDF_FIT_ONLY==="1"){
  const fixture=await evalJS(`(async()=>{
   for(const params of ["category=pdf&scope=all&limit=100","q=pdf&scope=all&limit=100","type=pdf&scope=all&limit=100"]){
    const response=await fetch("/api/search?"+params,{credentials:"same-origin"});
    if(!response.ok)continue;
    const data=await response.json();
    const file=(data.data?.items??data.items)?.find(item=>String(item.name).toLowerCase().endsWith(".pdf"));
    if(file)return file.id;
   }
   // The search index may not include older seeded documents. Walk readable
   // directories without modifying any file or retaining a server-side probe.
   const foldersResponse=await fetch("/api/folders/tree",{credentials:"same-origin"});
   if(foldersResponse.ok){
    const folders=await foldersResponse.json();
    for(const folder of Array.isArray(folders.data??folders)?(folders.data??folders):[]){
     const response=await fetch("/api/files?"+new URLSearchParams({folder:folder.id,sort:"updated_desc",limit:"100"}),{credentials:"same-origin"});
     if(!response.ok)continue;
     const data=await response.json();
     const file=(data.data?.items??data.items)?.find(item=>String(item.name).toLowerCase().endsWith(".pdf"));
     if(file)return file.id;
    }
   }
   return null;
  })()`);
  assert(fixture,"PDF viewport regression needs one accessible PDF fixture");
  const checked=[];
  for(const width of [1440,900,390]){
   await viewport(width,width===390?760:900);
   await navigate("/preview/"+encodeURIComponent(fixture),'!!document.querySelector(".file-pdf-viewer")');
   await waitFor('!!document.querySelector(".file-pdf-paper img.file-pdf-image:not(.is-pending)")?.naturalWidth');
   const measure=()=>evalJS(`(()=>{
    const area=document.querySelector(".file-pdf-paper[data-fit-mode]"),img=area?.querySelector("img.file-pdf-image:not(.is-pending)");
    if(!area||!img)return null;
    const s=getComputedStyle(area),r=img.getBoundingClientRect(),a=area.getBoundingClientRect();
    const availableWidth=area.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight)-12;
    const availableHeight=area.clientHeight-parseFloat(s.paddingTop)-parseFloat(s.paddingBottom)-12;
    return {mode:area.dataset.fitMode,width:r.width,height:r.height,expectedRatio:img.naturalHeight/img.naturalWidth,
      maxWidth:availableWidth,maxHeight:availableHeight,viewportWidth:a.width,
      overflow:document.documentElement.scrollWidth-innerWidth};
   })()`);
   const readLayout=async mode=>{
    for(let attempt=0;attempt<120;attempt++){
     const result=await measure();
     if(result&&result.mode===mode&&result.width>0)return result;
     await sleep(140);
    }
    const state=await evalJS(`(()=>({papers:[...document.querySelectorAll(".file-pdf-paper")].map(p=>({mode:p.dataset.fitMode,busy:p.getAttribute("aria-busy"),images:[...p.querySelectorAll("img")].map(i=>({pending:i.classList.contains("is-pending"),complete:i.complete,naturalWidth:i.naturalWidth}))})),viewport:innerWidth}))()`);
    throw Error("PDF image did not settle in "+mode+" mode at "+width+"px: "+JSON.stringify(state));
   };
   const initial=await readLayout("page");
   console.log("PDF_STAGE",width,"default",JSON.stringify(initial));
   assert(initial.mode==="page"&&initial.width<=initial.maxWidth+2&&initial.height<=initial.maxHeight+2&&
    Math.abs(initial.height/initial.width-initial.expectedRatio)<.02&&initial.overflow<=1,
    "PDF default whole-page fit and natural ratio at "+width+": "+JSON.stringify(initial));
   await evalJS(`(()=>{const button=document.querySelector('.file-pdf-tools button[aria-label="放大 PDF"]');if(!button)throw Error("missing PDF zoom control");button.click();return true})()`);
   await waitFor('document.querySelector(".file-pdf-zoom-value")?.textContent?.trim()==="125%"');
   const enlarged=await readLayout("page");
   console.log("PDF_STAGE",width,"zoom",JSON.stringify(enlarged));
   // Scrollbars can slightly reduce the available fit base after zoom.
   assert(enlarged.width>initial.width*1.15&&Math.abs(enlarged.height/enlarged.width-enlarged.expectedRatio)<.02,
    "PDF zoom preserves aspect ratio at "+width+": "+JSON.stringify(enlarged));
   const toggle=await evalJS(`(()=>{document.querySelector('.file-pdf-tools button[aria-label^="PDF 适配方式"]')?.click();return true})()`);
   assert(toggle,"PDF fit toggle exists");
   await waitFor('document.querySelector(".file-pdf-paper")?.dataset.fitMode==="width" && !!document.querySelector(".file-pdf-paper img.file-pdf-image:not(.is-pending)")?.naturalWidth');
   const fullWidth=await readLayout("width");
   console.log("PDF_STAGE",width,"width",JSON.stringify(fullWidth));
   assert(fullWidth&&Math.abs(fullWidth.width-fullWidth.maxWidth)<2&&Math.abs(fullWidth.height/fullWidth.width-fullWidth.expectedRatio)<.02,
    "PDF fit-width preserves ratio at "+width+": "+JSON.stringify(fullWidth));
   checked.push(width+"px");
  }
  console.log("PDF_FIT_READONLY_PASS "+checked.join(", ")+"; default page, intrinsic ratio, zoom, width fit");
 }else if(process.env.TITLES_ONLY==="1"){
  const pages=[
   ["/stats",".stats-workbench"],
   ["/doc?view=favorites",".collab-root"],
   ["/org",".work-body"],
   ["/lifecycle",".lifecycle-ledger"],
   ["/trash",".trash-workbench"],
   ["/account/sessions",".sessions-page"],
   ["/approvals",".approval-root-switch"],
   ["/search",".search-page"]
  ];
  const verified=[];
  for(const width of [1440,900,390]){
   await viewport(width,width===390?760:900);
   for(const [route,content] of pages){
    await navigate(route,`!!document.querySelector(${JSON.stringify(content)})`);
    const layout=await evalJS(`(()=>{
     const main=document.querySelector("main.work");
     const first=main?.firstElementChild,content=document.querySelector(${JSON.stringify(content)});
     const m=main?.getBoundingClientRect(),f=first?.getBoundingClientRect();
     return {
      first:first?.className,visible:!!content&&content.getBoundingClientRect().height>0,
      redundant:!!main?.querySelector(":scope > .breadcrumb, :scope > .crumb-bar, :scope > .trash-heading"),
      topGap:m&&f?Math.round(f.top-m.top):null,
      trashRefresh:!!document.querySelector(".trash-filters .trash-refresh"),
      sessionBack:!!document.querySelector(".sessions-heading .sessions-back")
     };
    })()`);
    assert(layout.visible&&!layout.redundant&&layout.topGap!==null&&layout.topGap<=12,
     "no title-only second row at "+route+" "+width+": "+JSON.stringify(layout));
    if(route==="/trash")assert(layout.trashRefresh,"trash refresh must share the filter row");
    if(route==="/account/sessions")assert(layout.sessionBack,"account back link must remain in heading actions");
    verified.push(route+"@"+width);
   }
   await navigate("/doc",'!!document.querySelector(".folder-context-bar nav.breadcrumb")');
   assert.equal(await evalJS('!!document.querySelector(".folder-context-bar nav.breadcrumb a")'),true,
    "the navigable folder-path breadcrumb must survive");
  }
  console.log("PAGE_TITLE_ROWS_READONLY_PASS "+verified.length+" routes/width checks, functional folder path preserved");
 }else if(process.env.ROLES_ONLY==="1"){
  const checked=[];
  for(const width of [1440,900,390]){
   await viewport(width,width===390?760:900);
   await navigate("/org?tab=roles",'!!document.querySelector(".org-role-create")');
   await waitFor('!!document.querySelector(".org-role-empty")||!!document.querySelector(".org-role-table")');
   const surface=await evalJS(`(()=>{const root=document.querySelector(".org-role-workbench"),
    bar=root.querySelector(".org-role-topbar"),roles=root.querySelector(".org-role-catalog"),
    table=root.querySelector(".org-role-table"),empty=root.querySelector(".org-role-empty");
    return{empty:!!empty,table:!!table,editor:!!root.querySelector(".org-role-editor"),
     trigger:root.querySelectorAll(".org-role-create").length,
     explanations:roles?.querySelectorAll(".org-role-intro-item").length,
     overflow:document.documentElement.scrollWidth-innerWidth,
     rolesWidth:roles?.getBoundingClientRect().width,barWidth:bar?.getBoundingClientRect().width};})()`);
   assert(surface.trigger===1&&surface.explanations===2&&!surface.editor&&surface.overflow<=1,
    "role list has one action, two meaningful descriptions and no persistent form: "+JSON.stringify(surface));
   if(surface.empty)assert(!surface.table,"empty role list must not render a full table");
   await click(".org-role-create");
   await waitFor('!!document.querySelector("dialog.org-role-dialog:modal .org-role-editor")');
   const modal=await evalJS(`(()=>{const d=document.querySelector("dialog.org-role-dialog:modal"),
    r=d.getBoundingClientRect();return{role:!!d.querySelector('[aria-label="选择管理职责"]'),
     subject:!!d.querySelector('[aria-label="选择接受管理职责的成员"]'),
     actions:d.querySelectorAll(".permission-action-picker").length,
     review:d.querySelector(".perm-review")?.textContent?.trim(),
     rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom}};})()`);
   assert(modal.role&&modal.subject&&modal.actions===0
    &&inside(modal.rect,width,width===390?760:900),
    "clean modal for an audit-only role: "+JSON.stringify(modal));
   if(width===1440||width===900||width===390){
    await click('.org-role-editor .perm-form-row>label:nth-child(2) .rare-select');
    await waitFor('!!document.querySelector(".rare-select-menu [role=option]")');
    const popup=await evalJS(`(()=>{const dialog=document.querySelector('dialog.org-role-dialog'),m=dialog.querySelector('.rare-select-menu'),
      b=dialog.querySelector('.perm-form-row>label:nth-child(2) .rare-select'),
      option=[...m.querySelectorAll('[role=option]')].find(x=>x.textContent.includes('目录权限管理员'));
      if(!option)throw Error('role missing');
      const mr=m.getBoundingClientRect(),br=b.getBoundingClientRect(),or=option.getBoundingClientRect(),dr=dialog.getBoundingClientRect();
      const hit=document.elementFromPoint(or.x+or.width/2,or.y+or.height/2);
      return{menu:{x:mr.x,y:mr.y,w:mr.width,h:mr.height},btn:{x:br.x,y:br.y},option:{x:or.x,y:or.y,w:or.width,h:or.height},
        dialog:{x:dr.x,y:dr.y,w:dr.width,h:dr.height,scrollLeft:dialog.scrollLeft,scrollTop:dialog.scrollTop},
        hit:hit?.outerHTML?.slice(0,160),style:getComputedStyle(m).position};})()`);
    assert(popup.hit?.includes('role="option"')||popup.hit?.includes('rare-select-option'),
     "role popup option must be the real mouse hit target at "+width+": "+JSON.stringify(popup));
    await click('.rare-select-menu [role=option]:last-child');
    await waitFor('!!document.querySelector(".org-role-editor .permission-action-picker")');
    assert.equal(await evalJS('document.querySelectorAll(".org-role-editor .permission-action-picker input[type=checkbox]").length'),9);
    await click('.org-role-editor .perm-form-row:first-child label:first-child .rare-select');
    await waitFor('!!document.querySelector(".rare-select-menu [role=option]")');
    const firstMember=await evalJS(`(()=>{const m=document.querySelector('.rare-select-menu'),items=[...m.querySelectorAll('[role=option]:not(:disabled)')].filter(x=>x.textContent.trim()&&!x.textContent.includes('选择成员'));
     const e=items[0],r=e?.getBoundingClientRect();
     return{count:items.length,rect:r&&{x:r.x,y:r.y,w:r.width,h:r.height},
      hit:r?document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML?.slice(0,180):null};})()`);
    assert(firstMember.count>0&&firstMember.rect,
     "there must be a selectable member in the real user directory: "+JSON.stringify(firstMember));
    const memberIndex=await evalJS(`(()=>[...document.querySelectorAll('.rare-select-menu [role=option]')].findIndex(x=>!x.disabled&&x.textContent.trim()&&!x.textContent.includes('选择成员')))()`);
    await click('.rare-select-menu [role=option]:nth-child('+(memberIndex+1)+')');
    await waitFor(`document.querySelector('.org-role-editor .perm-form-row:first-child label:first-child .rare-select')?.textContent.includes('（')`);
    assert.equal(await evalJS('document.querySelector(".org-role-editor button[type=submit]")?.disabled'),true,
     "delegation must still require a folder scope for directory permission administrator");
    await waitFor(`[...document.querySelectorAll('.org-role-editor .perm-form-row label')].some(x=>x.textContent.startsWith('管理范围')&&x.querySelector('.rare-select:not(:disabled)'))`);
    const scopeSelector='.org-role-editor .perm-form-row:nth-of-type(2)>label:nth-child(2) .rare-select';
    await evalJS(`(()=>{document.querySelector(${JSON.stringify(scopeSelector)})?.scrollIntoView({block:'center',inline:'nearest'});return true})()`);
    await click(scopeSelector);
    await waitFor('!!document.querySelector(".rare-select-menu [role=option]")');
    const folderOptions=await evalJS(`(()=>[...document.querySelectorAll('.rare-select-menu [role=option]')].filter(x=>!x.disabled&&!x.textContent.includes('请选择目录')&&!x.textContent.includes('正在读取')).length)()`);
    if(folderOptions>0){
     await click('.rare-select-menu [role=option]:nth-child(2)');
     await waitFor('!document.querySelector(".org-role-editor button[type=submit]")?.disabled');
     const submitBefore=await evalJS(`(()=>{const form=document.querySelector('.org-role-editor form'),btn=form.querySelector('button[type=submit]'),
      r=btn.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      return{valid:form.checkValidity(),targeted:btn.contains(hit),visible:r.top>=0&&r.bottom<=innerHeight,disabled:btn.disabled};})()`);
     assert(submitBefore.valid&&submitBefore.targeted&&submitBefore.visible&&!submitBefore.disabled,
      "delegation review must be visible, valid and actually clickable without scrolling at "+width+": "+JSON.stringify(submitBefore));
     await click('.org-role-editor button[type=submit]');
     await waitFor('!!document.querySelector(".org-role-editor .org-role-review")');
     const submitAfter=await evalJS(`(()=>{const b=document.querySelector('.org-role-editor button[type=submit]'),r=b.getBoundingClientRect();
      return{targeted:b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),
       visible:r.top>=0&&r.bottom<=innerHeight};})()`);
     assert(submitAfter.targeted&&submitAfter.visible,"confirm step stays visible and clickable at "+width+": "+JSON.stringify(submitAfter));
     assert.equal(await evalJS('document.querySelector(".org-role-editor button[type=submit]")?.textContent.trim()'),"确认委派");
     // Never click the second-step confirmation: this browser test must remain
     // read-only even though it exercises a fully valid selection.
    }else{
     await click(scopeSelector);
    }
   }
   await click("dialog.org-role-dialog .dialog-close");
   await waitFor('!document.querySelector("dialog.org-role-dialog")');
   assert.equal(await evalJS('document.activeElement?.classList.contains("org-role-create")'),true,"role dialog restores focus");
   checked.push(width+"px: role list/dialog/selection PASS");
  }
  console.log("ROLE_WORKBENCH_READONLY_PASS "+checked.join("; "));
 }else{
 const explorerOnly=process.env.EXPLORER_ONLY==="1";
 const shellOnly=process.env.SHELL_ONLY==="1";
 const results=[];
 let availablePreviewId="";
 for(const width of (explorerOnly?[1440,820,390]:shellOnly?[2048,1920,1440,1280,1220,900,390]:[1440,1280,1220,900,390])){
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
  assert.deepEqual(shellNav.labels,["文档管理","全局搜索","统计","审批","回收站","组织与权限"],
   "all six enabled global Rare UI navigation links");
  assert(shellNav.count===6&&shellNav.active.length===1&&shellNav.active[0]==="文档管理"&&shellNav.overflow<=1,
   "Rare shell nav selection/layout at "+width+": "+JSON.stringify(shellNav));
  const capsules=await evalJS("(()=>{const h=document.querySelector('header.header'),b=h.querySelector('a.shell-home-pill'),n=h.querySelector('nav[data-appearance=pill]'),hr=h.getBoundingClientRect(),br=b.getBoundingClientRect(),nr=n.getBoundingClientRect(),logo=b.querySelector('img'),active=n.querySelector('.rare-pill-nav-active');return{home:b.getAttribute('href'),brand:b.innerText.trim(),pill:getComputedStyle(b).borderRadius,offset:Math.abs((nr.left+nr.right-hr.left-hr.right)/2),headerBg:getComputedStyle(h).backgroundColor,brandBg:getComputedStyle(b).backgroundColor,navBg:getComputedStyle(n).backgroundColor,selectedBg:active&&getComputedStyle(active).backgroundColor,transparentLogo:logo.currentSrc.endsWith('logo-loader-256.png'),headerWidth:hr.width,brandLeft:br.left,headerLeft:hr.left,headerRight:hr.right}})()");
  assert(capsules.home==="/doc"&&capsules.brand==="中晟生物"&&capsules.pill.endsWith("px")
   &&capsules.brandBg==="rgb(255, 255, 255)"&&capsules.navBg==="rgb(237, 242, 250)"
   &&capsules.selectedBg==="rgb(23, 64, 152)"&&capsules.transparentLogo
   &&capsules.headerWidth>=width-30&&capsules.brandLeft<=24,
   "independent brand home capsule at "+width+": "+JSON.stringify(capsules));
  const utility=await evalJS("(()=>{const h=document.querySelector('header.header'),d=h.querySelector('.global-utility-dock'),b=h.querySelector('.shell-home-pill'),toggle=h.querySelector('.nav-toggle'),btns=[...d.querySelectorAll('.command-trigger,.notification-trigger,.account-trigger')],r=d.getBoundingClientRect(),br=b.getBoundingClientRect(),tr=toggle.getBoundingClientRect(),icons=[d.querySelector('.command-trigger svg'),d.querySelector('.notification-trigger svg'),d.querySelector('.account-avatar svg')],badge=d.querySelector('.rare-notification-bell-badge'),bell=d.querySelector('.notification-trigger').getBoundingClientRect(),badger=badge?.getBoundingClientRect();return{left:r.left,right:r.right,brandRight:br.right,toggleLeft:tr.left,allButtonsVisible:btns.every(x=>{const q=x.getBoundingClientRect();return q.width>=35&&q.left>=r.left-1&&q.right<=r.right+1}),dimensions:btns.map(x=>{const q=x.getBoundingClientRect();return{width:Math.round(q.width),height:Math.round(q.height)}}),badgeInside:!badger||(badger.left>=bell.left-1&&badger.top>=bell.top-1&&badger.right<=bell.right+1),iconSizes:icons.map(i=>i?Math.round(i.getBoundingClientRect().width):0),overlapsBrand:r.left<br.right-1,documentOverflow:document.documentElement.scrollWidth-innerWidth}})()");
  assert(!utility.overlapsBrand&&utility.right<=width-2&&utility.documentOverflow<=1
   &&utility.allButtonsVisible&&utility.iconSizes.every(x=>x>=17)
   &&utility.dimensions.every(x=>x.height===36)
   &&utility.dimensions[0].width===36&&utility.dimensions[1].width===36
   &&utility.dimensions[2].width<=154&&utility.badgeInside
   &&width-utility.right<=24,
   "right utility buttons and icons must stay aligned inside the viewport at "+width+": "+JSON.stringify(utility));
  if(width>1210){
   assert(shellNav.rendered!=="none"&&shellNav.lastRight<=shellNav.rightStart+2,
    "desktop GooeyNav fits before header actions at "+width+": "+JSON.stringify(shellNav));
   assert(capsules.offset<=3&&capsules.headerBg==="rgba(0, 0, 0, 0)",
    "header has centered navigation and no full-width backplate at "+width+": "+JSON.stringify(capsules));
   await evalJS(`(()=>document.querySelector('header.header nav[data-slot="gooey-nav"] a')?.focus())()`);
   await key("ArrowRight","ArrowRight",39);
   assert.equal(await evalJS("document.activeElement?.getAttribute('href')"),"/search","arrow moves focus between Rare navigation links");
   const navHit=await evalJS("(()=>{const a=document.querySelector('header.header nav a[href$=search]'),r=a.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,e=document.elementFromPoint(x,y);return{rect:{x,y,width:r.width,height:r.height},hit:e?.outerHTML?.slice(0,260),linkHit:a.contains(e),pointerEvents:getComputedStyle(a).pointerEvents,navZ:getComputedStyle(a.closest('nav')).zIndex}})()");
   assert(navHit.linkHit,"top nav target must receive real pointer clicks: "+JSON.stringify(navHit));
   console.log("NAV_TRACE",width,"desktop",JSON.stringify(navHit));
   await click('header.header nav[data-slot="gooey-nav"] a[href="/search"]');
   console.log("NAV_AFTER_CLICK",width,await evalJS("location.pathname"));
   await waitFor('location.pathname==="/search"');
   await click("a.shell-home-pill");
   await waitFor('location.pathname==="/doc"');
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
   const mobileHit=await evalJS("(()=>{const a=document.querySelector('header.header nav a[href$=search]'),r=a.getBoundingClientRect(),e=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return{linkHit:a.contains(e),hit:e?.outerHTML?.slice(0,220),left:r.left,top:r.top}})()");
   assert(mobileHit.linkHit,"collapsed navigation must be clickable above workbench at "+width+": "+JSON.stringify(mobileHit));
   await click('header.header nav[data-slot="gooey-nav"] a[href="/search"]');
   console.log("NAV_AFTER_CLICK",width,await evalJS("location.pathname"));
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
  if(shellOnly){results.push(width+"px: branded pills, utility geometry, nav click, account menu PASS");continue;}
  await waitFor('!!document.querySelector(".file-toolbar")');
  const explorer=await evalJS(`(()=>{const panel=document.querySelector(".panels.document-explorer"),
   sidebar=panel?.querySelector(".finder-sidebar"),work=panel?.querySelector(".work"),
   navigation=sidebar?.querySelector('nav[aria-label="文档位置与共享"]'),
   all=sidebar?.querySelector('.finder-nav-item[href="/doc"]'),
   favorite=sidebar?.querySelector('.finder-nav-item[href="/doc?view=favorites"]'),
   received=sidebar?.querySelector('.finder-nav-item[href="/doc?view=received"]'),
   sent=sidebar?.querySelector('.finder-nav-item[href="/doc?view=sent"]');
   if(!panel||!sidebar||!work||!navigation||!all||!favorite||!received||!sent)return null;
   const a=sidebar.getBoundingClientRect(),b=work.getBoundingClientRect(),
    items=[all,favorite,received,sent],selected=getComputedStyle(all).backgroundColor;
   return{navLabels:items.map(x=>x.textContent.trim()),selected:all.getAttribute('aria-current'),
    selectedBg:selected,treeRemoved:!sidebar.querySelector(".tree,.tree-search"),
    clickTargets:items.every(x=>{const r=x.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return x.contains(hit)}),
    sideInside:a.left>=-1&&a.right<=innerWidth+1,mainInside:b.left>=-1&&b.right<=innerWidth+1,
    adjacent:a.right<=b.left+1,gap:b.left-a.right,overflow:document.documentElement.scrollWidth-innerWidth};})()`);
  assert(explorer&&explorer.treeRemoved&&explorer.navLabels.join("|")==="全部文档|我的关注|与我共享|我共享的"
   &&explorer.selected==="page"&&explorer.selectedBg!=="rgba(0, 0, 0, 0)"
   &&explorer.clickTargets&&explorer.sideInside&&explorer.mainInside&&explorer.adjacent&&explorer.overflow<=1,
   "Finder document sidebar, selected nav and real pointer targets at "+width+": "+JSON.stringify(explorer));
  if(width===1440){
   await click('.finder-nav-item[href="/doc?view=favorites"]');
   await waitFor('location.pathname==="/doc" && new URLSearchParams(location.search).get("view")==="favorites"');
   await waitFor('!!document.querySelector(".collab-results")');
   await click('.finder-nav-item[href="/doc"]');
   await waitFor('location.pathname==="/doc" && location.search===""');
  }
  if(explorerOnly){results.push(width+"px: Finder sidebar navigation and hit targets OK");continue;}
  // The complete grant workflow and file-manager quick grant share the same
  // nine-choice picker and subject/scope controls; editing here is local only.
  if((width===1440||width===390)&&await evalJS('!!document.querySelector(".folder-actions .ghost-action-btn")')){
   await evalJS('(()=>{document.querySelector(".folder-actions .ghost-action-btn").click();return true})()');
   await waitFor('!!document.querySelector("dialog.quick-grants-dialog:modal .permission-action-picker")');
   const quick=await evalJS(`(()=>{const d=document.querySelector("dialog.quick-grants-dialog:modal");
    const r=d.getBoundingClientRect();return{
     options:d.querySelectorAll(".permission-action-options input[type=checkbox]").length,
     pickers:d.querySelectorAll(".permission-action-picker").length,
     selected:d.querySelectorAll(".permission-action-options input:checked").length,
     subjectFields:d.querySelectorAll(".quick-grants-fields").length,
     closeIcons:d.querySelectorAll(".dialog-close").length,
     redundantClose:d.querySelectorAll(".quick-grants-close").length,
     rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},
     overflow:document.documentElement.scrollWidth-innerWidth};})()`);
   assert(quick.options===9&&quick.pickers===1&&quick.selected===1&&quick.subjectFields===2
    &&quick.closeIcons===1&&quick.redundantClose===0&&quick.overflow<=1
    &&inside(quick.rect,width,height),"unified quick grant, no duplicate close at "+width+": "+JSON.stringify(quick));
   await evalJS('(()=>{document.querySelector("dialog.quick-grants-dialog .permission-action-tools button").click();return true})()');
   await waitFor('document.querySelectorAll("dialog.quick-grants-dialog .permission-action-options input:checked").length===2');
   await evalJS('(()=>{document.querySelector("dialog.quick-grants-dialog .dialog-close").click();return true})()');
   await waitFor('!document.querySelector("dialog.quick-grants-dialog:modal")');
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
  const beforeTimeSelect=await evalJS("(()=>{const b=document.querySelector('.rare-select[aria-label=修改时间]');const r=b.getBoundingClientRect();return{width:r.width,height:r.height,visible:getComputedStyle(b).display!=='none'}})()");
  assert(beforeTimeSelect.visible&&beforeTimeSelect.width>=90&&beforeTimeSelect.height>=24,
   "stats filter must remain operable in narrow viewports at "+width+": "+JSON.stringify(beforeTimeSelect));
  await evalJS("(()=>{document.querySelector('.rare-select[aria-label=修改时间]').scrollIntoView({block:'center',inline:'nearest'});return true})()");
  await click('.rare-select[aria-label="修改时间"]');
  await waitFor('!!document.querySelector(".rare-select-menu [role=option]")');
  const select=await evalJS(`(()=>{const b=document.querySelector('.rare-select[aria-label="修改时间"]');const m=document.querySelector(".rare-select-menu");const r=m.getBoundingClientRect();return{role:b.getAttribute("role"),expanded:b.getAttribute("aria-expanded"),count:m.querySelectorAll('[role=option]').length,rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},overflow:document.documentElement.scrollWidth-innerWidth};})()`);
  assert(select.role==="combobox"&&select.expanded==="true"&&select.count>=3&&inside(select.rect,width,height)&&select.overflow<=1,"time dropdown at "+width+": "+JSON.stringify(select));
  await click('.rare-select-menu [role="option"]:nth-child(2)');
  assert.equal(await evalJS(`document.querySelector('.rare-select[aria-label="修改时间"]').getAttribute("aria-expanded")`),"false");
  const metrics=await evalJS(`(()=>({count:document.querySelectorAll(".stats-metric").length,
   buttons:[...document.querySelectorAll('.stats-metric [data-slot="gooey-nav-item"]')].map(x=>x.textContent.trim())}))()`);
  assert(metrics.count===1&&metrics.buttons.join(",")==="数量,容量",
   "one shared statistics metric switch at "+width+": "+JSON.stringify(metrics));
  await click('.stats-metric [data-slot="gooey-nav-item"]:nth-child(2)');
  await waitFor(`document.querySelector('.stats-metric [data-slot="gooey-nav-item"]:nth-child(2)')?.getAttribute("aria-current")==="page"`);
  if(width===1440||width===390){
   await click(".stats-folder-trigger");
   await waitFor('!!document.querySelector("dialog:modal .folder-picker-tree")');
   const picker=await evalJS(`(()=>{const d=document.querySelector("dialog:modal"),r=d.getBoundingClientRect();
    const tree=d.querySelector(".folder-picker-tree");return{tree:!!tree,border:getComputedStyle(tree).borderWidth,
     dialog:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},overflow:document.documentElement.scrollWidth-innerWidth};})()`);
   assert(picker.tree&&picker.border==="0px"&&picker.overflow<=1&&inside(picker.dialog,width,height),
    "flat shared folder picker at "+width+": "+JSON.stringify(picker));
   await evalJS('(()=>{document.querySelector("dialog:modal .dialog-close").click();return true})()');
   await waitFor('!document.querySelector("dialog:modal")');
  }
  results.push(width+"px: global Gooey nav / menu / combobox OK");
 }
 if(!shellOnly){
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
 // Directory grant must have exactly one primary create/back action and one
 // shared ACL fieldset. Interactions are reverted; never submit permissions.
 if(await evalJS('!!document.querySelector(".perm-create-trigger")')){
  await evalJS('(()=>{document.querySelector(".perm-create-trigger").click();return true})()');
  await waitFor('!!document.querySelector(".perm-create-view .permission-action-picker")');
  const grantPicker=await evalJS(`(()=>({count:document.querySelectorAll(".perm-create-view .permission-action-picker").length,
   choices:document.querySelectorAll(".perm-create-view .permission-action-options input[type=checkbox]").length,
   selected:document.querySelectorAll(".perm-create-view .permission-action-options input:checked").length,
   creates:[...document.querySelectorAll(".perm-create-view button")].filter(x=>x.textContent.includes("新增授权")).length,
   back:document.querySelector(".perm-create-trigger")?.textContent.trim()}))()`);
  assert(grantPicker.count===1&&grantPicker.choices===9&&grantPicker.selected===1&&grantPicker.creates===0&&grantPicker.back==="返回授权列表",
   "single low-noise directory grant editor: "+JSON.stringify(grantPicker));
  await evalJS('(()=>{document.querySelector(".perm-create-view .permission-action-tools button").click();return true})()');
  await waitFor('document.querySelectorAll(".perm-create-view .permission-action-options input:checked").length===2');
  await evalJS(`(()=>{const preview=[...document.querySelectorAll(".perm-create-view .permission-action-options label")].find(x=>x.textContent.trim()==="预览");if(!preview)throw Error("preview ACL action missing");preview.querySelector("input").click();return true})()`);
  await waitFor('document.querySelectorAll(".perm-create-view .permission-action-options input:checked").length===1');
  await evalJS('(()=>{document.querySelector(".perm-create-trigger").click();return true})()');
  await waitFor('!document.querySelector(".perm-create-view")');
  assert.equal(await evalJS('document.querySelectorAll(".perm-empty-grants button").length'),0,
   "empty authorization table does not duplicate create entry");
 }
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
 for(const width of [1440,900,390]){
  await viewport(width,width===390?760:900);
  await navigate("/org?tab=roles",'!!document.querySelector(".org-role-create")');
  await waitFor('!!document.querySelector(".org-role-catalog")');
  const roles=await evalJS(`(()=>{const root=document.querySelector(".org-role-workbench"),empty=root.querySelector(".org-role-empty"),
   table=root.querySelector(".org-role-table"),btn=root.querySelector(".org-role-create"),r=root.getBoundingClientRect();
   return{descriptions:[...root.querySelectorAll(".org-role-intro-item strong")].map(x=>x.textContent.trim()),
    empty:!!empty,table:!!table,editor:!!root.querySelector(".org-role-editor"),
    create:btn?.textContent.trim(),overflow:document.documentElement.scrollWidth-innerWidth,
    rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom}};})()`);
  assert(roles.descriptions.join(",")==="只读审计员,目录权限管理员"&&roles.create==="委派角色"
   &&!roles.editor&&roles.overflow<=1,"clear role surface at "+width+": "+JSON.stringify(roles));
  if(roles.empty)assert(!roles.table,"empty delegations must never show a six-column blank table");
  await click(".org-role-create");
  await waitFor('!!document.querySelector("dialog.org-role-dialog:modal .org-role-editor")');
  const modal=await evalJS(`(()=>{const d=document.querySelector("dialog.org-role-dialog:modal"),r=d.getBoundingClientRect();
   return{subject:!!d.querySelector('[aria-label="选择接受管理职责的成员"]'),
    role:!!d.querySelector('[aria-label="选择管理职责"]'),
    submit:d.querySelector('button[type=submit]')?.textContent.trim(),
    noExtraHeading:!d.querySelector(".perm-section-title"),
    rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom}};})()`);
  assert(modal.subject&&modal.role&&modal.submit==="核对委派"&&modal.noExtraHeading
   &&inside(modal.rect,width,width===390?760:900),"role modal accessible and contained at "+width+": "+JSON.stringify(modal));
  await click("dialog.org-role-dialog .dialog-close");
  await waitFor('!document.querySelector("dialog.org-role-dialog")');
  assert.equal(await evalJS('document.activeElement?.classList.contains("org-role-create")'),true,
   "role dialog close restores trigger");
  results.push(width+"px: concise role catalog / modal / empty state OK");
 }
 await viewport(1440,900);
 console.log("RARE_ROLE_CHECK navigating to role editor");
 await navigate("/org?tab=roles",'!!document.querySelector(".org-role-create")');
 await click(".org-role-create");
 await waitFor('!!document.querySelector("dialog.org-role-dialog:modal .org-role-editor")');
 console.log("RARE_ROLE_CHECK opening role selector");
 await evalJS(`(()=>{const select=document.querySelector(".org-role-editor .perm-form-row>label:nth-child(2) .rare-select");
  if(!select)throw Error("role combobox missing");
  select.scrollIntoView({block:"center",inline:"nearest"});select.click();
  return true;})()`);
 await waitFor(`document.querySelector('.org-role-editor .perm-form-row>label:nth-child(2) .rare-select')?.getAttribute("aria-expanded")==="true"`);
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
 // Restore the pristine editor state before navigating. An unsaved delegation
 // intentionally triggers the app's beforeunload protection, which would
 // block a low-level Chrome Page.navigate command.
 await evalJS(`(()=>{const browse=document.querySelector(".org-role-editor .perm-action-grid input[type=checkbox]");
  if(!browse)throw Error("browse ACL checkbox missing");browse.click();return true})()`);
 await waitFor(`[...document.querySelectorAll(".org-role-editor .perm-action-grid input[type=checkbox]")].filter(x=>x.checked).length===1`);
 await evalJS(`(()=>{document.querySelector(".org-role-editor .perm-form-row>label:nth-child(2) .rare-select")?.click();return true})()`);
 await waitFor('!!document.querySelector(".rare-select-menu [role=option]")');
 await evalJS(`(()=>{const option=[...document.querySelectorAll(".rare-select-menu [role=option]")].find(x=>x.textContent.includes("只读审计员"));if(!option)throw Error("auditor role missing");option.click();return true})()`);
 await waitFor(`document.querySelector(".org-role-editor .perm-form-row>label:nth-child(2) .rare-select")?.textContent.includes("只读审计员")`);
 await click("dialog.org-role-dialog .dialog-close");
 await waitFor('!document.querySelector("dialog.org-role-dialog")');
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
 console.log(explorerOnly?"EXPLORER_GEOMETRY_PASS "+results.join("; "):"RARE_OVERLAY_READONLY_PASS "+results.join("; ")+"; file grid, permission Gooey, dialog and focus OK"+(availablePreviewId?"":"; preview fixture absent"));
 }
 if(shellOnly)console.log("SHELL_HEADER_READONLY_PASS "+results.join("; "));
 }
}catch(error){
 console.error("RARE_OVERLAY_READONLY_FAIL",error.message);
 if(browserExceptions.length)console.error("RARE_OVERLAY_BROWSER_EXCEPTIONS",JSON.stringify(browserExceptions.slice(-3)));
 try{
  const snapshot=await evalJS(`(()=>({url:location.href,ready:document.readyState,
   title:document.title,body:document.body.innerText.slice(0,450),
   stats:!!document.querySelector(".stats-workbench"),selects:document.querySelectorAll(".rare-select").length}))()`);
  console.error("RARE_OVERLAY_BROWSER_STATE",JSON.stringify(snapshot));
 }catch(snapshotError){console.error("RARE_OVERLAY_BROWSER_STATE_UNAVAILABLE",snapshotError.message);}
 process.exitCode=1;
}
finally{ws?.close();chrome.kill("SIGTERM");}
