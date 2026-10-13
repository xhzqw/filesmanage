#!/usr/bin/env node
// Visual System V3: computed-style regression on the *real remote UI*.
// Headless Chrome runs only on the target host; local repo never runs services.
import {spawn} from "node:child_process";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {assertIsolatedFixtures} from "./ux_fixture_guard.mjs";

const BASE=(process.env.FILESMANAGE_BASE||"http://127.0.0.1:18091").replace(/\/$/,"");
if(!["127.0.0.1","localhost","::1"].includes(new URL(BASE).hostname)){
 throw Error("geometry acceptance only runs against the target host loopback");
}
assertIsolatedFixtures({base:BASE,args:process.argv.slice(2),explicitBase:Boolean(process.env.FILESMANAGE_BASE)});
const password=readFileSync(process.env.FILESMANAGE_ADMIN_PASSWORD_FILE||".secrets/admin.password","utf8").trim();
const temp=mkdtempSync(join(tmpdir(),"fm-geometry-"));
const port=9500+Math.floor(Math.random()*300);
const chrome=spawn("/usr/bin/google-chrome",[
 "--headless=new","--no-sandbox","--disable-dev-shm-usage",
 `--remote-debugging-port=${port}`,`--user-data-dir=${temp}`,
 "--window-size=1440,900","about:blank",
],{stdio:"ignore"});
let ws;
let next=0;
const pending=new Map();
let checks=0;
let failures=0;
const check=(name,good,details="")=>{
 checks++;
 if(!good)failures++;
 process.stdout.write(`${good?"PASS":"FAIL"} ${name}${details?" :: "+details:""}\n`);
};
async function send(method,params={}){
 const id=++next;
 return await new Promise((resolve,reject)=>{
  pending.set(id,{resolve,reject});
  ws.send(JSON.stringify({id,method,params}));
 });
}
async function evaluate(expression){
 const result=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
 if(result.exceptionDetails)throw Error("browser JS error: "+JSON.stringify(result.exceptionDetails).slice(0,280));
 return result.result?.value;
}
async function navigate(path,selector){
 await send("Page.navigate",{url:BASE+path});
 const expectedPath=new URL(path,BASE).pathname;
 for(let i=0;i<70;i++){
  await delay(200);
  const ready=await evaluate(`(()=>location.pathname===${JSON.stringify(expectedPath)}&&!!document.querySelector(${JSON.stringify(selector)}))()`).catch(()=>false);
  if(ready)return;
 }
 throw Error("page did not render "+path+" "+selector);
}
async function inspect(page,rules){
 const report=await evaluate(`(()=>{
  const rules=${JSON.stringify(rules)};
  return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
   shapes:rules.map(([name,selector,minRadius])=>{
    const el=document.querySelector(selector);
    const style=el?getComputedStyle(el):null;
    const rect=el?.getBoundingClientRect();
    return {name,found:!!el,minRadius,radius:style?parseFloat(style.borderTopLeftRadius):0,
      width:rect?.width||0,height:rect?.height||0};
   })};
 })()`);
 check(page+" no horizontal overflow",report.scrollWidth<=report.width+2,
  `scrollWidth=${report.scrollWidth} viewport=${report.width}`);
 for(const shape of report.shapes){
  check(page+" "+shape.name+" rounded",shape.found&&shape.radius>=shape.minRadius&&shape.width>0&&shape.height>0,
   `radius=${shape.radius} required>=${shape.minRadius} found=${shape.found}`);
 }
}

async function compactViewport(width,height=760){
 await send("Emulation.setDeviceMetricsOverride",{
  // First validate the *CSS layout viewport* at exactly the requested width.
  // mobile:true can auto-expand the layout viewport to accommodate overflowing
  // descendants, causing misleading passes (e.g. a 390px phone reporting a
  // 725px layout viewport).
  width,height,deviceScaleFactor:1,mobile:false,
 });
 await delay(250);
}
async function inspectCompact(page,width){
 const report=await evaluate(`(()=>{
  const rect=selector=>{
   const el=document.querySelector(selector);
   if(!el)return null;
   const r=el.getBoundingClientRect(),s=getComputedStyle(el);
   return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,
     width:r.width,height:r.height,radius:parseFloat(s.borderTopLeftRadius),
     overflowX:s.overflowX,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth};
  };
  return {width:innerWidth,htmlWidth:document.documentElement.scrollWidth,
   rootOverflowX:getComputedStyle(document.documentElement).overflowX,
   rootHorizontalScrollPossible:(()=>{
    const x=scrollX,y=scrollY;
    scrollTo(99999,y);
    const moved=scrollX!==x;
    scrollTo(x,y);
    return moved;
   })(),
   visualWidth:visualViewport?.width,visualScale:visualViewport?.scale,
   header:rect(".header"),brand:rect(".brand"),navToggle:rect(".nav-toggle"),
   headerRight:rect(".header-right"),sidebar:rect(".sidebar"),
   work:rect(".work"),table:rect(".table"),org:rect(".org-workbench"),
   dialog:rect("dialog.dialog[open]"),
   menu:rect(".header nav.open"),
   overflowing:[...document.querySelectorAll("body *")].filter(el=>{
    const r=el.getBoundingClientRect(),s=getComputedStyle(el);
    return r.right>innerWidth+3&&r.width>10&&s.position!=="fixed";
   }).slice(0,7).map(el=>({
    selector:el.tagName.toLowerCase()+"."+String(el.className||"").slice(0,64),
    right:Math.round(el.getBoundingClientRect().right),
    width:Math.round(el.getBoundingClientRect().width),
   }))};
 })()`);
 check(`${page} ${width}px no page-level horizontal scrolling`,
  !report.rootHorizontalScrollPossible&&(report.htmlWidth<=report.width+2||report.rootOverflowX==="clip"),
  `scrollWidth=${report.htmlWidth} viewport=${report.width} rootOverflow=${report.rootOverflowX} outliers=${JSON.stringify(report.overflowing)}`);
 check(`${page} ${width}px exact layout viewport`,report.width===width,
  `layout=${report.width} target=${width}`);
 check(`${page} ${width}px header contents fit`,
  !!report.header&&!!report.headerRight&&report.headerRight.right<=report.width+2&&
  (!report.brand||report.brand.left>=-1)&&report.headerRight.left>=0,
  `header-right=${report.headerRight?.right}`);
 if(report.work){
  check(`${page} ${width}px workspace remains usable`,
   report.work.width>=Math.min(width*.72,width-16)&&report.work.height>=190,
   `work=${Math.round(report.work.width)}x${Math.round(report.work.height)}`);
 }
 if(report.sidebar){
  check(`${page} ${width}px folder tree remains accessible`,
   report.sidebar.width>=170&&report.sidebar.height>=100&&
   report.sidebar.right<=width+2,`sidebar=${Math.round(report.sidebar.width)}x${Math.round(report.sidebar.height)}`);
 }
 if(page==="documents"&&width<=600){
  check(`${page} ${width}px file grid scrolls inside panel`,
   !!report.table&&report.table.right<=width+2&&
   report.table.scrollWidth>report.table.clientWidth,
   `table=${report.table?.clientWidth}/${report.table?.scrollWidth} right=${report.table?.right}`);
 }
  if(report.org){
  check(`${page} ${width}px organization grid fits`,
   report.org.width<=width+2&&report.org.scrollWidth<=report.org.clientWidth+2,
   `grid scrollWidth=${report.org.scrollWidth} clientWidth=${report.org.clientWidth}`);
 }
 if(page==="organization"&&width<=600){
  const tabs=await evaluate(`(()=>{
   const el=document.querySelector(".org-tabs-nav");
   if(!el)return null;
   const r=el.getBoundingClientRect();
   return {right:r.right,clientWidth:el.clientWidth,scrollWidth:el.scrollWidth};
  })()`);
  check(`${page} ${width}px tabs scroll within viewport`,
   !!tabs&&tabs.right<=width+2&&tabs.clientWidth<=width,
   JSON.stringify(tabs));
 }
 return report;
}

try{
 let target;
 for(let i=0;i<70&&!target;i++){
  await delay(200);
  try{
   const pages=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
   target=pages.find(page=>page.type==="page");
  }catch{}
 }
 if(!target)throw Error("no Chrome debugging target");
 ws=new WebSocket(target.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{
  ws.addEventListener("open",resolve,{once:true});
  ws.addEventListener("error",reject,{once:true});
 });
 ws.addEventListener("message",event=>{
  const response=JSON.parse(event.data);
  if(!response.id||!pending.has(response.id))return;
  const {resolve,reject}=pending.get(response.id);
  pending.delete(response.id);
  response.error?reject(Error(response.error.message)):resolve(response.result);
 });
 await send("Page.enable");
 await send("Runtime.enable");
 await navigate("/login",".login-entry");
 // The default view has only the centered login capsule; the actual form
 // becomes visible only after the progressive click/hover interaction.
 for(const width of [1440,900,390]){
  await compactViewport(width);
  await navigate("/login",".login-entry");
  const loginFields=await evaluate(`(()=>{
   const button=document.querySelector(".login-entry"),br=button?.getBoundingClientRect();
   const panel=document.querySelector(".login-panel"),pr=panel?.getBoundingClientRect();
   const brand=document.querySelector(".login-minimal-brand")?.getBoundingClientRect();
   return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
    buttonCenter:br?(br.left+br.right)/2:null,buttonMiddle:br?(br.top+br.bottom)/2:null,
    centerY:innerHeight/2,brandLeft:brand?.left,brandTop:brand?.top,
    panelHidden:panel?getComputedStyle(panel).visibility==="hidden":false,
    cardLeft:pr?.left,cardRight:pr?.right};
  })()`);
  check(`login ${width}px centered default capsule`,
   Math.abs(loginFields.buttonCenter-width/2)<=2&&
   Math.abs(loginFields.buttonMiddle-loginFields.centerY)<=2&&
   loginFields.panelHidden&&loginFields.brandLeft>=0&&loginFields.brandTop>=0,
   JSON.stringify(loginFields));
  await evaluate(`(()=>{document.querySelector('.login-entry').click();return true})()`);
  await delay(560);
  const expanded=await evaluate(`(()=>{
   const panel=document.querySelector(".login-panel"),r=panel?.getBoundingClientRect();
   return {open:document.querySelector(".login-reveal-zone")?.classList.contains("is-expanded"),
    visible:panel?getComputedStyle(panel).visibility==="visible":false,
    left:r?.left,right:r?.right,fields:panel?.querySelectorAll("input").length};
  })()`);
  check(`login ${width}px expanded form fits viewport`,
   loginFields.width===width&&loginFields.scrollWidth<=width+2&&
   expanded.open&&expanded.visible&&expanded.fields===3&&
   expanded.left>=-1&&expanded.right<=width+1,
   JSON.stringify(expanded));
 }
 await send("Emulation.clearDeviceMetricsOverride");
 await navigate("/login",".login-entry");
 const loggedIn=await evaluate(`(async()=>{
  const r=await fetch("/api/login",{method:"POST",credentials:"same-origin",
   headers:{"Content-Type":"application/json"},
   body:JSON.stringify({login:"admin",password:${JSON.stringify(password)}})});
  return r.ok;
 })()`);
 check("real login",loggedIn);
 await evaluate(`(()=>{document.querySelector('.login-entry').click();return true})()`);
 await delay(560);
 await inspect("login",[["card",".login-panel",18],["button",".login-panel .login-submit",6]]);
 // Verify the account-security page scrolls inside its bounded work area.
 // Duplicate rendered session rows in the DOM to make overflow deterministic,
 // regardless of how many real devices happen to be logged in.
 for(const width of [1440,900,390]){
  await compactViewport(width);
  await navigate("/account/sessions",".sessions-page");
  for(let i=0;i<35;i++){
   if(await evaluate('!!document.querySelector(".sessions-item")'))break;
   await delay(100);
  }
  const result=await evaluate('(()=>{'+
   'const scroll=document.querySelector(".sessions-work"),list=document.querySelector(".sessions-list");'+
   'const first=list?.querySelector(".sessions-item");if(!scroll||!first)return null;'+
   'while(list.children.length<24)list.append(first.cloneNode(true));'+
   'const overflow=getComputedStyle(scroll).overflowY;'+
   'scroll.scrollTop=scroll.scrollHeight;'+
   'return {overflow,clientHeight:scroll.clientHeight,scrollHeight:scroll.scrollHeight,'+
   'scrollTop:scroll.scrollTop,atBottom:scroll.scrollTop+scroll.clientHeight>=scroll.scrollHeight-3,'+
   'noHorizontalOverflow:scroll.scrollWidth<=scroll.clientWidth+2,'+
   'rootWidth:document.documentElement.scrollWidth,rootOverflowX:getComputedStyle(document.documentElement).overflowX,viewport:innerWidth};'+
   '})()');
  check('account sessions '+width+'px vertical scrolling reaches the bottom',
   !!result&&result.overflow==="auto"&&result.scrollHeight>result.clientHeight+100&&
   result.scrollTop>20&&result.atBottom&&result.noHorizontalOverflow&&
   (result.rootWidth<=width+2||result.rootOverflowX==="clip"),JSON.stringify(result));
 }
 await send("Emulation.clearDeviceMetricsOverride");
 await navigate("/doc",".sidebar");
 await inspect("documents",[
  ["header",".header",14],["sidebar",".sidebar",14],["workspace",".work",14],
  ["navigation",".header nav a.active",6],["table",".table",10],
  ["toolbar",".toolbar",6],["tree row",".sidebar .tree-row",6],
 ]);
 await evaluate(`(()=>{document.querySelector(".command-trigger")?.click();return true})()`);
 for(let i=0;i<25;i++){
  if(await evaluate(`!!document.querySelector(".command-panel")`))break;
  await delay(100);
 }
 const command=await evaluate(`(()=>{
  const el=document.querySelector(".command-panel");
  if(!el)return null;
  const s=getComputedStyle(el),r=el.getBoundingClientRect();
  return {radius:parseFloat(s.borderTopLeftRadius),
   shadow:s.boxShadow,visible:r.width>0&&r.height>0};
 })()`);
 check("global command palette uses shared overlay geometry",
  !!command&&command.visible&&command.radius>=10&&command.shadow!=="none",
  JSON.stringify(command));
 await navigate("/org",".org-card");
 await inspect("organization",[
  ["workspace",".work",14],["card",".org-card",14],["tabs",".org-tabs-nav",10],
  ["tab",".org-tab",6],
 ]);
 // Create a disposable folder and PNG to exercise the real media-rendering
 // branch, including its scrollable preview-page variant.
 const fixture=await evaluate(`(async()=>{
  const name="geometry-"+Date.now();
  const folder=await fetch("/api/folders",{method:"POST",headers:{"Content-Type":"application/json"},
   body:JSON.stringify({parentId:"folder_root",name})}).then(r=>r.json());
  const folderId=folder.data?.id;
  if(!folderId)return {error:"folder"};
  const bytes=Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nKOcAAAAASUVORK5CYII="),c=>c.charCodeAt(0));
  const form=new FormData();
  form.set("folderId",folderId);
  form.set("file",new File([bytes],name+".png",{type:"image/png"}));
  const uploaded=await fetch("/api/files",{method:"POST",body:form}).then(r=>r.json());
  return {folderId,fileId:uploaded.data?.fileId,error:uploaded.error?.code};
 })()`);
 try{
  check("PNG preview fixture",!!fixture.fileId,fixture.error||"");
 if(fixture.fileId){
   await navigate("/preview/"+fixture.fileId,".media-preview");
   await inspect("media preview",[
    ["workspace",".work",14],["toolbar",".toolbar",6],
    ["media canvas",".media-preview",10],["version table",".table",10],
   ]);
   const scrolling=await evaluate(`(()=>getComputedStyle(document.querySelector(".file-preview-page")).overflowY)()`);
   check("preview scrolling retained",scrolling==="auto",scrolling);
  }
  // Responsive geometry is measured from the actual browser, not inferred
  // from media query source. Include a genuinely narrow phone viewport.
  for(const width of [820,600,390,320]){
   await compactViewport(width);
   await navigate("/doc",".table");
   await inspectCompact("documents",width);
   if(width<=600){
    await evaluate(`(()=>{document.querySelector(".nav-toggle")?.click();return true})()`);
    await delay(200);
    const toggled=await evaluate(`(()=>{
     const menu=document.querySelector(".header nav.open");
     if(!menu)return null;
     const r=menu.getBoundingClientRect();
     return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};
    })()`);
    check(`navigation popup ${width}px fits`,
     !!toggled&&toggled.left>=0&&toggled.right<=width+2&&toggled.bottom<=760,
     JSON.stringify(toggled));
   }
   await navigate("/org",".org-card");
   await inspectCompact("organization",width);
   const permissionsTab=await evaluate(`(()=>{
    const tab=[...document.querySelectorAll('.org-tab[role="tab"]')]
     .find(el=>el.textContent?.includes("权限管理"));
    if(!tab)return false;
    tab.click();return true;
   })()`);
   await delay(230);
   const permissionsLayout=await evaluate(`(()=>{
    const info=selector=>{
     const el=document.querySelector(selector);if(!el)return null;
     const r=el.getBoundingClientRect(),style=getComputedStyle(el);
     return {width:r.width,height:r.height,left:r.left,right:r.right,
       top:r.top,bottom:r.bottom,scrollWidth:el.scrollWidth,
       clientWidth:el.clientWidth,overflowX:style.overflowX,
       overflowY:style.overflowY};
    };
    return {workspace:info(".perm-workspace"),
      tree:info(".perm-browser"),treeScroll:info(".perm-browser-scroll"),
      detail:info(".perm-detail"),subnav:info(".perm-subnav")};
   })()`);
   check(`permissions ${width}px tree and details accessible`,
    permissionsTab&&!!permissionsLayout.workspace&&!!permissionsLayout.tree&&
    !!permissionsLayout.detail&&
    permissionsLayout.workspace.right<=width+2&&
    permissionsLayout.tree.width>=Math.min(200,width*.6)&&
    permissionsLayout.tree.height>=110&&
    permissionsLayout.treeScroll.height>=80&&
    permissionsLayout.detail.width>=Math.min(250,width*.7)&&
    permissionsLayout.detail.height>=300&&
    permissionsLayout.detail.overflowY==="auto"&&
    permissionsLayout.treeScroll.overflowY==="auto"&&
    permissionsLayout.workspace.overflowY==="hidden",
    JSON.stringify(permissionsLayout));
   if(width===390){
    await navigate("/doc?folder="+fixture.folderId,".file-table");
    for(let i=0;i<50;i++){
     if(await evaluate(`!!document.querySelector(".more-trigger")`))break;
     await delay(100);
    }
    const quickMenuOpened=await evaluate(`(()=>{
     const button=document.querySelector(".file-mobile-actions");
     if(!button)return false;
     const style=getComputedStyle(button);
     if(style.display==="none")return false;
     button.click();return true;
    })()`);
    await delay(140);
    const quickMenu=await evaluate(`(()=>{
     const menu=document.querySelector('[role="menu"][aria-label="文件操作菜单"]');
     if(!menu)return null;
     const r=menu.getBoundingClientRect(),s=getComputedStyle(menu);
     return {left:r.left,right:r.right,visible:s.opacity!=="0",
      labels:[...menu.querySelectorAll('[role="menuitem"]')].map(el=>el.textContent?.trim())};
    })()`);
    check("phone file name exposes reachable full action menu",
     quickMenuOpened&&!!quickMenu&&quickMenu.visible&&quickMenu.left>=0&&
     quickMenu.right<=390&&quickMenu.labels.some(x=>x?.startsWith("移动到"))&&
     quickMenu.labels.some(x=>x?.startsWith("重命名")),
     JSON.stringify(quickMenu));
    await navigate("/doc?folder="+fixture.folderId,".file-table");
    for(let i=0;i<50;i++){
     if(await evaluate(`!!document.querySelector(".more-trigger")`))break;
     await delay(100);
    }
    const actionScrolled=await evaluate(`(()=>{
     const button=document.querySelector(".more-trigger");
     if(!button)return false;
     button.scrollIntoView({block:"nearest",inline:"end"});
     return true;
    })()`);
    await delay(240);
    const opened=await evaluate(`(()=>{
     const button=document.querySelector(".more-trigger");
     if(!button)return false;
     button.click();
     return true;
    })()`);
     await delay(130);
     const rowMenu=await evaluate(`(()=>{
      const el=document.querySelector('[role="menu"][aria-label="文件操作菜单"]');
      if(!el)return null;
      const s=getComputedStyle(el),r=el.getBoundingClientRect();
      return {radius:parseFloat(s.borderTopLeftRadius),shadow:s.boxShadow,
       left:r.left,right:r.right,top:r.top,bottom:r.bottom,
       labels:[...el.querySelectorAll('[role="menuitem"] .menu-label')].map(x=>x.textContent)};
     })()`);
     check("phone action-column menu escapes horizontal grid clipping",
      !!rowMenu&&rowMenu.radius>=10&&rowMenu.shadow!=="none"&&
      rowMenu.left>=0&&rowMenu.right<=390&&rowMenu.top>=0&&rowMenu.bottom<=760&&
      rowMenu.labels.includes("重命名")&&rowMenu.labels.includes("移动到…"),
      JSON.stringify(rowMenu));
     await evaluate(`(()=>{
      const menu=document.querySelector('[role="menu"][aria-label="文件操作菜单"]');
      [...(menu?.querySelectorAll('[role="menuitem"]')??[])]
       .find(x=>x.querySelector('.menu-label')?.textContent==="重命名")?.click();
      return true;
     })()`);
    await delay(220);
    const dialog=await evaluate(`(()=>{
     const el=document.querySelector("dialog.dialog[open]");
     if(!el)return null;
     const rect=el.getBoundingClientRect();
     return {left:rect.left,right:rect.right,width:rect.width,
       radius:parseFloat(getComputedStyle(el).borderTopLeftRadius)};
    })()`);
    check("phone 390px edit dialog fits and is rounded",
      actionScrolled&&opened&&dialog&&dialog.left>=0&&dialog.right<=390&&dialog.radius>=18,
     JSON.stringify(dialog));
    await evaluate(`(()=>document.querySelector("dialog.dialog[open] button[type=button]")?.click())()`);
    await navigate("/preview/"+fixture.fileId,".media-preview");
    await inspectCompact("media preview",width);
   }
  }
  for(const width of [600,390,320]){
   await send("Emulation.setDeviceMetricsOverride",{
    width,height:760,deviceScaleFactor:1,mobile:true,
   });
   await delay(150);
   await navigate("/doc",".sidebar");
   const mobile=await evaluate(`(()=>{
    const geom=selector=>{
     const el=document.querySelector(selector);
     if(!el)return null;
     const r=el.getBoundingClientRect(),s=getComputedStyle(el);
     return {width:Math.round(r.width),right:Math.round(r.right),
      clientWidth:el.clientWidth,scrollWidth:el.scrollWidth,overflowX:s.overflowX};
    };
    return {
     innerWidth,scrollWidth:document.documentElement.scrollWidth,
     visualWidth:visualViewport.width,scale:visualViewport.scale,
     meta:document.querySelector("meta[name=viewport]")?.content,
     root:geom("html"),shell:geom(".shell"),work:geom(".work"),
     grid:geom(".table"),table:geom("table.file-table"),
    };
   })()`);
   check(`mobile device ${width}px no automatic page zoom`,
    mobile.innerWidth===width&&Math.abs(mobile.scale-1)<.03,
    JSON.stringify(mobile));
  }
  await send("Emulation.clearDeviceMetricsOverride");
 }finally{
  if(fixture.folderId)await evaluate(`fetch("/api/folders/${fixture.folderId}",{method:"DELETE"}).then(r=>r.status)`);
 }
}catch(error){
 check("geometry harness",false,error instanceof Error?error.message:String(error));
}finally{
 ws?.close();
 chrome.kill("SIGTERM");
 await delay(150);
 rmSync(temp,{recursive:true,force:true});
 console.log(`UI_GEOMETRY ${checks-failures}/${checks} ${failures===0?"PASS":"FAIL"}`);
 process.exitCode=failures===0?0:1;
}
