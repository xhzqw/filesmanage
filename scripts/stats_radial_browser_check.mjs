#!/usr/bin/env node
// Remote-only, read-only CDP check of the real radial stats page.
import {spawn} from "node:child_process";
import {setTimeout as sleep} from "node:timers/promises";
import {mkdirSync,writeFileSync} from "node:fs";
import {verifiedAdminSession} from "./qa_session.mjs";
const BASE="http://127.0.0.1:18091", PORT=9468;
const check=(v,n,d="")=>{console.log((v?"PASS ":"FAIL ")+n+(d?" "+d:""));if(!v)throw Error(n);};
class CDP {
 constructor(ws){this.ws=ws;this.n=0;this.tasks=new Map();ws.addEventListener("message",e=>{const m=JSON.parse(e.data);const task=this.tasks.get(m.id);if(task){this.tasks.delete(m.id);m.error?task.reject(Error(m.error.message)):task.resolve(m.result);}});}
 static async connect(url){const ws=new WebSocket(url);await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true});});return new CDP(ws);}
 send(method,params={}){const id=++this.n;return new Promise((resolve,reject)=>{this.tasks.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));});}
 async eval(expression){const r=await this.send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error("Browser evaluation failed");return r.result.value;}
 async waitFor(expression){for(let i=0;i<85;i++){if(await this.eval(expression))return true;await sleep(200);}return false;}
 close(){this.ws.close();}
}
const chrome=spawn("/usr/bin/google-chrome",["--headless=new","--no-sandbox","--disable-dev-shm-usage","--remote-debugging-port="+PORT,"--window-size=1680,960","--user-data-dir=/tmp/filesmanage-stats-radial-check","about:blank"],{stdio:"ignore"});
let cdp;
try{
 const session=await verifiedAdminSession(BASE);
 let target;
 for(let i=0;i<70&&!target;i++){await sleep(200);try{target=(await (await fetch("http://127.0.0.1:"+PORT+"/json/list")).json()).find(t=>t.type==="page");}catch{}}
 check(!!target,"CDP ready");
 cdp=await CDP.connect(target.webSocketDebuggerUrl);
 await cdp.send("Page.enable");await cdp.send("Runtime.enable");await cdp.send("Network.enable");
 await cdp.send("Network.setCookie",{name:"fm_session",value:session.cookie.slice("fm_session=".length),domain:"127.0.0.1",path:"/",httpOnly:true,sameSite:"Strict"});
 const dir="/root/repository77/.validation/stats-radial";
 mkdirSync(dir,{recursive:true});
 for(const v of [{name:"wide",w:1680,h:960},{name:"laptop",w:1366,h:768},{name:"narrow",w:720,h:900}]){
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:v.w,height:v.h,deviceScaleFactor:1,mobile:false});
  await cdp.send("Page.navigate",{url:BASE+"/stats"});
  check(await cdp.waitFor("!!document.querySelector('.stats-graph-node.is-root')"),v.name+" graph rendered");
  await sleep(400);
  const g=await cdp.eval("(()=>{const canvas=document.querySelector('.stats-graph-viewport').getBoundingClientRect(),r=document.querySelector('.stats-graph-node.is-root').getBoundingClientRect();const nodes=[...document.querySelectorAll('.stats-graph-node:not(.is-root)')].map(e=>{const n=e.getBoundingClientRect();return {x:n.left+n.width/2,y:n.top+n.height/2};});const cx=canvas.left+canvas.width/2,cy=canvas.top+canvas.height/2,rx=r.left+r.width/2,ry=r.top+r.height/2;return {cx,cy,rx,ry,nodes:nodes.length+1,edges:document.querySelectorAll('.stats-graph-lines path').length,left:nodes.some(n=>n.x<rx-12),right:nodes.some(n=>n.x>rx+12),above:nodes.some(n=>n.y<ry-12),below:nodes.some(n=>n.y>ry+12),overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,width:canvas.width,height:canvas.height};})()");
  check(g.width>260&&g.height>260,v.name+" responsive viewport",JSON.stringify(g));
  check(Math.abs(g.cx-g.rx)<3&&Math.abs(g.cy-g.ry)<3,v.name+" root exactly centred");
  const hub=await cdp.eval("(()=>{const el=document.querySelector('.stats-graph-node.is-root');const r=el.getBoundingClientRect();const name=el.querySelector('.stats-graph-node-label')?.textContent;const detail=el.querySelector('.stats-graph-node-detail')?.textContent;return {width:r.width,height:r.height,toggle:!!el.querySelector('.stats-graph-toggle'),name,detail,aria:el.getAttribute('aria-label')};})()");
  check(hub.width>=90&&hub.width<=112&&hub.height>=90&&hub.height<=112,v.name+" compact centre hub",JSON.stringify(hub));
  check(!hub.toggle&&hub.name==="全部目录"&&!!hub.detail?.includes("文件"),v.name+" no floating plus or duplicate detail");
  check(g.edges===g.nodes-1,v.name+" parent-child lines",JSON.stringify(g));
  check(g.nodes<4||(g.left&&g.right&&g.above&&g.below),v.name+" radial quadrants",JSON.stringify(g));
  check(g.overflow<=1,v.name+" no horizontal overflow",JSON.stringify(g));
  const shot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  writeFileSync(dir+"/"+v.name+".png",Buffer.from(shot.data,"base64"));
 }
 const before=await cdp.eval("document.querySelector('[aria-label=\"图谱缩放比例\"]')?.textContent");
 await cdp.eval("document.querySelector('[aria-label=\"放大图谱\"]')?.click()");
 await sleep(150);
 const after=await cdp.eval("document.querySelector('[aria-label=\"图谱缩放比例\"]')?.textContent");
 check(before!==after,"zoom responds",before+" => "+after);
 const candidateName=await cdp.eval("(()=>[...document.querySelectorAll('.stats-graph-folder[aria-expanded=\"false\"]')].find(node=>!node.classList.contains('is-root'))?.getAttribute('aria-label')||'')()");
 if(candidateName){
  const action="(()=>{const n=[...document.querySelectorAll('.stats-graph-folder[aria-expanded]')].find(node=>node.getAttribute('aria-label')==="+JSON.stringify(candidateName)+");n?.click();return !!n;})()";
  check(await cdp.eval(action),"click expandable directory");
  await sleep(280);
  const selected="(()=>[...document.querySelectorAll('.stats-graph-folder[aria-expanded]')].find(node=>node.getAttribute('aria-label')==="+JSON.stringify(candidateName)+")?.getAttribute('aria-expanded'))()";
  check(await cdp.eval(selected)==="true","branch expands on click");
  const nodeCount=await cdp.eval("document.querySelectorAll('.stats-graph-node').length");
  const edgeCount=await cdp.eval("document.querySelectorAll('.stats-graph-lines path').length");
  check(edgeCount===nodeCount-1,"branch expansion reconnects every visible node");
 }

 console.log("STATS_RADIAL_BROWSER_PASS");
}finally{cdp?.close();chrome.kill();}
