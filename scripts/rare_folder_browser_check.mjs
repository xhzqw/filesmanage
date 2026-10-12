#!/usr/bin/env node
// Read-only deployed Chrome regression for Rare UI folder visuals and Finder
// navigation. Does not create or modify any server-side resources.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {readFileSync,rmSync} from "node:fs";

const root="http://127.0.0.1:18091";
const profile="/tmp/fm-rare-folder-"+process.pid;
const chrome=spawn("/usr/bin/google-chrome",[
 "--headless=new","--no-sandbox","--disable-gpu",
 "--user-data-dir="+profile,"--remote-debugging-port=0",
 "--window-size=1440,900","about:blank"
],{stdio:"ignore"});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let ws,port=0,sequence=0;
const pending=new Map();
function send(method,params={}){
 const id=++sequence;
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{pending.delete(id);reject(Error("Chrome timeout: "+method));},16000);
  pending.set(id,{resolve,reject,timer});
  ws.send(JSON.stringify({id,method,params}));
 });
}
async function evaluate(expression){
 const reply=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
 if(reply.exceptionDetails)throw Error(JSON.stringify(reply.exceptionDetails).slice(0,500));
 return reply.result?.value;
}
async function until(expression){
 for(let i=0;i<110;i++){
  if(await evaluate(expression))return;
  await wait(130);
 }
 throw Error("DOM timeout: "+expression);
}
async function navigate(path,ready){
 await send("Page.navigate",{url:root+path});
 await until(ready);
}
async function measure(width){
 await send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
 await wait(160);
 const result=await evaluate(`(()=>{
  const bar=document.querySelector(".folder-context-bar");
  const switcher=document.querySelector(".folder-view-switch");
  const history=document.querySelector(".folder-history-controls");
  const icon=document.querySelector('[data-slot="rare-folder-component"]');
  if(!bar||!switcher||!history||!icon)return null;
  const b=bar.getBoundingClientRect(),s=switcher.getBoundingClientRect(),h=history.getBoundingClientRect();
  const styles=getComputedStyle(switcher);
  const back=getComputedStyle(icon.querySelector(".rare-folder-back"));
  const glass=getComputedStyle(icon.querySelector(".rare-folder-glass"));
  const flap=icon.querySelector(".rare-folder-front svg path");
  return {
   width:innerWidth,documentOverflow:document.documentElement.scrollWidth-innerWidth,
   bar:{left:b.left,right:b.right,top:b.top,bottom:b.bottom},
   switcher:{left:s.left,right:s.right},history:{left:h.left,right:h.right},
   border:styles.borderColor,iconCount:document.querySelectorAll('[data-slot="rare-folder-component"]').length,
   nestedCards:icon.querySelectorAll(".rare-folder-card").length,
   flap:Boolean(icon.querySelector(".rare-folder-front")),
   blueBack:back.backgroundColor,glassBlur:glass.backdropFilter,
   flapFill:flap?.getAttribute("fill"),
   stageSize:icon.querySelector(".rare-folder-stage")?.getBoundingClientRect().width,
   controls:[...switcher.querySelectorAll("button")].map(x=>x.getAttribute("aria-label"))
  };
 })()`);
 assert(result,"folder toolbar and shared icon must render");
 assert(result.iconCount>0&&result.nestedCards===3&&result.flap,"RareUI layered folder needs 3 cards and a movable flap");
 assert(result.blueBack==="rgb(80, 177, 253)","RareUI original blue theme must be used, not yellow: "+result.blueBack);
 assert(result.glassBlur.includes("blur(6px)")&&result.flapFill==="#3A9AE8","RareUI front requires the source glass blur and translucent blue flap");
 assert(result.stageSize>0,"RareUI original component stage must have positive size");
 assert.equal(result.controls.join(","),"图标视图,列表视图,分栏视图,画廊视图");
 assert(result.documentOverflow<=2,"page-level horizontal overflow at "+width+": "+JSON.stringify(result));
 assert(result.bar.left>=-2&&result.bar.right<=width+2,"folder toolbar overflow at "+width);
 assert(result.switcher.left>=-2&&result.switcher.right<=width+2,"view switch overflow at "+width);
 assert(result.history.left>=-2&&result.history.right<=width+2,"history group overflow at "+width);
 assert(result.border==="rgba(0, 0, 0, 0)"||result.border==="transparent","excessive outlined view switch: "+result.border);
 console.log("RARE_FOLDER_VIEWPORT",JSON.stringify(result));
}

try{
 for(let i=0;i<100;i++){
  await wait(110);
  try{
   if(!port)port=Number(readFileSync(profile+"/DevToolsActivePort","utf8").split("\n")[0]);
   const targets=await(await fetch("http://127.0.0.1:"+port+"/json/list")).json();
   const page=targets.find(target=>target.type==="page");
   if(page){ws=new WebSocket(page.webSocketDebuggerUrl);break;}
  }catch{}
 }
 if(!ws)throw Error("Chrome was not ready");
 await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true});});
 ws.addEventListener("message",event=>{
  const reply=JSON.parse(event.data);
  const item=pending.get(reply.id);
  if(!item)return;
  pending.delete(reply.id);clearTimeout(item.timer);
  reply.error?item.reject(Error(reply.error.message)):item.resolve(reply.result);
 });
 await send("Page.enable");await send("Runtime.enable");
 await navigate("/login",'!!document.querySelector("input[type=password]")');
 const password=readFileSync(".secrets/admin.password","utf8").trim();
 const authorized=await evaluate(`(async()=>{const response=await fetch("/api/login",{
  method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},
  body:JSON.stringify({login:"admin",password:${JSON.stringify(password)}})
 });return response.ok})()`);
 assert(authorized,"admin browser login failed");
 await navigate("/doc",'!!document.querySelector(".folder-context-bar .folder-view-switch")');
 await until('document.querySelectorAll("[data-slot=rare-folder-component]").length>0');
 for(const width of [1440,980,700,390])await measure(width);
 await send("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:1,mobile:false});
 for(const [label,mode] of [["图标视图","icons"],["分栏视图","columns"],["画廊视图","gallery"],["列表视图","list"]]){
  const clicked=await evaluate(`(()=>{const button=[...document.querySelectorAll(".folder-view-switch button")].find(e=>e.getAttribute("aria-label")===${JSON.stringify(label)});if(!button)return false;button.click();return true})()`);
  assert(clicked,"view mode button missing: "+label);
  await until(`document.querySelector(".work-body")?.dataset.explorerView===${JSON.stringify(mode)}`);
  if(mode==="icons"){
   const alignment=await evaluate(`(()=>{
    const source=document.querySelector(".explorer-icon-grid > .explorer-item");
    if(!source)return null;
    const fixture=document.createElement("div");
    fixture.className="explorer-icon-grid";
    Object.assign(fixture.style,{position:"fixed",top:"0px",left:"0px",width:"320px",visibility:"hidden",pointerEvents:"none"});
    const short=source.cloneNode(true),long=source.cloneNode(true);
    short.querySelector(".explorer-item-name").textContent="hammer.iges";
    long.querySelector(".explorer-item-name").textContent="pe11-verify-1791469382.step";
    fixture.append(short,long);
    document.body.append(fixture);
    const positions=card=>Object.fromEntries([".explorer-item-art",".explorer-item-name",".explorer-item-sub"].map(selector=>[selector,card.querySelector(selector).getBoundingClientRect().top]));
    const a=positions(short),b=positions(long);
    fixture.remove();
    return {short:a,long:b,deltas:Object.fromEntries(Object.keys(a).map(key=>[key,Math.abs(a[key]-b[key])]))};
   })()`);
   assert(alignment,"icon-grid test needs at least one file or folder");
   assert(Object.values(alignment.deltas).every(delta=>delta<=1),"icon, label, and metadata must align for short and two-line names: "+JSON.stringify(alignment));
   console.log("EXPLORER_ICON_ALIGNMENT_PASS",JSON.stringify(alignment.deltas));
   // Move the real Chrome pointer onto the NAME, not onto the folder glyph:
   // the complete tile owns hover. Selection then locks the open animation.
   const tile=await evaluate(`(()=>{
    const el=document.querySelector(".explorer-icon-grid .explorer-folder:not(.selected)");
    if(!el)return null;
    const n=el.querySelector(".explorer-item-name").getBoundingClientRect();
    const art=el.querySelector(".explorer-item-art").getBoundingClientRect();
    const name={x:n.left+n.width/2,y:n.top+n.height/2};
    return {name,outsideIcon:!(name.x>=art.left&&name.x<=art.right&&name.y>=art.top&&name.y<=art.bottom)};
   })()`);
   assert(tile&&tile.outsideIcon,"hover fixture needs a non-selected folder NAME distinct from the icon");
   await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:0,y:0});
   await wait(140);
   assert.equal(await evaluate('document.querySelector(".explorer-icon-grid .explorer-folder:not(.selected) [data-slot=rare-folder-component]")?.dataset.folderOpen'),"false","unselected folder starts closed");
   await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:tile.name.x,y:tile.name.y});
   await until('document.querySelector(".explorer-icon-grid .explorer-folder:not(.selected) [data-slot=rare-folder-component]")?.dataset.folderOpen==="true"');
   await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:0,y:0});
   await until('document.querySelector(".explorer-icon-grid .explorer-folder:not(.selected) [data-slot=rare-folder-component]")?.dataset.folderOpen==="false"');
   await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:tile.name.x,y:tile.name.y});
   await send("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",x:tile.name.x,y:tile.name.y,clickCount:1});
   await send("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",x:tile.name.x,y:tile.name.y,clickCount:1});
   await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:0,y:0});
   await until('document.querySelector(".explorer-icon-grid .explorer-folder.selected [data-slot=rare-folder-component]")?.dataset.folderOpen==="true"');
   console.log("RARE_FOLDER_TILE_HOVER_PASS name/empty-area hover, exit, selected-open");
  }
  if(mode!=="list"){
   const count=await evaluate('document.querySelectorAll(".explorer-folder [data-slot=rare-folder-component]").length');
   assert(count>0,"folder visuals absent from "+mode+" view");
  }
 }
 console.log("RARE_FOLDER_BROWSER_PASS: layered folders, low-noise toolbar, 4 views, 1440/980/700/390px");
}catch(error){
 console.error("RARE_FOLDER_BROWSER_FAIL",error?.stack??error);
 process.exitCode=1;
}finally{
 ws?.close();
 chrome.kill("SIGTERM");
 await wait(180);
 rmSync(profile,{recursive:true,force:true});
}
