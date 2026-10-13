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
 // Real Chrome layout and keyboard acceptance for the mixed folder/file table.
 // Read-only: selecting a row, focusing an opener and measuring rectangles
 // never creates, edits, moves or deletes any repository/user content.
 for(const width of [2048,1440,1024,820,540,390]){
  await send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
  await wait(220);
  const geometry=await evaluate(`(()=>{
   const table=document.querySelector("table.file-table");
   const pane=document.querySelector(".work-body");
   const folder=document.querySelector(".explorer-list-folder");
   const name=folder?.querySelector(".file-name");
   const button=folder?.querySelector(".folder-inline-open");
   const cell=folder?.querySelector("td.col-name");
   if(!table||!pane||!folder||!button||!name||!cell)return null;
   const rect=el=>el.getBoundingClientRect();
   const columns=["select","name","size","version","date","actions"]
    .map(key=>{const th=table.querySelector("th.col-"+key);return {key,width:rect(th).width,visible:getComputedStyle(th).display!=="none"};});
   const mobile=table.querySelector(".file-mobile-actions");
   const firstFile=table.querySelector("tr.file-entry");
   return {width:innerWidth,pane:pane.clientWidth,pageOverflow:document.documentElement.scrollWidth-innerWidth,
    folderHeight:rect(folder).height,fileHeight:firstFile?rect(firstFile).height:null,
    tableWidth:rect(table).width,columns,folderOnly:table.classList.contains("file-table-folders-only"),
    visibleFiles:table.querySelectorAll("tr.file-entry").length,
    folderCells:[...folder.querySelectorAll("td.col-size,td.col-version,td.col-date")].map(el=>el.textContent.trim()),
    buttonWidth:rect(button).width,buttonRight:rect(button).right,nameRight:rect(name).right,
    cellRight:rect(cell).right,mobileDisplay:mobile?getComputedStyle(mobile).display:null,
    buttonFont:getComputedStyle(button).fontSize};
  })()`);
  assert(geometry,"file-list rows must remain visible at "+width);
  assert.equal(geometry.width,width,"emulated layout viewport mismatch");
  assert(Math.abs(geometry.folderHeight-32)<=.5,"folder row is not 32px: "+JSON.stringify(geometry));
  if(geometry.fileHeight!==null)assert(Math.abs(geometry.fileHeight-32)<=.5,"file row is not 32px: "+JSON.stringify(geometry));
  assert(geometry.pageOverflow<=2,"page overflow: "+JSON.stringify(geometry));
  assert.equal(geometry.folderOnly,geometry.visibleFiles===0,"folder-only mode must follow visible file count");
  assert(geometry.folderCells.slice(0,2).every(text=>text===""),"folder size/version columns must be blank");
  assert(geometry.buttonRight<=geometry.cellRight+1,"folder opener spills into next column: "+JSON.stringify(geometry));
  assert(geometry.columns[1].width>80,"file name collapsed: "+JSON.stringify(geometry));
  if(geometry.folderOnly){
   assert.equal(geometry.visibleFiles,0,"folder-only grid must not hide files");
   assert.deepEqual(geometry.columns.filter(col=>col.visible).map(col=>col.key),
    geometry.pane<=560?["select","name","actions"]:["select","name","date","actions"],
    "folder-only grid must retain selection and actions; date is visible above mobile breakpoint");
  }else if(geometry.pane>1400){
   assert(geometry.columns[1].width/geometry.tableWidth<=0.55,"name monopolizes wide mixed table");
  }
  if(geometry.pane<=560){
   assert(geometry.buttonWidth<=25&&geometry.buttonFont==="0px","compact folder opener must fit the 24px grid");
   if(geometry.mobileDisplay)assert.notEqual(geometry.mobileDisplay,"none","compact file menu missing");
  }else if(geometry.mobileDisplay){
   assert.equal(geometry.mobileDisplay,"none","duplicate mobile menu in desktop layout");
  }
  await evaluate('(()=>{const row=document.querySelector(".explorer-list-folder");if(row&&!row.classList.contains("selected"))row.click();})()');
  await wait(220);
  const selected=await evaluate('(()=>{const row=document.querySelector(".explorer-list-folder");const button=row?.querySelector(".folder-inline-open");return {selected:row?.classList.contains("selected"),opacity:Number(getComputedStyle(button).opacity)}})()');
  assert(selected.selected&&selected.opacity>=0.95,"selected folder must reveal opener: "+JSON.stringify(selected));
  console.log("EXPLORER_LIST_LAYOUT_PASS",width+"px",JSON.stringify({pane:geometry.pane,columns:geometry.columns.map(x=>Math.round(x.width)),button:Math.round(geometry.buttonWidth)}));
 }
 // Exercise the *actual React state transition* to folder-only layout using
 // the local filename filter; never alter a server resource to make a fixture.
 await send("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:1,mobile:false});
 const folderQuery=await evaluate(`(()=>{
  const fileNames=[...document.querySelectorAll("tr.file-entry .file-name")].map(e=>e.textContent.toLocaleLowerCase());
  return [...document.querySelectorAll(".explorer-list-folder .file-name")]
   .map(e=>e.textContent).find(name=>name&&!fileNames.some(file=>file.includes(name.toLocaleLowerCase())))||null;
 })()`);
 assert(folderQuery,"a folder name distinct from loaded file names is required for read-only filtering");
 async function setLocalFilter(value){
  await evaluate(`(()=>{
   const input=document.querySelector(".filter-search-input");
   const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;
   setter.call(input,${JSON.stringify(value)});
   input.dispatchEvent(new Event("input",{bubbles:true}));
  })()`);
 }
 await setLocalFilter(folderQuery);
 await until('!!document.querySelector("table.file-table-folders-only .explorer-list-folder")');
 const folderOnlyColumns=await evaluate(`(()=>{
  const table=document.querySelector("table.file-table-folders-only");
  return {files:table.querySelectorAll("tr.file-entry").length,
   columns:[...table.querySelectorAll("thead th")].filter(e=>getComputedStyle(e).display!=="none").map(e=>e.textContent.trim()),
   overflow:document.documentElement.scrollWidth-innerWidth};
 })()`);
 assert.deepEqual(folderOnlyColumns.columns,["","文件名","修改日期","操作"],"folder-only view must retain modified date and actions");
 assert.equal(folderOnlyColumns.files,0);
 assert(folderOnlyColumns.overflow<=2);
 await evaluate('document.querySelector(".batch-clear-selection")?.click()');
 await until('!document.querySelector(".batch-actions-group")');
 await evaluate('document.querySelector("table.file-table-folders-only .explorer-list-folder")?.click()');
 await until('document.querySelector("table.file-table-folders-only .explorer-list-folder")?.getAttribute("aria-selected")==="true"');
 assert((await evaluate('document.querySelector(".file-selected-count")?.textContent')).includes("已选 1"),
  "folder single selection must enter the contextual toolbar");
 await evaluate('document.querySelector("table.file-table-folders-only .explorer-list-folder")?.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:280,clientY:340}))');
 await until('!!document.querySelector("[role=menu][aria-label^=文件夹操作]")');
 const folderMenuLabels=await evaluate('[...document.querySelectorAll("[role=menu] .menu-label")].map(el=>el.textContent)');
 for(const label of ["打开","收藏","重命名","移动到…","删除"])assert(folderMenuLabels.includes(label),"missing folder context action: "+label);
 await evaluate('document.querySelector("[role=menu]")?.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');
 await evaluate('document.querySelector(".batch-clear-selection")?.click()');
 await until('!document.querySelector(".batch-actions-group")');
 await setLocalFilter("");
 await until('!!document.querySelector("table.file-table:not(.file-table-folders-only) tr.file-entry")');
 console.log("EXPLORER_FOLDER_ONLY_REACT_PASS",JSON.stringify(folderOnlyColumns));

 // Read-only interaction checks run against the actual React rows. Pick a
 // folder with multiple loaded files if the root does not contain enough.
 let fileCount=await evaluate('document.querySelectorAll("tr.file-entry").length');
 if(fileCount<4){
  const folderCount=await evaluate('document.querySelectorAll(".explorer-list-folder").length');
  for(let index=0;index<Math.min(folderCount,24)&&fileCount<4;index++){
   await navigate("/doc",'!!document.querySelector(".explorer-list-folder .folder-inline-open")');
   await evaluate(`document.querySelectorAll(".explorer-list-folder .folder-inline-open")[${index}]?.click()`);
   await wait(650);
   fileCount=await evaluate('document.querySelectorAll("tr.file-entry").length');
  }
 }
 assert(fileCount>=4,"read-only multi-selection check requires four real files; loaded="+fileCount);
 if(await evaluate('!!document.querySelector(".explorer-list-folder")')){
  await evaluate('document.querySelector(".explorer-list-folder").click()');
  await evaluate('document.querySelector("tr.file-entry").dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true,ctrlKey:true}))');
  await until('document.querySelector(".explorer-list-folder")?.getAttribute("aria-selected")==="true"&&document.querySelector("tr.file-entry")?.getAttribute("aria-selected")==="true"');
  assert((await evaluate('document.querySelector(".file-selected-count")?.textContent')).includes("已选 2"),
   "Ctrl+click must combine folder and file selection");
  await evaluate('document.querySelector(".batch-clear-selection")?.click()');
  await until('!document.querySelector(".batch-actions-group")');
 }
 const selection=()=>evaluate(`(()=>{
  const rows=[...document.querySelectorAll("tr.file-entry")];
  const active=document.activeElement?.closest(".file-entry");
  const header=document.querySelector('thead .col-select input[type="checkbox"]');
  return {count:rows.filter(row=>row.getAttribute("aria-selected")==="true").length,
   total:rows.length,activeIndex:rows.indexOf(active),headerChecked:header?.checked,
   headerMixed:header?.indeterminate,selected:[...rows].map((row,i)=>row.getAttribute("aria-selected")==="true"?i:-1).filter(i=>i>=0)};
 })()`);
 const key=(code,options={})=>evaluate(`(()=>{
  const row=document.activeElement?.closest(".file-entry")||document.querySelector("tr.file-entry");
  row.focus();
  row.dispatchEvent(new KeyboardEvent("keydown",{bubbles:true,cancelable:true,key:${JSON.stringify(code)},...(${JSON.stringify(options)})}));
  return true;
 })()`);
 await evaluate('document.querySelectorAll("tr.file-entry input[type=checkbox]")[0].click()');
 await until('[...document.querySelectorAll("tr.file-entry")].filter(row=>row.getAttribute("aria-selected")==="true").length===1');
 await evaluate('document.querySelectorAll("tr.file-entry input[type=checkbox]")[3].dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true,shiftKey:true}))');
 await until('[...document.querySelectorAll("tr.file-entry")].filter(row=>row.getAttribute("aria-selected")==="true").length===4');
 let state=await selection();
 assert.deepEqual(state.selected,[0,1,2,3],"Shift+checkbox must select the anchor range");
 assert(state.headerMixed&&!state.headerChecked,"header checkbox must become indeterminate");
 await evaluate('document.querySelectorAll("tr.file-entry")[0].focus()');
 await key("a",{ctrlKey:true});
 await until('document.querySelector("thead .col-select input[type=checkbox]")?.checked');
 state=await selection();
 assert.equal(state.count,state.total,"Ctrl+A selects exactly the visible loaded file rows");
 await key("Escape");
 await until('[...document.querySelectorAll("tr.file-entry")].every(row=>row.getAttribute("aria-selected")!=="true")');
 await evaluate('document.querySelectorAll("tr.file-entry")[0].focus()');
 await key("ArrowDown");
 await until('document.activeElement===document.querySelectorAll("tr.file-entry")[1]');
 await key("ArrowDown",{shiftKey:true});
 await until('document.activeElement===document.querySelectorAll("tr.file-entry")[2]');
 state=await selection();
 assert.deepEqual(state.selected,[1,2],"Shift+ArrowDown must extend from the focused row");
 await key("End");
 await until('document.activeElement===document.querySelectorAll("tr.file-entry")[document.querySelectorAll("tr.file-entry").length-1]');
 await key("Home");
 await until('document.activeElement===document.querySelectorAll("tr.file-entry")[0]');
 console.log("EXPLORER_KEYBOARD_SELECTION_PASS",JSON.stringify({loaded:state.total,range:state.selected,homeEnd:true,ctrlA:true}));

 // Render a 160-row, mixed CJK/ASCII long-name fixture only in an inert,
 // offscreen DOM clone. This measures CSS and scroll behavior without writing
 // any server data or simulating nonexistent API results.
 const longNameLayout=await evaluate(`(()=>{
  const sample=document.querySelector("tr.file-entry");
  const header=document.querySelector("table.file-table thead").cloneNode(true);
  const results=[];
  for(const width of [360,720,1240]){
   const host=document.createElement("div");
   host.className="work-body";
   Object.assign(host.style,{position:"fixed",left:"-20000px",top:"0",width:width+"px",height:"600px",pointerEvents:"none"});
   host.setAttribute("aria-hidden","true");
   const scroller=document.createElement("div");
   scroller.className="table explorer-striped-list";
   const table=document.createElement("table");
   table.className="file-table file-table-ultra rare-data-table";
   const body=document.createElement("tbody");
   table.append(header.cloneNode(true),body);
   for(let i=0;i<160;i++){
    const row=sample.cloneNode(true);
    row.classList.remove("selected","focused","drag-source");
    row.setAttribute("aria-selected","false");
    // Include a folder in the same DOM order as regular files; the zebra
    // pattern must not restart at the folder/file boundary.
    if(i===0){row.className="explorer-list-folder";row.removeAttribute("data-file-entry");}
    if(i===3){row.classList.add("selected");row.setAttribute("aria-selected","true");}
    row.querySelector(".file-name").textContent="超长文件名称-机械设计版本-工程审计-"+("ABC0123456789".repeat(16))+"-"+i+".docx";
    body.append(row);
   }
   scroller.append(table);host.append(scroller);document.body.append(host);
   const label=body.querySelector(".file-name"),cell=body.querySelector(".col-name");
   const style=getComputedStyle(label);
   const rows=[...body.rows],firstCell=row=>row.cells[0],nameCell=row=>row.querySelector(".file-name");
   const surface=row=>getComputedStyle(firstCell(row)).backgroundColor;
   results.push({width,rows:body.rows.length,nameSize:label.clientWidth,nameScroll:label.scrollWidth,
    cellWidth:cell.clientWidth,tableWidth:table.getBoundingClientRect().width,
    viewportScroll:document.documentElement.scrollWidth-innerWidth,
    ellipsis:style.textOverflow,nowrap:style.whiteSpace,
    scrollerWidth:scroller.clientWidth,scrollerScroll:scroller.scrollWidth,
    rowHeights:rows.slice(0,4).map(row=>row.getBoundingClientRect().height),
    rowSurfaces:rows.slice(0,4).map(surface),
    selectedNameColor:getComputedStyle(nameCell(rows[3])).color,
    cellBorder:getComputedStyle(firstCell(rows[1])).borderBottomWidth,
    firstRadius:getComputedStyle(firstCell(rows[1])).borderTopLeftRadius,
    lastRadius:getComputedStyle(rows[1].cells[rows[1].cells.length-1]).borderTopRightRadius});
   host.remove();
  }
  return results;
 })()`);
 for(const sample of longNameLayout){
  assert.equal(sample.rows,160);
  assert(sample.nameSize<sample.nameScroll,"long filename should ellipsize at "+sample.width);
  assert.equal(sample.ellipsis,"ellipsis");
  assert.equal(sample.nowrap,"nowrap");
  assert(sample.cellWidth<=sample.scrollerWidth,"filename cell overflow at "+sample.width);
  assert(sample.viewportScroll<=2,"long-name clone caused page overflow");
  assert(sample.rowHeights.every(height=>Math.abs(height-32)<=.5),"folder/file row heights must all be 32px at "+sample.width);
  assert.equal(sample.rowSurfaces[0],sample.rowSurfaces[2],"base stripes match at "+sample.width);
  assert.notEqual(sample.rowSurfaces[0],sample.rowSurfaces[1],"adjacent row stripes differ at "+sample.width);
  assert.equal(sample.rowSurfaces[3],"rgb(36, 92, 181)","selected row uses deep blue at "+sample.width);
  assert.equal(sample.selectedNameColor,"rgb(255, 255, 255)","selected filename is white at "+sample.width);
  assert.equal(sample.cellBorder,"0px","no file-row separator line at "+sample.width);
  assert.equal(sample.firstRadius,"11px","row start rounded at "+sample.width);
  assert.equal(sample.lastRadius,"11px","row end rounded at "+sample.width);
 }
 console.log("EXPLORER_LONG_NAMES_160_PASS",JSON.stringify(longNameLayout));
 // Verify paging and large selection in the actual React component without
 // modifying the shared dev database. This Chrome tab alone substitutes
 // GET /api/files responses with a 130-item, three-page synthetic corpus.
 const mockBase=await evaluate(`(async()=>{
  const folder=new URLSearchParams(location.search).get("folder")||"folder_root";
  const response=await fetch("/api/files?folder="+encodeURIComponent(folder)+"&sort=updated_desc&limit=1");
  const reply=await response.json();
  return {folder,file:reply.data?.items?.[0]??null};
 })()`);
 assert(mockBase.file,"large-list browser check requires an existing authorized file template");
 const source=`(()=>{
  const original=window.fetch.bind(window);
  const favoriteWrites=[];
  const syntheticFavorites=new Set();
  window.__favoriteWrites=favoriteWrites;
  const folder=${JSON.stringify(mockBase.folder)};
  const base=${JSON.stringify(mockBase.file)};
  const corpus=Array.from({length:130},(_,index)=>({
   ...base,id:"browser-readonly-"+String(index).padStart(4,"0"),
   name:index%11===0?"审计-"+String(index).padStart(4,"0")+"-"+("CAD机械长文件名ABC123".repeat(24))+".docx":
    "审计模拟文件-"+String(index).padStart(4,"0")+".txt"
  }));
  window.fetch=(input,init)=>{
   const url=new URL(input instanceof Request?input.url:input,location.href);
   if(url.pathname==="/api/favorites"&&(!init?.method||init.method==="GET")){
    return Promise.resolve(new Response(JSON.stringify({ok:true,
     data:[...syntheticFavorites].map(id=>({id:"synthetic-"+id,kind:"file",fileId:id}))
    }),{status:200,headers:{"Content-Type":"application/json"}}));
   }
   if(url.pathname.startsWith("/api/favorites/file/browser-readonly-")){
    const method=init?.method??"GET";
    const id=url.pathname.split("/").pop();
    favoriteWrites.push({method,id});
    if(method==="PUT")syntheticFavorites.add(id);else syntheticFavorites.delete(id);
    return Promise.resolve(new Response(JSON.stringify({ok:true,data:{id,favorited:method==="PUT"}}),{status:200,headers:{"Content-Type":"application/json"}}));
   }
   if(url.pathname==="/api/files"&&url.searchParams.get("folder")===folder&&(!init?.method||init.method==="GET")){
    const cursor=url.searchParams.get("cursor")||"";
    const offset=cursor.startsWith("audit-page-")?Number(cursor.slice(11)):0;
    const limit=Math.min(200,Math.max(1,Number(url.searchParams.get("limit")||50)));
    const next=Math.min(corpus.length,offset+limit);
    return Promise.resolve(new Response(JSON.stringify({ok:true,data:{
     items:corpus.slice(offset,next),nextCursor:next<corpus.length?"audit-page-"+next:""
    }}),{status:200,headers:{"Content-Type":"application/json"}}));
   }
   return original(input,init);
  };
 })()`;
 const injection=await send("Page.addScriptToEvaluateOnNewDocument",{source});
 await navigate("/doc?folder="+encodeURIComponent(mockBase.folder),
  'document.querySelectorAll("tr.file-entry").length===50');
 for(const expected of [100,130]){
  await evaluate('document.querySelector(".file-page-controls button")?.click()');
  await until('document.querySelectorAll("tr.file-entry").length==='+expected);
 }
 const mockState=await evaluate(`(()=>{
  const rows=[...document.querySelectorAll("tr.file-entry")];
  const names=rows.map(row=>row.querySelector(".file-name")?.textContent);
  const long=rows.find(row=>row.querySelector(".file-name")?.scrollWidth>row.querySelector(".file-name")?.clientWidth);
  return {loaded:rows.length,unique:new Set(rows.map(row=>row.dataset.id)).size,
   longClipped:!!long&&long.querySelector(".file-name").title===long.querySelector(".file-name").textContent,
   pageOverflow:document.documentElement.scrollWidth-innerWidth};
 })()`);
 assert.equal(mockState.loaded,130);
 assert.equal(mockState.unique,130,"pagination must not duplicate file IDs");
 assert(mockState.longClipped,"React rows must clip long file names while preserving full titles");
 assert(mockState.pageOverflow<=2,"130 React rows widened the page");
 await until('!!document.querySelector("tr.file-entry .action-star-btn:not(:disabled)")');
 await evaluate('document.querySelector("tr.file-entry .action-star-btn").click()');
 await until('document.querySelector("tr.file-entry .action-star-btn.favorited:not(:disabled)")!==null');
 await evaluate('document.querySelector("tr.file-entry .action-star-btn").click()');
 await until('!!document.querySelector("tr.file-entry .action-star-btn:not(.favorited):not(:disabled)")');
 assert.deepEqual((await evaluate('window.__favoriteWrites.map(item=>item.method)')),["PUT","DELETE"],
  "favorite must issue persistence requests, not just animate the SVG");
 console.log("EXPLORER_FAVORITE_TOGGLE_PASS");
 await evaluate('document.querySelector("tr.file-entry").focus()');
 await key("End");
 await until('document.activeElement===document.querySelectorAll("tr.file-entry")[129]');
 const scroll=await evaluate('document.querySelector(".work-body>.table")?.scrollTop');
 assert(scroll>0,"End must scroll the actual file panel to row 130");
 // End intentionally selects the last row. Restore an unselected state before
 // comparing the default toolbar against the contextual selection toolbar.
 await key("Escape");
 await until('!!document.querySelector(".work-body>.file-toolbar .upload-button")');
 const defaultToolbar=await evaluate(`(()=>{
  const bar=document.querySelector(".work-body>.file-toolbar");
  const filters=bar?.querySelector(".toolbar-views");
  return {height:bar?.getBoundingClientRect().height,
   filtersLeft:filters?.getBoundingClientRect().left,
   upload:!!bar?.querySelector(".upload-button"),
   newFolder:!!bar?.querySelector(".new-folder-wrapper"),
   selected:!!bar?.querySelector(".batch-actions-group")};
 })()`);
 assert(defaultToolbar.upload&&defaultToolbar.newFolder&&!defaultToolbar.selected,
  "default toolbar must expose upload/create without a batch capsule");
 await key("a",{ctrlKey:true});
 await until('document.querySelector("thead .col-select input[type=checkbox]")?.checked');
 assert.equal((await selection()).count,130);
 const selectedFoldersAtLarge=await evaluate('[...document.querySelectorAll(".explorer-list-folder")].filter(row=>row.getAttribute("aria-selected")==="true").length');
 const selectedTotalAtLarge=130+selectedFoldersAtLarge;
 const batch=await evaluate(`(()=>{
  const group=document.querySelector(".batch-actions-group");
  const bar=document.querySelector(".work-body>.file-toolbar");
  return {text:group?.textContent||"",actions:[...(group?.querySelectorAll("button")||[])].map(b=>b.textContent.trim()),
   upload:!!bar?.querySelector(".upload-button"),newFolder:!!bar?.querySelector(".new-folder-wrapper"),
   height:bar?.getBoundingClientRect().height,
   filtersLeft:bar?.querySelector(".toolbar-views")?.getBoundingClientRect().left,
   printDisabled:group?.querySelector(".batch-btn[title*='打印']")?.disabled};
 })()`);
 assert(batch.text.includes("已选 "+selectedTotalAtLarge+" 项"),
  "batch count must include selected folders and the 130 loaded files");
 for(const action of ["下载","移动","删除"])assert(batch.actions.includes(action),"missing batch action "+action);
 assert(!batch.upload&&!batch.newFolder,"selection must replace upload/create in place");
 assert.equal(batch.height,defaultToolbar.height,"selection must not resize the toolbar");
 assert.equal(batch.filtersLeft,defaultToolbar.filtersLeft,"selection must not shift browse controls");
 assert(batch.printDisabled,"batch printing beyond 20 items must be disabled");
 if(selectedFoldersAtLarge){
  assert(await evaluate('document.querySelectorAll(".batch-actions-group .batch-btn")[2]?.disabled===true'),
   "unsupported mixed folder/file batch move must be disabled");
 }
 // Client-side filtering may hide a selected file, never silently remove it.
 await evaluate(`(()=>{
  const input=document.querySelector(".filter-search-input");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"审计模拟文件-0001");
  input.dispatchEvent(new Event("input",{bubbles:true}));
 })()`);
 await until('document.querySelector(".file-selection-hidden")?.textContent.includes("隐藏")');
 assert((await evaluate('document.querySelector(".file-selected-count")?.textContent')).includes("已选 "+selectedTotalAtLarge),
  "filtering must preserve the full selection including hidden files");
 await evaluate(`(()=>{
  const input=document.querySelector(".filter-search-input");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"");
  input.dispatchEvent(new Event("input",{bubbles:true}));
 })()`);
 await until('document.querySelectorAll("tr.file-entry").length===130');
 for(const width of [1440,980,700,390]){
  await send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
  await wait(160);
  const geometry=await evaluate(`(()=>{
   const bar=document.querySelector(".work-body>.file-toolbar");
   const left=bar?.getBoundingClientRect().left??0;
   const right=bar?.getBoundingClientRect().right??0;
   return {overflow:document.documentElement.scrollWidth-innerWidth,
    toolbarRight:right,viewportRight:innerWidth,
    actionsRight:bar?.querySelector(".batch-actions-group")?.getBoundingClientRect().right??0,
    toolbarLeft:left};
  })()`);
  assert(geometry.overflow<=2&&geometry.actionsRight<=geometry.toolbarRight+1&&geometry.toolbarRight<=geometry.viewportRight+1,
   "selected toolbar must fit at "+width+": "+JSON.stringify(geometry));
 }
 await send("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:1,mobile:false});
 await wait(160);
 // Open the real deletion review but NEVER activate confirmation. With a
 // selected folder the mixed-resource review replaces the file-only dialog.
 await evaluate('document.querySelector(".batch-actions-group .batch-btn.danger")?.click()');
 const reviewText=selectedFoldersAtLarge?"个文件夹":"以下 130 项将移入回收站";
 await wait(250);
 const reviewState=await evaluate(`(()=>{
  return {folders:[...document.querySelectorAll(".explorer-list-folder[aria-selected=true]")].length,
   dialogs:[...document.querySelectorAll("dialog")].map(d=>({open:d.open,text:d.textContent.slice(0,220)})),
   dangerDisabled:document.querySelector(".batch-actions-group .batch-btn.danger")?.disabled};
 })()`);
 console.log("EXPLORER_DELETE_REVIEW_OBSERVED",JSON.stringify(reviewState));
 await until('[...document.querySelectorAll("dialog[open]")].some(d=>d.textContent.includes('+JSON.stringify(reviewText)+'))');
 const cancelled=await evaluate(`(()=>{
  const button=[...document.querySelectorAll("dialog[open] button")].find(b=>["关闭","取消"].includes(b.textContent.trim()));
  if(!button)return false;
  button.click();
  return true;
 })()`);
 assert(cancelled,"large deletion review must provide a cancellation route");
 await until('![...document.querySelectorAll("dialog[open]")].some(d=>d.textContent.includes('+JSON.stringify(reviewText)+'))');
 assert.equal((await selection()).count,130,"cancel must preserve selected files");
 await key("Escape");
 await until('[...document.querySelectorAll("tr.file-entry")].every(row=>row.getAttribute("aria-selected")!=="true")');
 await until('!!document.querySelector(".file-toolbar .upload-button")&&!document.querySelector(".batch-actions-group")');
 console.log("EXPLORER_PAGING_130_REACT_PASS",JSON.stringify({...mockState,scroll}));
 await send("Page.removeScriptToEvaluateOnNewDocument",{identifier:injection.identifier});
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
