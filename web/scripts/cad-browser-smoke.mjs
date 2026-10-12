#!/usr/bin/env node
// Remote-only synthetic CAD viewport smoke. Exercises real WebGL/OrbitControls
// without modifying the application DB or opening a production route.
import assert from "node:assert/strict";
import {build} from "esbuild";
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import {mkdtempSync,existsSync,readFileSync} from "node:fs";
import {rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {setTimeout as delay} from "node:timers/promises";

const root=path.resolve("web");
// Optional downloaded mechanical DXF, stored outside git.
const samplePath="/tmp/filesmanage_public_dxf_20261011/02-机械支点零件.dxf";
const realDxf=existsSync(samplePath)?readFileSync(samplePath,"latin1"):"";
const source=String.raw`
import * as THREE from "three";
import {OrbitControls} from "three/examples/jsm/controls/OrbitControls.js";
import {mountEngineeringScene} from "./src/features/modelViewer/viewerScene.ts";
import {parseDxf} from "./src/features/modelViewer/dxf.ts";
import {printableSheetHtml} from "./src/features/modelViewer/printSheet.ts";
import {buildVectorSheet} from "./src/features/modelViewer/vectorSheet.ts";
const holder=document.getElementById("stage");
const realFixture=${JSON.stringify(realDxf).replace(/</g,"\\u003c")};
let controls=null,metrics=null,lastCamera=null,selectedLine=null;
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
  const source=layout==="REAL"&&realFixture?realFixture:layout==="INK"?[
   "0","SECTION","2","ENTITIES",
   "0","LINE","8","WHITE","420","16777215","10","-50","20","0","11","50","21","0",
   "0","LINE","8","CYAN","420","65535","10","0","20","-30","11","0","21","30",
   "0","ENDSEC","0","EOF",
  ].join("\n"):layout==="FONTS"?[
   "0","SECTION","2","TABLES","0","TABLE","2","STYLE",
   "0","STYLE","2","Comic Sans MS","3","comic.ttf",
   "0","STYLE","2","ARIAL","3","arial.ttf",
   "0","ENDTAB","0","ENDSEC",
   "0","SECTION","2","ENTITIES",
   "0","TEXT","8","FONTS","7","Comic Sans MS","10","0","20","0","40","5",
   "1","ABCDEFGHJKLMNOPQRSTUVWXYZ 0123456789",
   "0","TEXT","8","FONTS","7","ARIAL","10","0","20","15","40","5",
   "1","ABCDEFGHJKLMNOPQRSTUVWXYZ 0123456789",
   "0","ENDSEC","0","EOF",
  ].join("\n"):layout==="DIM"?[
   "0","SECTION","2","HEADER","9","$INSUNITS","70","4","0","ENDSEC",
   "0","SECTION","2","TABLES","0","TABLE","2","DIMSTYLE",
   "0","DIMSTYLE","2","ANNOTATED","40","1","41","2",
   "140","3","271","2",
   "0","ENDTAB","0","ENDSEC",
   "0","SECTION","2","ENTITIES",
   "0","DIMENSION","8","DIM","2","*ABSENT","3","ANNOTATED",
   "70","0","10","5","20","12",
   "13","5","23","5","14","35","24","5","50","0","1","<>",
   "0","ENDSEC","0","EOF",
  ].join("\n"):layout==="PLOT"?[
   "0","SECTION","2","HEADER","9","$INSUNITS","70","4","0","ENDSEC",
   "0","SECTION","2","ENTITIES",
   "0","LINE","8","FRAME","410","PLOT","67","1","10","0","20","0","11","40","21","0",
   "0","LINE","8","FRAME","410","PLOT","67","1","10","40","20","0","11","40","21","20",
   "0","LINE","8","FRAME","410","PLOT","67","1","10","40","20","20","11","0","21","20",
   "0","LINE","8","FRAME","410","PLOT","67","1","10","0","20","20","11","0","21","0",
   "0","LINE","8","DETAIL","410","PLOT","67","1",
   "10","5","20","5","11","35","21","5",
   "0","ENDSEC","0","EOF",
  ].join("\n"):(layout==="P1"||layout==="P2")?[
   "0","SECTION","2","TABLES","0","TABLE","2","LAYER",
   "0","LAYER","5","AC","2","FILL","62","3",
   "0","ENDTAB","0","ENDSEC",
   "0","SECTION","2","ENTITIES",
   "0","LINE","8","CUT","62","1","10","-20","20","10","11","60","21","10",
   "0","HATCH","8","FILL","70","1","75","0","91","1",
   "92","2","72","0","73","1","93","4",
   "10","-10","20","-10","10","50","20","-10",
   "10","50","20","30","10","-10","20","30","97","0",
   "0","TEXT","8","LABEL","10","-4","20","10","40","5","1","NOTE",
   "0","VIEWPORT","8","FRAME","410",layout,"67","1","69","2",
   "10","100","20","50","40","40","41","20",
   ...(layout==="P2"?["331","AC"]:[]),
   "12","20","22","10","45","20","51","0",
   "0","ENDSEC","0","EOF",
  ].join("\n"):dxf;
  actualDrawing=parseDxf(source,THREE,layout);
  if(actualDrawing.skipped.length&&layout!=="REAL"&&layout!=="FONTS"&&!(layout==="DIM"&&
   actualDrawing.skipped.every(message=>message.includes("DIMENSION:")&&message.includes("近似重建"))))
   throw Error(actualDrawing.skipped.join(","));
  object=actualDrawing.object;
 }
 controls=mountEngineeringScene(THREE,OrbitControls,holder,object,drawing,m=>{metrics=m;},
  ()=>{throw Error("WebGL context unexpectedly lost");},()=>{},callback,
  line=>{selectedLine=line;},actualDrawing?.unit??"");
}
mount();
window.__cad={
 get state(){return {metrics,camera:lastCamera,canvases:holder.querySelectorAll("canvas").length,
  drawingFilter:holder.querySelector("canvas")?.style.filter??"",
  selectedLength:selectedLine?.length??null,
  annotatedLabels:holder.querySelectorAll(".cad-coordinate-ruler rect[rx]").length,
  width:holder.querySelector("canvas")?.getBoundingClientRect().width??0,
  coordinateRulers:holder.querySelectorAll(".cad-coordinate-ruler").length,
  rulerTicks:holder.querySelectorAll(".cad-coordinate-ruler text").length,
  rulerGridLines:holder.querySelectorAll(".cad-coordinate-ruler path[stroke]").length,
  rulerText:holder.querySelector(".cad-coordinate-ruler")?.textContent??"",
  inkColors:actualDrawing?.object.children.map(g=>[g.name,
   g.children.find(n=>n.isLineSegments)?.material.color.getHex()])??[],
  drawingLayers:actualDrawing?.layers.length??0,
  drawingLayout:actualDrawing?.layout??null,layoutCount:actualDrawing?.layouts.length??0,
  dxfWarnings:actualDrawing?.skipped.length??0,
  dimensionSprites:actualDrawing?.object.children.reduce((sum,g)=>sum+
   g.children.filter(n=>n.isSprite).length,0)??0,
  dimensionSegments:actualDrawing?.object.children.reduce((sum,g)=>sum+
   g.children.filter(n=>n.isLineSegments).reduce((inner,n)=>
    inner+n.geometry.getAttribute("position").count/2,0),0)??0,
  projectedViewports:actualDrawing?.viewports.projected??0,
  projectedHatches:actualDrawing?.object.children.reduce((sum,g)=>sum+
   g.children.filter(n=>n.name==="VIEWPORT_HATCH").length,0)??0,
  projectedText:actualDrawing?.object.children.reduce((sum,g)=>sum+
   g.children.filter(n=>n.name==="VIEWPORT_TEXT").length,0)??0,
  projectedSegments:actualDrawing?.object.children.find(g=>g.name==="CUT")?.
   children.find(g=>g.isLineSegments)?.geometry.getAttribute("position").count??0};},
 view:name=>controls.setStandardView(name),
 projection:()=>controls.toggleProjection(),
 measure:()=>controls.toggleMeasure(),
 theme:()=>controls.toggleDrawingTheme(),
 lineLabels:()=>controls.toggleLengthLabels(),
 pickCenter:()=>{
  const canvas=holder.querySelector("canvas"),r=canvas.getBoundingClientRect();
  const x=r.left+r.width/2,y=r.top+r.height/2;
  for(const name of ["pointerdown","pointerup"])
   canvas.dispatchEvent(new PointerEvent(name,{bubbles:true,clientX:x,clientY:y,button:0}));
  return selectedLine?.length??null;
 },
 focus:()=>{const mesh=holder.querySelector("canvas");return Boolean(mesh)&&Boolean(controls.resetView());},
 grid:()=>controls.toggleGrid(),
 drawing:()=>mount(true),
 ink:()=>mount(true,"INK"),
 real:()=>mount(true,"REAL"),
 sheet:()=>mount(true,"A1"),
 projected:()=>mount(true,"P1"),
 frozen:()=>mount(true,"P2"),
 plot:()=>mount(true,"PLOT"),
 dimension:()=>mount(true,"DIM"),
 fonts:()=>{
  mount(true,"FONTS");
  return actualDrawing.object.children.flatMap(g=>g.children.filter(n=>n.isSprite).map(n=>({
   requested:n.userData.cadFontRequested,
   family:n.userData.cadFontFamily,
   approximate:n.userData.cadFontApproximate,
   pixels:n.material.map.image.toDataURL("image/png").slice(0,2000),
   width:n.material.map.image.width,
  })));
 },
  png:()=>controls.exportPng()?.startsWith("data:image/png;base64,")??false,
  modelPrint:()=>{
   const camera={...lastCamera};
   const before=controls.exportPng();
   const views=controls.captureEngineeringViews();
   const after=controls.exportPng();
   return{all:Object.values(views).every(v=>v.startsWith("data:image/png;base64,")&&v.length>1000),
    cameraUnchanged:JSON.stringify(camera)===JSON.stringify(lastCamera),canvasCount:holder.querySelectorAll("canvas").length,
    afterCapture:!!before&&!!after};
  },
 printPreview:()=>printableSheetHtml(controls.exportPng(),"A3","A1").includes("@page{size:A3 landscape"),
 vectorPlot:()=>{
  const a4=buildVectorSheet(actualDrawing.object,{sheet:"A4",scale:1,unit:actualDrawing.unit,layout:"PLOT"});
  return{size:a4.drawingMm,physical:a4.svg.includes('width="297mm" height="210mm"'),
   svg:a4.svg.includes("stroke-width="),title:a4.html.includes("1:1")};
 },
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
  const engineering=await cdp.eval("window.__cad.modelPrint()");
  assert(engineering.all,"all four orthographic model projections must be real PNG images");
  assert(engineering.cameraUnchanged,"print capture cannot move the user's active camera");
  assert.equal(engineering.canvasCount,1,"print capture cannot leak a second WebGL canvas");
  assert(engineering.afterCapture,"normal screen capture still works after print capture");
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
 let width=0;
 for(let attempt=0;attempt<18;attempt++){
  await delay(150);
  width=await cdp.eval("window.__cad.state.width");
  if(width>=800&&width<=830)break;
 }
 assert(width>=800&&width<=830,
  "viewport must resize with container (observed "+String(width)+"px)");
 const drawing=await cdp.eval("(()=>{window.__cad.drawing();return window.__cad.state})()");
 assert.equal(drawing.canvases,1,"scene replacement must not leak a canvas");
 assert.match(drawing.drawingFilter,/invert/,"2D must default to an accessible dark CAD review workspace");
 assert(drawing.metrics.triangles>0,"solid HATCH produces real mesh triangles");
 assert.equal(drawing.drawingLayers,4,"DIMENSION, NURBS, solid and patterned HATCH must render");
 assert(drawing.metrics.size[0]>=100,"dimension and spline linework must retain actual drawing scale");
 assert.equal(await cdp.eval("window.__cad.png()"),true,"drawing can export a PNG preview");
 await cdp.eval("window.__cad.ink()");
 await delay(130);
 const bounds=await cdp.eval("(()=>{const r=document.querySelector('#stage canvas').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()");
 await cdp.send("Input.dispatchMouseEvent",{type:"mousePressed",x:bounds.x,y:bounds.y,button:"left",clickCount:1});
 await cdp.send("Input.dispatchMouseEvent",{type:"mouseReleased",x:bounds.x,y:bounds.y,button:"left",clickCount:1});
 await delay(160);
 const inspected=await cdp.eval("window.__cad.state.selectedLength");
 assert(Math.abs(inspected-100)<.01,
  "clicking real CAD line reveals its 100-unit source length (actual "+String(inspected)+")");
 await delay(120);
 assert((await cdp.eval("window.__cad.state.annotatedLabels"))>0,"length is shown over selected line");
 assert.equal(await cdp.eval("window.__cad.theme()"),false,"paper theme toggle should disable dark mode");
 assert.equal(await cdp.eval("window.__cad.state.drawingFilter"),"none");
 assert.equal(await cdp.eval("window.__cad.theme()"),true);
 assert.equal(await cdp.eval("window.__cad.lineLabels()"),false);
 assert.equal(await cdp.eval("window.__cad.lineLabels()"),true);
 await cdp.eval("window.__cad.ink()");
 await delay(120);
 const ink=await cdp.eval("window.__cad.state");
 assert.equal(ink.coordinateRulers,1,"a single screen-space XY coordinate ruler must be present");
 assert(ink.rulerTicks>=3,"CAD coordinate ticks must be legible on both axes");
 assert.match(ink.rulerText,/XY/);
 assert.match(ink.rulerText,/X .*Y /,"live pointer coordinate display must exist");
 assert(ink.rulerGridLines>=3,"DXF grid must be visible without manually enabling it");
 assert.equal(new Map(ink.inkColors).get("WHITE"),0x172a3b,
  "white TrueColor DXF lines cannot disappear on white paper");
 assert.notEqual(new Map(ink.inkColors).get("CYAN"),0x00ffff,
  "low-contrast cyan DXF lines must be darkened for white paper");
 assert.equal(await cdp.eval("window.__cad.grid()"),false,
  "first toggle must disable the default-on drawing grid");
 let noGrid=await cdp.eval("window.__cad.state");
 for(let attempt=0;attempt<20&&noGrid.rulerGridLines!==1;attempt++){
  await delay(100);
  noGrid=await cdp.eval("window.__cad.state");
 }
 assert.equal(noGrid.rulerGridLines,1,"user can hide the grid while keeping coordinate rulers");
 assert.equal(await cdp.eval("window.__cad.grid()"),true,
  "second toggle must restore the default drawing grid");
 let withGrid=await cdp.eval("window.__cad.state");
 for(let attempt=0;attempt<20&&withGrid.rulerGridLines<3;attempt++){
  await delay(100);
  withGrid=await cdp.eval("window.__cad.state");
 }
 assert(withGrid.rulerGridLines>=3,"grid can be turned back on without losing rulers");
 const sheet=await cdp.eval("(()=>{window.__cad.sheet();return window.__cad.state})()");
 assert.equal(sheet.canvases,1,"layout switching must dispose the old canvas");
 await delay(100);
 assert((await cdp.eval("window.__cad.state.rulerGridLines"))>=3,
  "paper layouts should also start with the coordinate grid visible");
 assert.equal(sheet.drawingLayout,"A1");
 assert.equal(sheet.drawingLayers,1,"model-space elements must not leak into a paper layout");
 assert(sheet.metrics.size[0]<30,"paper layout must be fitted independently");
 assert.equal(await cdp.eval("window.__cad.png()"),true,"paper layout can export independently");
 const projected=await cdp.eval("(()=>{window.__cad.projected();return window.__cad.state})()");
 assert.equal(projected.canvases,1,"projected sheet must not leak WebGL canvases");
 assert.equal(projected.coordinateRulers,1,"layout changes must not leak or duplicate SVG rulers");
 assert.equal(projected.drawingLayout,"P1");
 assert.equal(projected.drawingLayers,4,"paper sheet contains projected lines, fill and annotations");
 assert.equal(projected.projectedViewports,1,"paper viewport completeness is surfaced");
 assert.equal(projected.projectedSegments,2,"clipped model line must render in paper viewport");
 assert.equal(projected.projectedHatches,1,"solid fill projected as clipped triangles");
 assert.equal(projected.projectedText,1,"raster engineering text projected as clipped textured geometry");
 assert(projected.metrics.size[0]>=39&&projected.metrics.size[0]<=41);
 assert.equal(await cdp.eval("window.__cad.printPreview()"),true,"A3 paper preview applies physical paper dimensions");
 const frozen=await cdp.eval("(()=>{window.__cad.frozen();return window.__cad.state})()");
 assert.equal(frozen.canvases,1);
 assert.equal(frozen.projectedHatches,0,"viewport-specific frozen layer excludes only that layer");
 assert.equal(frozen.projectedText,1);
 assert.equal(frozen.projectedSegments,2);
 const printPage=await cdp.eval("(()=>{window.__cad.plot();return window.__cad.vectorPlot()})()");
 assert.deepEqual(printPage.size,[40,20],"mm-authored browser drawing must preserve 1:1 millimetre extent");
 assert(printPage.physical&&printPage.svg&&printPage.title,
  "real Chrome must produce a physical-size SVG engineering plot");
 const fallbackDimension=await cdp.eval("(()=>{window.__cad.dimension();return window.__cad.state})()");
 assert(fallbackDimension.dimensionSprites>0,
  "Chrome must create a visible glyph for a supported missing-block dimension");
 assert(fallbackDimension.dimensionSegments>=5,
  "Chrome must render dimension line, extension lines and arrow outlines");
 assert.equal(await cdp.eval("window.__cad.png()"),true,
  "fallback dimension linework must remain renderable in actual WebGL");
const fonts=await cdp.eval("window.__cad.fonts()");
 if(realDxf){
  const real=await cdp.eval("(()=>{window.__cad.real();return window.__cad.state})()");
  assert(real.metrics.size[0]>1&&real.metrics.size[0]<100000,
   "authentic mechanical DXF should have bounded XY extents");
  assert(real.dimensionSegments>50,"authentic mechanical DXF should render substantial linework");
  assert.match(real.drawingFilter,/invert/,"actual drawing must use dark CAD review canvas");
  assert.equal(real.coordinateRulers,1);
  assert.equal(await cdp.eval("window.__cad.png()"),true);
 }
 assert.equal(fonts.length,2);
 assert.match(fonts[0].family,/Comic Sans MS/);
 assert.match(fonts[1].family,/Arial/);
 assert.equal(fonts[0].approximate,true);
 assert.notEqual(fonts[0].pixels,fonts[1].pixels,
  "actual Chromium must rasterize a visibly different glyph set for Comic Sans vs Arial");
 await cdp.send("Emulation.setDeviceMetricsOverride",{width:500,height:700,deviceScaleFactor:1,mobile:false});
 let narrow=0;
 for(let attempt=0;attempt<18;attempt++){
  await delay(150);
  narrow=await cdp.eval("window.__cad.state.width");
  if(narrow>=490&&narrow<=505)break;
 }
 assert(narrow>=490&&narrow<=505,
  "projected paper layout remains responsive in narrow viewport (observed "+String(narrow)+"px)");
 const narrowRuler=await cdp.eval("window.__cad.state");
 assert.equal(narrowRuler.coordinateRulers,1);
 assert(narrowRuler.rulerTicks>1,"narrow 500px viewport must keep coordinate ticks");
 assert.equal(await cdp.eval("window.__cad.dispose()"),0,"dispose must remove WebGL canvas");
 assert.equal(await cdp.eval("window.__cad.state.coordinateRulers"),0,
  "disposing viewport must remove coordinate ruler");
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
