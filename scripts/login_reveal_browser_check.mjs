#!/usr/bin/env node
// Read-only login UI/browser regression for desktop, keyboard and narrow viewport.
// Usage: node scripts/login_reveal_browser_check.mjs [--base http://127.0.0.1:18091] [--screenshots /tmp/login-check]
import {spawn} from "node:child_process";
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";

const args=process.argv.slice(2);
const option=(k,v)=>{const i=args.indexOf("--"+k);return i<0?v:args[i+1];};
const base=option("base","http://127.0.0.1:18091").replace(/\/$/,"");
const screenshots=option("screenshots","");
const port=12000+Math.floor(Math.random()*6000);
const profile=mkdtempSync(join(tmpdir(),"fm-login-check-"));
const browser=spawn("/usr/bin/google-chrome",[
 "--headless=new","--no-sandbox","--disable-dev-shm-usage",
 "--remote-debugging-port="+port,"--user-data-dir="+profile,
 "--window-size=1440,900","about:blank"
],{stdio:"ignore"});
let ws,sequence=0;
const pending=new Map();
let failed=0;
function check(name,condition,detail=""){
 console.log(`${condition?"PASS":"FAIL"} ${name}${detail?" :: "+detail:""}`);
 if(!condition)failed++;
}
function send(method,params={}){
 const id=++sequence;
 return new Promise((resolve,reject)=>{
  pending.set(id,{resolve,reject});
  ws.send(JSON.stringify({id,method,params}));
 });
}
async function evaluate(expression){
 const r=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
 if(r.exceptionDetails)throw Error("page JS error "+JSON.stringify(r.exceptionDetails).slice(0,500));
 return r.result.value;
}
async function eventually(fn,timeout=3500){
 const limit=Date.now()+timeout;
 while(Date.now()<limit){
  const ok=await fn();
  if(ok)return ok;
  await sleep(75);
 }
 return false;
}
async function move(x,y){
 await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:Math.round(x),y:Math.round(y)});
}
async function snap(name){
 if(!screenshots)return;
 mkdirSync(screenshots,{recursive:true});
 const r=await send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
 writeFileSync(join(screenshots,name+".png"),Buffer.from(r.data,"base64"));
}
const collect=`(()=>{
 const e=document.querySelector(".login-entry"),z=document.querySelector(".login-reveal-zone");
 const r=e?.getBoundingClientRect(),zr=z?.getBoundingClientRect();
 const panel=document.querySelector(".login-panel");
 const brand=document.querySelector(".login-minimal-brand")?.getBoundingClientRect();
 const background=getComputedStyle(document.querySelector(".login-minimal")).backgroundImage;
 return {
 width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,
 buttonCenter:r?(r.left+r.right)/2:null,buttonMiddle:r?(r.top+r.bottom)/2:null,
 zone:zr?{left:zr.left,top:zr.top,right:zr.right,bottom:zr.bottom}:null,
 open:z?.classList.contains("is-expanded"),
 hidden:panel?getComputedStyle(panel).visibility==="hidden":null,
 panelLeft:panel?.getBoundingClientRect().left,panelRight:panel?.getBoundingClientRect().right,
 brandLeft:brand?.left,brandTop:brand?.top,
 showroomBackground:background.includes("login-showroom-bg.webp"),
 noDuplicateDeviceLayer:!document.querySelector(".login-scene-device"),
 logoLoaded:document.querySelector(".login-minimal-logo")?.naturalWidth>0
 };
})()`;
try{
 let tab;
 for(let i=0;i<65&&!tab;i++){
  try{tab=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==="page");}
  catch{}
  if(!tab)await sleep(100);
 }
 if(!tab)throw Error("Chrome debugger startup timeout");
 ws=new WebSocket(tab.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{
  ws.addEventListener("open",resolve,{once:true});
  ws.addEventListener("error",reject,{once:true});
 });
 ws.addEventListener("message",e=>{
  const m=JSON.parse(e.data),slot=pending.get(m.id);
  if(!slot)return;
  pending.delete(m.id);
  m.error?slot.reject(Error(m.error.message)):slot.resolve(m.result);
 });
 await send("Page.enable");await send("Runtime.enable");
 let navigationSeq=0;
 async function navigate(){
  const marker="interaction-test-"+(++navigationSeq);
  await send("Page.navigate",{url:base+"/login?qa_nav="+marker});
  // Do not inspect stale DOM from the previous navigation.
  const found=await eventually(()=>evaluate(`(()=>location.search.includes("${marker}")&&!!document.querySelector(".login-entry"))()`),7500);
  if(!found)throw Error("login page failed to load");
  await sleep(250);
 }
 await navigate();
 let state=await evaluate(collect);
 const bgResponse=await fetch(base+"/assets/brand/login-showroom-bg.webp");
 check("approved integrated showroom background loads",state.logoLoaded&&state.showroomBackground&&state.noDuplicateDeviceLayer&&bgResponse.ok,
  JSON.stringify({cssBackground:state.showroomBackground,noDuplicateDeviceLayer:state.noDuplicateDeviceLayer,status:bgResponse.status}));

 check("default center has only a login capsule",!state.open&&state.hidden&&Math.abs(state.buttonCenter-state.width/2)<1&&Math.abs(state.buttonMiddle-state.height/2)<1,JSON.stringify(state));
 check("brand stays in top left",state.brandLeft>=8&&state.brandTop>=5);
 check("login uses true transparent corporate logo",
  await evaluate(`(()=>{
   const logo=document.querySelector(".login-minimal-logo");
   return logo?.getAttribute("src")?.includes("logo-loader-256.png") &&
    getComputedStyle(logo).backgroundColor==="rgba(0, 0, 0, 0)";
  })()`));
 check("desktop has no horizontal overflow",state.scrollWidth<=state.width+1);
 await snap("default");
 const pt=state.zone;
 check("hover boundary matches the form rather than the oversized old sensor",
  Math.abs(pt.right-pt.left-362)<1 && pt.bottom-pt.top<410,
  JSON.stringify({width:pt.right-pt.left,height:pt.bottom-pt.top}));
 await move(pt.left-8,(pt.top+pt.bottom)/2);
 check("pointer outside left edge does not trigger",
  !await evaluate(`(()=>document.querySelector(".login-reveal-zone")?.classList.contains("is-expanded"))()`));
 await move((pt.left+pt.right)/2,pt.top-8);
 check("pointer above top edge does not trigger",
  !await evaluate(`(()=>document.querySelector(".login-reveal-zone")?.classList.contains("is-expanded"))()`));
 await move(pt.left+20,pt.top+22); // inside actual panel footprint but outside button
 check("hover anywhere within target zone opens form",await eventually(()=>evaluate(`(()=>document.querySelector(".login-reveal-zone")?.classList.contains("is-expanded"))()`)));
 await sleep(500);
 const cardGeometry=await evaluate(`(()=>{
  const z=document.querySelector(".login-reveal-zone").getBoundingClientRect();
  const p=document.querySelector(".login-panel").getBoundingClientRect();
  return {dx:Math.abs(z.left-p.left),dy:Math.abs(z.top-p.top),dw:Math.abs(z.width-p.width),dh:Math.abs(z.height-p.height)};
 })()`);
 check("expanded panel and hover geometry coincide",Object.values(cardGeometry).every(v=>v<1),JSON.stringify(cardGeometry));
 await snap("expanded");
 await move(12,state.height/2);
 await sleep(300);
 check("mouseleave does not close immediately",await evaluate(`(()=>document.querySelector(".login-reveal-zone")?.classList.contains("is-expanded"))()`));
 await sleep(950);
 check("mouseleave closes after 900ms",!await evaluate(`(()=>document.querySelector(".login-reveal-zone")?.classList.contains("is-expanded"))()`));
 await evaluate(`(()=>{document.querySelector(".login-entry").click();return true})()`);
 check("click can open form",await eventually(()=>evaluate(`(()=>document.querySelector(".login-reveal-zone")?.classList.contains("is-expanded"))()`)));
 check("obsolete close and remember actions are absent",
  await evaluate(`(()=>!document.querySelector(".login-panel-close,.login-forgot,.login-minimal-extras"))()`));
 check("native required field bubbles disabled, required semantics remain",
  await evaluate(`(()=>{const f=document.querySelector(".login-panel form");return f.noValidate&&f.querySelector("#login-account").required&&f.querySelector("#login-password").required})()`));
 await evaluate(`(()=>{document.querySelector(".login-panel form").requestSubmit();return true})()`);
 check("empty account prompts via unified toast",await eventually(()=>evaluate(`(()=>[...document.querySelectorAll(".rare-toast-text")].some(e=>e.textContent.includes("请输入账号")))()`)));
 check("empty account receives focus",await evaluate(`(()=>document.activeElement?.id==="login-account")()`));
 await send("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
 await send("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
 check("Escape closes login panel",!await evaluate(`(()=>document.querySelector(".login-reveal-zone")?.classList.contains("is-expanded"))()`));

 // Real mouse click + typing: programmatic .click() misses focus traps.
 async function physicalClick(x,y){
  await move(x,y);
  await send("Input.dispatchMouseEvent",{type:"mousePressed",x:Math.round(x),y:Math.round(y),button:"left",clickCount:1});
  await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:Math.round(x),y:Math.round(y),button:"left",clickCount:1});
 }
 await move(5,5);
 await navigate();
 await move(720,380);
 check("real pointer hover opens panel",await eventually(()=>evaluate(`(()=>document.querySelector(".login-reveal-zone")?.classList.contains("is-expanded"))()`)));
 const fields=await evaluate(`(()=>{
  const r=document.querySelector("#login-account").getBoundingClientRect();
  return {x:r.left+r.width/2,y:r.top+r.height/2};
 })()`);
 await physicalClick(fields.x,fields.y);
 check("real pointer can focus account input",await evaluate(`(()=>document.activeElement?.id==="login-account")()`));
 await send("Input.insertText",{text:"interaction-check"});
 check("real keyboard can type account",await evaluate(`(()=>document.querySelector("#login-account").value==="interaction-check")()`));
 await evaluate(`(()=>{document.querySelector(".login-panel form").requestSubmit();return true})()`);
 check("missing password prompts via unified toast",await eventually(()=>evaluate(`(()=>[...document.querySelectorAll(".rare-toast-text")].some(e=>e.textContent.includes("请输入密码")))()`)));
 check("missing password receives focus",await evaluate(`(()=>document.activeElement?.id==="login-password")()`));
 await move(5,5);
 await sleep(300);
 check("editing window persists for close grace",await evaluate(`(()=>document.querySelector(".login-reveal-zone")?.classList.contains("is-expanded"))()`));
 await sleep(900);
 check("input focus does not permanently defeat mouseleave",!await evaluate(`(()=>document.querySelector(".login-reveal-zone")?.classList.contains("is-expanded"))()`));
 await move(720,380);
 check("can reopen after timed close",await eventually(()=>evaluate(`(()=>document.querySelector(".login-reveal-zone")?.classList.contains("is-expanded"))()`)));
 await sleep(570);
 // Outside click replaces the removed X as the pointer dismissal path.
 await physicalClick(10,10);
 await sleep(220);
 check("outside click closes",!await evaluate(`(()=>document.querySelector(".login-reveal-zone")?.classList.contains("is-expanded"))()`));

 // Touch: a real tap must not lose the target to RareUI :active transforms.
 await move(5,5);await navigate();
 await send("Emulation.setTouchEmulationEnabled",{enabled:true,maxTouchPoints:1});
 await send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x:720,y:380}]});
 await send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
 check("touch tap opens the login form",await eventually(()=>evaluate(`(()=>document.querySelector(".login-reveal-zone")?.classList.contains("is-expanded"))()`)));
 await send("Emulation.setTouchEmulationEnabled",{enabled:false});
 // Keyboard: focus and Escape should open/close without a mouse.
 await move(5,5);await navigate();
 await evaluate(`(()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur();document.querySelector(".login-entry").focus();return true})()`);
 await send("Input.dispatchKeyEvent",{type:"keyDown",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});
 await send("Input.dispatchKeyEvent",{type:"keyUp",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});
 check("keyboard Enter opens form",await eventually(()=>evaluate(`(()=>document.querySelector(".login-reveal-zone")?.classList.contains("is-expanded"))()`)));
 await sleep(240);
 check("keyboard-open focuses account",
  await evaluate(`(()=>document.activeElement?.id==="login-account")()`));
 await send("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
 await send("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
 await sleep(120);
 check("Escape closes and restores entry focus",
  await evaluate(`(()=>!document.querySelector(".login-reveal-zone")?.classList.contains("is-expanded")&&document.activeElement?.classList.contains("login-entry"))()`));
 for(const [width,height] of [[900,680],[390,844]]){
  await send("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
  await navigate();
  state=await evaluate(collect);
  check(`layout ${width}px center and no overflow`,
   Math.abs(state.buttonCenter-width/2)<1&&Math.abs(state.buttonMiddle-height/2)<1&&state.scrollWidth<=width+1,
   JSON.stringify({width,center:state.buttonCenter,middle:state.buttonMiddle,scrollWidth:state.scrollWidth}));
  await evaluate(`(()=>{document.querySelector(".login-entry").click();return true})()`);
  await sleep(550);
  state=await evaluate(collect);
  check(`layout ${width}px expanded form fits`,
   state.open&&state.panelLeft>=-1&&state.panelRight<=width+1,
   JSON.stringify({width,left:state.panelLeft,right:state.panelRight}));
  if(width===390)await snap("mobile-expanded");
 }
} catch(e){failed++;console.error("FAIL fatal:",e?.stack||e);}
finally{
 if(ws)ws.close();
 browser.kill("SIGTERM");
 await sleep(180);
 rmSync(profile,{recursive:true,force:true});
}
if(failed){console.error(`LOGIN_BROWSER_FAIL ${failed}`);process.exitCode=1;}
else console.log("LOGIN_BROWSER_OK");
