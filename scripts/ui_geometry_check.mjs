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
 for(let i=0;i<70;i++){
  await delay(200);
  const ready=await evaluate(`(()=>location.pathname===${JSON.stringify(path)}&&!!document.querySelector(${JSON.stringify(selector)}))()`).catch(()=>false);
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
