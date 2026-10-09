#!/usr/bin/env node
// Visual System V3: computed-style regression on the *real remote UI*.
// Headless Chrome runs only on the target host; local repo never runs services.
import {spawn} from "node:child_process";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";

const BASE=(process.env.FILESMANAGE_BASE||"http://127.0.0.1:18091").replace(/\/$/,"");
if(!["127.0.0.1","localhost","::1"].includes(new URL(BASE).hostname)){
 throw Error("geometry acceptance only runs against the target host loopback");
}
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
 check(`${page} ${width}px document fits`,report.htmlWidth<=report.width+2,
  `scroll=${report.htmlWidth} viewport=${report.width} outliers=${JSON.stringify(report.overflowing)}`);
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
 await navigate("/login",".login-card");
 const loggedIn=await evaluate(`(async()=>{
  const r=await fetch("/api/login",{method:"POST",credentials:"same-origin",
   headers:{"Content-Type":"application/json"},
   body:JSON.stringify({login:"admin",password:${JSON.stringify(password)}})});
  return r.ok;
 })()`);
 check("real login",loggedIn);
 await inspect("login",[["card",".login-card",18],["button",".login-card button.primary",6]]);
 await navigate("/doc",".sidebar");
 await inspect("documents",[
  ["header",".header",14],["sidebar",".sidebar",14],["workspace",".work",14],
  ["navigation",".header nav a.active",6],["table",".table",10],
  ["toolbar",".toolbar",6],["tree row",".sidebar .tree-row",6],
 ]);
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
   await navigate("/doc",".sidebar");
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
   if(width===390){
    await navigate("/doc?folder="+fixture.folderId,".file-table");
    const opened=await evaluate(`(()=>{
     const button=document.querySelector(".more-trigger");
     if(!button)return false;
     button.click();
     return true;
    })()`);
    await delay(130);
    await evaluate(`(()=>{document.querySelector(".row-more-menu.open button")?.click();return true})()`);
    await delay(220);
    const dialog=await evaluate(`(()=>{
     const el=document.querySelector("dialog.dialog[open]");
     if(!el)return null;
     const rect=el.getBoundingClientRect();
     return {left:rect.left,right:rect.right,width:rect.width,
       radius:parseFloat(getComputedStyle(el).borderTopLeftRadius)};
    })()`);
    check("phone 390px edit dialog fits and is rounded",
     opened&&dialog&&dialog.left>=0&&dialog.right<=390&&dialog.radius>=18,
     JSON.stringify(dialog));
    await evaluate(`(()=>document.querySelector("dialog.dialog[open] button[type=button]")?.click())()`);
    await navigate("/preview/"+fixture.fileId,".media-preview");
    await inspectCompact("media preview",width);
   }
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
