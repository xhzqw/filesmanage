#!/usr/bin/env node
// 远端真实 Chrome：十种工作视图、四种尺寸、父子路由及唯一创建入口回归。
// 不创建、修改或删除业务记录；项目视图切换仅保存当前用户的视图偏好。
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {readFileSync,mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";

const base=(process.argv[2]||"http://127.0.0.1:18091").replace(/\/+$/,"");
const password=readFileSync(process.argv[3]||".secrets/admin.password","utf8").trim();
const port=18000+process.pid%17000,profile=mkdtempSync(join(tmpdir(),"fm-cdw-browser-"));
const chrome=spawn("/usr/bin/google-chrome",[
 "--headless=new","--no-sandbox","--disable-dev-shm-usage","--remote-debugging-port="+port,
 "--user-data-dir="+profile,"--window-size=1440,900","about:blank"],{stdio:"ignore",detached:true});
let ws,sequence=0;
const pending=new Map();
function send(method,params={}){
 const id=++sequence;
 return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
}
async function evalJS(expression){
 const result=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
 if(result.exceptionDetails)throw Error("browser script exception: "+JSON.stringify(result.exceptionDetails).slice(0,280));
 return result.result.value;
}
async function until(expression){
 for(let i=0;i<90;i++){if(await evalJS(expression))return;await sleep(170);}
 throw Error("browser wait timeout: "+expression+"; got "+JSON.stringify(await evalJS("({route:location.pathname,html:document.body.innerText.slice(0,350)})")));
}
try{
 let tab;
 for(let i=0;i<70&&!tab;i++){
  try{tab=(await(await fetch("http://127.0.0.1:"+port+"/json/list")).json()).find(t=>t.type==="page");}catch{}
  if(!tab)await sleep(150);
 }
 assert.ok(tab,"Chrome debugger must be available");
 ws=new WebSocket(tab.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true});});
 ws.addEventListener("message",event=>{const message=JSON.parse(event.data),ticket=pending.get(message.id);
  if(ticket){pending.delete(message.id);message.error?ticket.reject(Error(message.error.message)):ticket.resolve(message.result);}
 });
 await send("Page.enable");await send("Runtime.enable");
 await send("Page.navigate",{url:base+"/login"});
 await until("location.pathname==='/login'");
 const login=await evalJS(`(async()=>{const res=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',
 body:JSON.stringify({login:'admin',password:${JSON.stringify(password)}})});return {status:res.status,ok:(await res.json()).ok}})()`);
 assert.equal(login.status,200,"isolated Chrome read-only admin login");
 assert.equal(login.ok,true,"admin credentials work");

 const errors=[];
 ws.addEventListener("message",event=>{
  const m=JSON.parse(event.data);
  if(m.method==="Runtime.exceptionThrown")errors.push(m.params.exceptionDetails?.text||"runtime exception");
 });
 const routes=['home','todo','projects','approvals','dhf-operations','knowledge','initiated','effective','appointments','seals'];
 for(const width of [1440,1024,760,390]){
  await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  for(const view of routes){
   await send('Page.navigate',{url:base+'/workbench?view='+view});
   await until("!!document.querySelector('.cdw-layout')");await sleep(240);
   const geometry=await evalJS(`(()=>{
    const root=document.querySelector('.cdw-layout'),box=root.getBoundingClientRect();
    const children=[...root.children].map(e=>{const r=e.getBoundingClientRect();return {cls:e.className,x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}});
    return {doc:document.documentElement.scrollWidth,root:{x:box.x,y:box.y,w:box.width,h:box.height,right:box.right,bottom:box.bottom},children};
   })()`);
   assert.ok(geometry.doc<=width+2,'页面水平溢出 '+view+' '+width);
   for(const child of geometry.children){
    assert.ok(child.right<=geometry.root.right+2&&child.bottom<=geometry.root.bottom+2,'子视图越界 '+JSON.stringify({view,width,geometry}));
    assert.ok(child.w>0&&child.h>100,'内容区域不可用 '+view);
   }
   if(geometry.children.length===1)assert.ok(geometry.children[0].w>=geometry.root.w-2,'整页视图未填满工作区 '+view+' '+width);
   if(view==='todo'){
    const [list,detail]=geometry.children;
    if(geometry.root.w<=700)assert.ok(detail.y>=list.bottom-2&&detail.w>=geometry.root.w-2,'窄工作区需要上下分区');
    else assert.ok(detail.x>=list.right-2&&detail.right>=geometry.root.right-2,'桌面详情需要填满剩余宽度');
   }
   if(process.env.FM_SCREENSHOT_DIR&&['home','todo','projects'].includes(view)){
    const shot=await send('Page.captureScreenshot',{format:'png'});
    writeFileSync(join(process.env.FM_SCREENSHOT_DIR,'workbench-'+view+'-'+width+'.png'),Buffer.from(shot.data,'base64'));
   }
  }
  console.log('WORKBENCH_GEOMETRY_PASS',width,routes.length+' views');
 }
 await send('Emulation.clearDeviceMetricsOverride');
 await send('Page.navigate',{url:base+'/workbench?view=projects'});
 await until("!!document.querySelector('.pj-view-toggle')");
 assert.equal(await evalJS("[...document.querySelectorAll('.pj-shell button')].filter(x=>x.textContent.trim()==='＋ 新建项目').length"),1,'项目仅有一个创建入口');
 assert.equal(await evalJS("document.querySelectorAll('.pj-h1,.pj-header').length"),0,'项目无重复页面标题');
 for(const label of ['表格','甘特','看板']){
  await evalJS(`(()=>{[...document.querySelectorAll('.pj-vt')].find(x=>x.textContent===${JSON.stringify(label)}).click();})()`);
  await sleep(250);
  assert.equal(await evalJS("new URLSearchParams(location.search).get('view')"),'projects','项目子视图不能覆盖父路由');
  assert.ok(await evalJS("!!document.querySelector('.pj-shell')"));
 }
 // 浏览器内生成长标题/大列表布局夹具，不写业务数据。
 await send('Page.navigate',{url:base+'/workbench?view=todo'});
 await until("!!document.querySelector('.cdw-task-row')");
 await evalJS(`(()=>{
  const list=document.querySelector('.cdw-inbox-scroll'),row=list.querySelector('.cdw-task-row');
  for(let i=0;i<120;i++){
   const clone=row.cloneNode(true);clone.querySelector('strong').textContent='长文件名与审批事项标题'.repeat(35)+i;
   list.appendChild(clone);
  }
 })()`);
 for(const width of [1440,760]){
  await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
  await sleep(150);
  const stress=await evalJS(`(()=>{
   const list=document.querySelector('.cdw-inbox-scroll');list.scrollTop=list.scrollHeight;
   return {doc:document.documentElement.scrollWidth,scroll:list.scrollTop,excess:list.scrollHeight-list.clientHeight};
  })()`);
  assert.ok(stress.doc<=width+2&&stress.excess>0&&stress.scroll>0,'长标题/大数据列表在自己的区域滚动 '+JSON.stringify(stress));
 }
 await send('Emulation.clearDeviceMetricsOverride');
 console.log('WORKBENCH_LONG_TITLE_LARGE_LIST_PASS');
 await send('Page.navigate',{url:base+'/doc'});await until("!!document.querySelector('.document-explorer')");
 assert.equal(await evalJS("!!document.querySelector('.cdw-workspace')"),false,'文档管理不使用工作台布局');
 assert.deepEqual(errors,[],'无未捕获浏览器错误');
 console.log('WORKBENCH_LAYOUT_BROWSER_PASS');
}finally{
 try{ws?.close();}catch{}
 try{process.kill(-chrome.pid,"SIGTERM")}catch{chrome.kill("SIGTERM")}
 if(chrome.exitCode===null&&chrome.signalCode===null)await Promise.race([new Promise(resolve=>chrome.once("exit",resolve)),sleep(2400)]);
 for(let attempt=0;attempt<15;attempt++){
  try{rmSync(profile,{recursive:true,force:true,maxRetries:4,retryDelay:150});break;}
  catch(error){if(attempt===14)throw error;await sleep(270);}
 }
}
