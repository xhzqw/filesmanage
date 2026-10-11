#!/usr/bin/env node
// Remote-only synthetic CAD viewport smoke. Exercises real WebGL/OrbitControls
// without modifying the application DB or opening a production route.
import assert from "node:assert/strict";
import {build} from "esbuild";
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import {mkdtempSync} from "node:fs";
import {rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {setTimeout as delay} from "node:timers/promises";

const root=path.resolve("web");
const source=String.raw`
import * as THREE from "three";
import {OrbitControls} from "three/examples/jsm/controls/OrbitControls.js";
import {mountEngineeringScene} from "./src/features/modelViewer/viewerScene.ts";
import {parseDxf} from "./src/features/modelViewer/dxf.ts";
const holder=document.getElementById("stage");
let controls=null,metrics=null,lastCamera=null;
let actualDrawing=null;
const callback=(yaw,pitch)=>{lastCamera={yaw,pitch};};
function mount(drawing=false,layout="Model"){
 if(controls)controls.dispose();
 let object=new THREE.Mesh(new THREE.BoxGeometry(10,10,10),new THREE.MeshPhongMaterial({color:0x467fa8}));
 if(drawing){
  const dxf=[
   "0","SECTION","2","BLOCKS",
   "0","BLOCK","2","*D1","10","0","20","0",
   "0","LINE","8","0","10","0","20","0","11","100","21","0",
   "0","ENDBLK","0","ENDSEC",
   "0","SECTION","2","ENTITIES",
   "0","DIMENSION","2","*D1","8","DIM","10","900","20","900",
   "0","SPLINE","8","SPLINE","71","2","72","6","73","3",
   "40","0","40","0","40","0","40","1","40","1","40","1",
   "10","0","20","0","10","50","20","80","10","100","20","0",
   "0","HATCH","8","FILL","70","1","75","0","91","1",
   "92","2","72","0","73","1","93","4",
   "10","10","20","10","10","30","20","10",
   "10","30","20","30","10","10","20","30","97","0",
   "0","HATCH","8","PATTERN","70","0","75","0","91","1",
   "92","2","72","0","73","1","93","4",
   "10","50","20","10","10","90","20","10",
   "10","90","20","30","10","50","20","30","97","0",
   "78","1","53","45","43","50","44","10","45","0","46","3","79","0",
   "0","LINE","8","SHEET","410","A1","67","1",
   "10","500","20","500","11","510","21","500",
   "0","ENDSEC","0","EOF",
  ].join("\n");
  const source=layout==="P1"?[
   "0","SECTION","2","ENTITIES",
   "0","LINE","8","CUT","62","1","10","-20","20","10","11","60","21","10",
   "0","VIEWPORT","8","FRAME","410","P1","67","1","69","2",
   "10","100","20","50","40","40","41","20",
   "12","20","22","10","45","20","51","0",
   "0","ENDSEC","0","EOF",
  ].join("\n"):dxf;
  actualDrawing=parseDxf(source,THREE,layout);
  if(actualDrawing.skipped.length)throw Error(actualDrawing.skipped.join(","));
  object=actualDrawing.object;
 }
 controls=mountEngineeringScene(THREE,OrbitControls,holder,object,drawing,m=>{metrics=m;},
  ()=>{throw Error("WebGL context unexpectedly lost");},()=>{},callback);
}
mount();
window.__cad={
 get state(){return {metrics,camera:lastCamera,canvases:holder.querySelectorAll("canvas").length,
  width:holder.querySelector("canvas")?.getBoundingClientRect().width??0,
  drawingLayers:actualDrawing?.layers.length??0,
  drawingLayout:actualDrawing?.layout??null,layoutCount:actualDrawing?.layouts.length??0,
  projectedViewports:actualDrawing?.viewports.projected??0,
  projectedSegments:actualDrawing?.object.children.find(g=>g.name==="CUT")?.
   children.find(g=>g.isLineSegments)?.geometry.getAttribute("position").count??0};},
 view:name=>controls.setStandardView(name),
 projection:()=>controls.toggleProjection(),
 measure:()=>controls.toggleMeasure(),
 focus:()=>{const mesh=holder.querySelector("canvas");return Boolean(mesh)&&Boolean(controls.resetView());},
 grid:()=>controls.toggleGrid(),
 drawing:()=>mount(true),
 sheet:()=>mount(true,"A1"),
 projected:()=>mount(true,"P1"),
 png:()=>controls.exportPng()?.startsWith("data:image/png;base64,")??false,
 dispose:()=>{controls.dispose();return holder.querySelectorAll("canvas").length;},
};
`;
const result=await build({stdin:{contents:source,resolveDir:root,sourcefile:"cad-browser-fixture.ts"},
 bundle:true,write:false,format:"iife",platform:"browser",target:"es2022",logLevel:"silent"});
const bundle=result.outputFiles[0]?.text;
assert(bundle,"browser fixture bundle should exist");
const html=`<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden}
#stage{width:100vw;height:100vh}
</style></head><body><div id="stage"></div><script>${bundle}</script></body></html>`;
const server=createServer((req,res)=>{
 res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});
 res.end(html);
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const address=server.address();
assert(address&&typeof address!=="string");
const directory=mkdtempSync(path.join(tmpdir(),"cad-v3-chrome-"));
const port=19410+Math.floor(Math.random()*800);
const chrome=spawn("/usr/bin/google-chrome",[
 "--headless=new",`--remote-debugging-port=${port}`,
 `--user-data-dir=${directory}`,"--no-sandbox","--no-first-run",
 "--disable-dev-shm-usage","--use-angle=swiftshader","--enable-unsafe-swiftshader",
 "--window-size=1366,768","about:blank",
],{stdio:"ignore",detached:true});

class CDP{
 constructor(ws){
  this.ws=ws;this.sequence=1;this.pending=new Map();
  ws.addEventListener("message",event=>{
   const message=JSON.parse(event.data);
   const handler=this.pending.get(message.id);
   if(!handler)return;
   this.pending.delete(message.id);
   if(message.error)handler.reject(Error(message.error.message));
   else handler.resolve(message.result);
  });
 }
 async send(method,params={}){
  const id=this.sequence++;
  return new Promise((resolve,reject)=>{
   this.pending.set(id,{resolve,reject});
   this.ws.send(JSON.stringify({id,method,params}));
  });
 }
 async eval(expression){
  const response=await this.send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
  if(response.exceptionDetails)throw Error("CAD browser JS exception: "+JSON.stringify(response.exceptionDetails).slice(0,400));
  return response.result.value;
 }
}
let cdp=null;
try{
 let target=null;
 for(let i=0;i<65&&!target;i++){
  await delay(200);
  try{
   const tabs=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
   target=tabs.find(tab=>tab.type==="page");
  }catch{/* Chrome still starting */}
 }
 assert(target,"headless Chrome failed to start");
 const ws=new WebSocket(target.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{
  ws.addEventListener("open",resolve,{once:true});
  ws.addEventListener("error",reject,{once:true});
 });
 cdp=new CDP(ws);
 await cdp.send("Page.enable");
 await cdp.send("Runtime.enable");
 await cdp.send("Page.navigate",{url:`http://127.0.0.1:${address.port}`});
 let state=null;
 for(let i=0;i<80;i++){
  await delay(250);
  const data=await cdp.eval("window.__cad?.state??null");
  if(data?.canvases===1){state=data;break;}
 }
 assert(state,"CAD fixture did not mount");
 assert.equal(state.metrics.triangles,12);
 assert.equal(state.canvases,1);
 assert(state.width>1000);
 const right=await cdp.eval("(()=>{window.__cad.view('right');return window.__cad.state.camera})()");
 assert(Math.abs(right.yaw-90)<2,"right view camera points toward +X");
 const top=await cdp.eval("(()=>{window.__cad.view('top');return window.__cad.state.camera})()");
 assert(top.pitch>85,"top view camera points down +Y");
 assert.equal(await cdp.eval("window.__cad.projection()"),"perspective");
 const projectionDirection=await cdp.eval("window.__cad.state.camera");
 assert(projectionDirection.pitch>85,"projection toggle must preserve the camera direction");
 assert.equal(await cdp.eval("window.__cad.measure()"),true);
 assert.equal(await cdp.eval("window.__cad.measure()"),false);
 await cdp.send("Emulation.setDeviceMetricsOverride",{width:820,height:600,deviceScaleFactor:1,mobile:false});
 await delay(650);
 const width=await cdp.eval("window.__cad.state.width");
 assert(width>=800&&width<=830,"viewport must resize with container");
 const drawing=await cdp.eval("(()=>{window.__cad.drawing();return window.__cad.state})()");
 assert.equal(drawing.canvases,1,"scene replacement must not leak a canvas");
 assert(drawing.metrics.triangles>0,"solid HATCH produces real mesh triangles");
 assert.equal(drawing.drawingLayers,4,"DIMENSION, NURBS, solid and patterned HATCH must render");
 assert(drawing.metrics.size[0]>=100,"dimension and spline linework must retain actual drawing scale");
 assert.equal(await cdp.eval("window.__cad.png()"),true,"drawing can export a PNG preview");
 const sheet=await cdp.eval("(()=>{window.__cad.sheet();return window.__cad.state})()");
 assert.equal(sheet.canvases,1,"layout switching must dispose the old canvas");
 assert.equal(sheet.drawingLayout,"A1");
 assert.equal(sheet.drawingLayers,1,"model-space elements must not leak into a paper layout");
 assert(sheet.metrics.size[0]<30,"paper layout must be fitted independently");
 assert.equal(await cdp.eval("window.__cad.png()"),true,"paper layout can export independently");
 const projected=await cdp.eval("(()=>{window.__cad.projected();return window.__cad.state})()");
 assert.equal(projected.canvases,1,"projected sheet must not leak WebGL canvases");
 assert.equal(projected.drawingLayout,"P1");
 assert.equal(projected.drawingLayers,2,"projected paper sheet contains frame and model source layer");
 assert.equal(projected.projectedViewports,1,"paper viewport completeness is surfaced");
 assert.equal(projected.projectedSegments,2,"clipped model line must render in paper viewport");
 assert(projected.metrics.size[0]>=39&&projected.metrics.size[0]<=41);
 await cdp.send("Emulation.setDeviceMetricsOverride",{width:500,height:700,deviceScaleFactor:1,mobile:false});
 await delay(400);
 const narrow=await cdp.eval("window.__cad.state.width");
 assert(narrow>=490&&narrow<=505,"projected paper layout remains responsive in narrow viewport");
 assert.equal(await cdp.eval("window.__cad.dispose()"),0,"dispose must remove WebGL canvas");
 console.log("CAD_BROWSER_PASS Chrome WebGL: 3D navigation, real paper VIEWPORT line projection, DXF geometry, responsive sizes and disposal");
}finally{
 cdp?.ws.close();
 // Chrome forks GPU/network/storage children; killing only the browser PID
 // leaves processes writing into the profile while it is being removed.
 try{if(chrome.pid)process.kill(-chrome.pid,"SIGKILL");}
 catch{chrome.kill("SIGKILL");}
 if(chrome.exitCode===null){
  await Promise.race([
   new Promise(resolve=>chrome.once("exit",resolve)),
   delay(5000),
  ]);
 }
 await new Promise(resolve=>server.close(resolve));
 await rm(directory,{recursive:true,force:true,maxRetries:25,retryDelay:200});
}
