#!/usr/bin/env node
// Read-only authenticated Chrome geometry and navigation smoke for CDW.
// No tasks are created and no business document is edited.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {readFileSync,mkdtempSync,rmSync} from "node:fs";
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
 await send("Page.navigate",{url:base+"/workbench/dhf"});
 await until("location.pathname==='/workbench/dhf'&&!!document.querySelector('.dhf-grid')");
 assert.equal(await evalJS("document.querySelector('.dhf-toolbar a[href=\"/workbench\"]')?.textContent?.trim()"),"← 工作台","DHF return link uses workbench label");
 const dhf=await evalJS("(async()=>{const [t,p,n]=await Promise.all([fetch('/api/workbench/dhf/template'),fetch('/api/workbench/dhf/projects'),fetch('/api/workbench/dhf/projects/unknown-id')]);return {templateStatus:t.status,template:(await t.json()).data,projectsStatus:p.status,projects:(await p.json()).data,missingStatus:n.status}})()");
 assert.equal(dhf.templateStatus,200);
 assert.equal(dhf.projectsStatus,200);
 assert.equal(dhf.missingStatus,404);
 const dhfMissingLink=await evalJS("(async()=>{const r=await fetch('/api/workbench/dhf/projects/unknown-id/work-links');return r.status})()");
 assert.equal(dhfMissingLink,404,"unknown DHF project must not expose related CDW work");
 if(dhf.projects.length){
  const first=dhf.projects[0];
  const related=await evalJS("(async()=>{const r=await fetch('/api/workbench/dhf/projects/"+encodeURIComponent(first.id)+"/work-links');return {status:r.status,data:(await r.json()).data}})()");
  assert.equal(related.status,200,"DHF authorized project has related-work projection");
  assert.ok(Array.isArray(related.data.items),"related work is a real bounded server list");
  assert.ok(related.data.items.every(x=>typeof x.exactDeliveryMatch==="boolean"&&x.stageNo>=1&&x.stageNo<=9),"DHF relation has independent exact-delivery evidence flag");
 }
 assert.ok(Array.isArray(dhf.projects));
 assert.equal(dhf.template.nodes.filter(n=>n.depth===1).length,9);
 assert.ok(dhf.template.nodes.filter(n=>n.depth>1&&!n.isGroup).length>=140);
 for(const width of [1440,1024,780]){
  await send("Emulation.setDeviceMetricsOverride",{width,height:850,deviceScaleFactor:1,mobile:false});
  await sleep(180);
  const l=await evalJS("(()=>({width:document.documentElement.scrollWidth,panes:[...document.querySelector('.dhf-grid').children].map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right}})}))()");
  assert.ok(l.width<=width+2,"DHF horizontal overflow at "+width+": "+JSON.stringify(l));
  assert.ok(l.panes.every(p=>p.left>=-2&&p.right<=width+2),"DHF panel overflow "+width+": "+JSON.stringify(l));
  console.log("DHF_LAYOUT_PASS",width);
 }
 await send("Emulation.clearDeviceMetricsOverride");
 await send("Page.navigate",{url:base+"/workbench/dhf?create=1"});
 await until("!!document.querySelector('.dhf-form')");
 assert.ok(await evalJS("!!document.querySelector('.dhf-form input')"),"DHF deep-link creation opens guided project form");
 console.log("DHF_CREATE_LINK_BROWSER_PASS admin project form via guided link");
 console.log("DHF_TEMPLATE_BROWSER_PASS nine-source-stage catalogue and ACL guarded project list");
 await send("Page.navigate",{url:base+"/workbench"});
 await until("location.pathname==='/workbench'&&!!document.querySelector('.cdw-layout')");
 assert.equal(await evalJS("document.querySelector('#shell-main-navigation a[href=\"/workbench\"]')?.textContent?.trim()"),"工作台","primary navigation uses workbench instead of task");
 assert.equal(await evalJS("document.querySelector('.cdw-rail')?.getAttribute('aria-label')"),"工作视图分类","workbench categories accessible label");
 console.log("CDW_NAMING_PASS primary navigation / DHF return / category semantics");
 await until("!!document.querySelector('.cdw-home-heading')");
 await until("!!document.querySelector('.cdw-home-dhf')");
 assert.ok(await evalJS("document.querySelector('.cdw-home-dhf a')?.getAttribute('href')==='/workbench/dhf'"),"work homepage includes DHF project entry");
 await evalJS("(()=>{[...document.querySelectorAll('.cdw-home-actions button')].find(b=>b.textContent.includes('发起工作'))?.click()})()");
 assert.ok(await evalJS("document.querySelector('.cdw-home-chooser a')?.getAttribute('href')==='/workbench/dhf?create=1'"),"guided chooser distinguishes DHF from CDW initiation");
 console.log("DHF_CDW_GUIDED_ENTRY_PASS landing projects and separate workflow initiation");

 assert.equal(await evalJS("document.querySelector('.cdw-rail-item.is-current')?.textContent?.includes('工作首页')"),true,
  "default route opens the guided work home");
 for(const width of [1440,1024,780,540]){
  await send("Emulation.setDeviceMetricsOverride",{width,height:850,deviceScaleFactor:1,mobile:false});
  await sleep(130);
  const l=await evalJS("(()=>({bodyWidth:document.documentElement.scrollWidth,panes:['.cdw-rail','.cdw-home'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom}}),layoutLeft:document.querySelector('.cdw-layout').getBoundingClientRect().left,homeDoc:(()=>{const r=document.querySelector('.cdw-home-toolbar').getBoundingClientRect();return {left:r.left,right:r.right}})()}))()");
  assert.ok(l.bodyWidth<=width+2,"home horizontal overflow at "+width+": "+JSON.stringify(l));
  assert.ok(l.panes.every(p=>p.left>=-2&&p.right<=width+2&&p.bottom<=851),"home pane overflow at "+width+": "+JSON.stringify(l));
  assert.ok(Math.abs(l.homeDoc.left-l.layoutLeft)<=1,"work home must start at the canvas edge, no empty grid track at "+width+": "+JSON.stringify(l));
  console.log("CDW_HOME_LAYOUT_PASS",width);
 }
 await send("Emulation.clearDeviceMetricsOverride");
 const initiated=await evalJS("(async()=>{const [ok,bad]=await Promise.all([fetch('/api/workbench/initiated?limit=20'),fetch('/api/workbench/initiated?limit=102')]);return {status:ok.status,page:(await ok.json()).data,badStatus:bad.status}})()");
 assert.equal(initiated.status,200,"current user can access creator-scoped records");
 assert.ok(Array.isArray(initiated.page.items),"authored work must return real server rows");
 assert.equal(initiated.badStatus,400,"creator-scope page limit validated");
 const flowGuard=await evalJS("(async()=>{const r=await fetch('/api/workbench/initiated/no-such-work/flow');return r.status})()");
 assert.equal(flowGuard,404,"unowned work flow must be indistinguishable from missing records");
 const auditGuard=await evalJS("(async()=>{const [a,b]=await Promise.all([fetch('/api/workbench/initiated/unknown/events'),fetch('/api/workbench/initiated/unknown/events?before=bad')]);return [a.status,b.status]})()");
 assert.deepEqual(auditGuard,[404,400],"audit queries require own task and valid cursor");
 assert.ok(initiated.page.items.every(item=>typeof item.taskId==="string"&&typeof item.createdAt==="string"&&typeof item.state==="string"),
  "creator rows include immutable identity, timestamps and current state");
 await evalJS("(()=>{[...document.querySelectorAll('.cdw-rail-item')].find(b=>b.textContent.includes('我发起的'))?.click()})()");
 await until("!!document.querySelector('.cdw-initiated-list') && !!document.querySelector('.cdw-initiated-detail')");
 if(initiated.page.items.length){
  const first=initiated.page.items[0];
  const snapshot=await evalJS("(async()=>{const r=await fetch('/api/workbench/initiated/"+encodeURIComponent(first.taskId)+"/flow');return {status:r.status,data:(await r.json()).data}})()");
  assert.equal(snapshot.status,200,"authenticated creator can inspect real work flow");
  assert.ok(Array.isArray(snapshot.data.works)&&snapshot.data.works.some(w=>w.id===first.taskId),"flow includes authored work");
  assert.ok(Array.isArray(snapshot.data.milestones)&&snapshot.data.milestones.every(x=>typeof x.reference==='string'&&typeof x.state==='string'),"flow renders exact evidenced milestones only");
  await until("!!document.querySelector('.cdw-flow-step-list')");
  assert.equal(await evalJS("[...document.querySelectorAll('.cdw-flow-step')].length"),9,"all business phases visible, missing evidence explicit");
  await evalJS("(()=>{document.querySelectorAll('.cdw-initiated-tabbar button')[1]?.click()})()");
  await until("!!document.querySelector('.cdw-timeline-head')");
  await evalJS("(()=>{document.querySelectorAll('.cdw-initiated-tabbar button')[0]?.click()})()");
  await until("!!document.querySelector('.cdw-flow-step-list')");
  console.log("CDW_FLOW_BROWSER_PASS authored ACL, exact evidence, 9-stage map and trace switch");
 }
 assert.equal(await evalJS("document.querySelector('.cdw-initiated-head')?.textContent.includes('我发起的工作')"),true,"creator view supports progress tracking");
 for(const width of [1440,1024,780,540]){
  await send("Emulation.setDeviceMetricsOverride",{width,height:850,deviceScaleFactor:1,mobile:false});
  await sleep(150);
  const layout=await evalJS("(()=>({width:document.documentElement.scrollWidth,panes:['.cdw-rail','.cdw-initiated','.cdw-initiated-list','.cdw-initiated-detail'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom}})}))()");
  assert.ok(layout.width<=width+2,"creator view horizontal overflow "+width+": "+JSON.stringify(layout));
  assert.ok(layout.panes.every(p=>p.left>=-2&&p.right<=width+2&&p.bottom<=851),"creator tracking pane overflow "+width+": "+JSON.stringify(layout));
  console.log("CDW_INITIATED_LAYOUT_PASS",width);
 }
 await send("Emulation.clearDeviceMetricsOverride");
 console.log("CDW_INITIATED_BROWSER_PASS live author-scoped list + invalid limit + responsive read-only tracking");
 await evalJS("(()=>{[...document.querySelectorAll('.cdw-rail-item')].find(b=>b.textContent.includes('待我处理'))?.click()})()");
 await until("!!document.querySelector('.cdw-inbox-heading')");
 const inbox=await evalJS("(async()=>{const r=await fetch('/api/workbench/inbox?limit=5');return {status:r.status,data:(await r.json()).data}})()");
 assert.equal(inbox.status,200,"authenticated CDW inbox responds 200");
 assert.ok(Array.isArray(inbox.data?.items),"CDW inbox contains items array");
 const gates=await evalJS("(async()=>{const r=await fetch('/api/workbench/review-gates/inbox?limit=5');return {status:r.status,data:(await r.json()).data}})()");
 assert.equal(gates.status,200,"review gate inbox must authorize current session");
 assert.ok(Array.isArray(gates.data?.items),"review inbox must return items array");
 for(const width of [1440,1024,780,540]){
  await send("Emulation.setDeviceMetricsOverride",{width,height:850,deviceScaleFactor:1,mobile:false});
  await sleep(150);
  const layout=await evalJS(`(()=>{const body=document.documentElement;
   const outer=document.querySelector('.cdw-layout').getBoundingClientRect();
   const panes=['.cdw-rail','.cdw-inbox','.cdw-detail'].map(selector=>{
    const el=document.querySelector(selector),rect=el.getBoundingClientRect();
    return {selector,left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight};
   });
   return {viewport:innerWidth,bodyWidth:body.scrollWidth,layoutLeft:outer.left,layoutRight:outer.right,panes}
  })()`);
  assert.ok(layout.bodyWidth<=width+2,"horizontal page overflow at "+width+": "+JSON.stringify(layout));
  assert.ok(layout.panes.every(p=>p.right<=width+2&&p.left>=-2),"panes overflow at "+width+": "+JSON.stringify(layout));
  assert.ok(layout.panes.every(p=>p.bottom<=851),"panes extend below viewport at "+width);
  assert.ok(Math.abs(layout.panes.find(p=>p.selector===".cdw-inbox").left-layout.layoutLeft)<=1,
   "inbox must start at the canvas edge, no empty grid track at "+width+": "+JSON.stringify(layout));
  console.log("CDW_LAYOUT_PASS",width,layout.panes.map(p=>p.selector+":"+Math.round(p.right-p.left)).join(" "));
 }
 await evalJS("(()=>{const button=[...document.querySelectorAll('.cdw-rail-item')].find(b=>b.textContent.includes('交付验收'));button?.click();return true;})()");
 await until("document.querySelector('.cdw-rail-item.is-current')?.textContent?.includes('交付验收')");
 await evalJS("(()=>{const button=[...document.querySelectorAll('.cdw-rail-item')].find(b=>b.textContent.includes('责任待办'));button?.click();return true;})()");
 await until("document.querySelector('.cdw-rail-item.is-current')?.textContent?.includes('责任待办')");
 assert.equal(await evalJS("[...document.querySelectorAll('.cdw-inbox-actions button')].some(b=>b.textContent.includes('新建工作'))"),false,
  "responsibility view must not offer unrelated work creation");
 await evalJS("(()=>{const button=[...document.querySelectorAll('.cdw-rail-item')].find(b=>b.textContent.includes('文件工作'));button?.click();return true;})()");
 await until("document.querySelector('.cdw-rail-item.is-current')?.textContent?.includes('文件工作')");
 assert.equal(await evalJS("!!document.querySelector('.cdw-sort-button[aria-pressed=true]')"),true,
  "actionable items are sorted first by default");
 await evalJS("(()=>{const create=[...document.querySelectorAll('.cdw-inbox-actions button')].find(b=>b.textContent.includes('新建工作'));create?.click();return true;})()");
 await until("!!document.querySelector('.cdw-form') && document.querySelector('.cdw-detail h2')?.textContent?.includes('新建受控文件工作')");
 const overrideControl="document.querySelector('.cdw-form-permission button[aria-pressed]')";
 await until(overrideControl+"?.getAttribute('aria-pressed')==='false'");
 await evalJS("(()=>{"+overrideControl+".click();return true})()");
 await until(overrideControl+"?.getAttribute('aria-pressed')==='true'");
 await evalJS("(()=>{"+overrideControl+".click();return true})()");
 await until(overrideControl+"?.getAttribute('aria-pressed')==='false'");
 console.log("CDW_G6_TEMPLATE_OPT_IN_BROWSER_PASS default=off toggles=on/off no-write");

 const formal=await evalJS("(async()=>{const r=await fetch('/api/workbench/formal-approvals/inbox?limit=5');return {status:r.status,data:(await r.json()).data}})()");
 assert.equal(formal.status,200,"G7 formal approval inbox authorizes admin session");
 assert.ok(Array.isArray(formal.data?.items),"G7 formal approval inbox is live");
 const ready=await evalJS("(async()=>{const r=await fetch('/api/workbench/formal-approvals/ready');return {status:r.status,data:(await r.json()).data}})()");
 assert.equal(ready.status,200,"G7 eligible frozen deliveries query is real");
 assert.ok(Array.isArray(ready.data?.items),"G7 frozen delivery candidates are an array");
 const controlled=await evalJS("(async()=>{const r=await fetch('/api/workbench/controlled/candidates');return {status:r.status,data:(await r.json()).data}})()");
 assert.equal(controlled.status,200,"G8 approved controlled candidates API authorizes admin session");
 assert.ok(Array.isArray(controlled.data?.items),"G8 approved candidate registry is live");

 await evalJS("(()=>{const button=[...document.querySelectorAll('.cdw-rail-item')].find(b=>b.textContent.includes('正式审批'));button?.click();return true;})()");
 await until("document.querySelector('.cdw-rail-item.is-current')?.textContent?.includes('正式审批')");
 assert.equal(await evalJS("[...document.querySelectorAll('.cdw-inbox-actions button')].some(b=>b.textContent.includes('发起审批'))"),true,
  "G7 formal approval initiation is an actionable navigation control");
 await evalJS("(()=>{const button=[...document.querySelectorAll('.cdw-inbox-actions button')].find(b=>b.textContent.includes('发起审批'));button?.click();return true;})()");
 await until("document.querySelector('.cdw-detail h2')?.textContent?.includes('从已验收交付稿发起')");
 assert.equal(await evalJS("!!document.querySelector('.cdw-form select, .cdw-form .rare-select')"),true,
  "G7 connects frozen delivery candidate selector");
 console.log("CDW_G7_FORMAL_BROWSER_PASS inbox+eligible-deliveries+initiation=live-no-write");
 // A requester cannot self-select generic/QMS approval routing. The server's
 // document-control classification is loaded only for the frozen source.
 assert.equal(await evalJS("!!document.querySelector('button.rare-select[aria-label=\"审批用途\"]')"),false,
  "requester-side QMS bypass selector must not exist");
 if(ready.data.items.length){
  await evalJS("(()=>{document.querySelector('button.rare-select[aria-label=\"选择已验收交付\"]').click();return true})()");
  await until("!!document.querySelector('[role=listbox][aria-label=\"选择已验收交付\"]')");
  await evalJS("(()=>{[...document.querySelector('[role=listbox][aria-label=\"选择已验收交付\"]').querySelectorAll('[role=option]')].find(x=>!x.disabled&&x.textContent!=='选择正式审批候选稿')?.click();return true;})()");
  await until("document.querySelector('.cdw-section-note')?.textContent!==undefined");
  const classified=await evalJS("(()=>({classVisible:document.body.innerText.includes('文控归类：'),grantDisabled:[...document.querySelectorAll('.cdw-section button')].find(x=>x.textContent.includes('授权两位审批人'))?.disabled===true}))()");
  assert.ok(classified.classVisible&&classified.grantDisabled,"unreviewed file cannot authorize approvers");
 }
 console.log("CDW_QMS_CLASSIFICATION_BROWSER_PASS no requester-side route toggle; document-control classification enforced");

 await evalJS("(()=>{const button=[...document.querySelectorAll('.cdw-rail-item')].find(b=>b.textContent.includes('任命核验'));button?.click();return Boolean(button);})()");
 await until("document.querySelector('.cdw-rail-item.is-current')?.textContent?.includes('任命核验')");
 assert.equal(await evalJS("!!document.querySelector('[aria-label=\"岗位任命待核验列表\"]')"),true,
  "independent document-control personnel have an actionable appointment review view");
 assert.equal(await evalJS("!!document.querySelector('[aria-label=\"岗位任命核验详情\"]')"),true,
  "appointment review details occupy the shared main canvas, without a second UI system");
 console.log("CDW_QMS_APPOINTMENT_REVIEW_BROWSER_PASS independent document-control inbox=live-no-write");
 const alerts=await evalJS("(async()=>{const r=await fetch('/api/workbench/qms-appointment-alerts');return {status:r.status,data:(await r.json()).data}})()");
 assert.equal(alerts.status,200,"appointment revocation notices belong to logged-in recipient");
 assert.ok(Array.isArray(alerts.data?.items),"revocation alerts must be durable server-backed rows");
 console.log("CDW_QMS_REVOCATION_ALERT_BROWSER_PASS current recipient alert inbox=live-no-write");
 const special=await evalJS("(async()=>{const r=await fetch('/api/workbench/qms-special-authorities');return {status:r.status,data:(await r.json()).data}})()");
 assert.equal(special.status,200,"DHF/DMR dedicated authority reviewer queue requires authentication");
 assert.ok(Array.isArray(special.data?.items),"DHF/DMR dedicated authority queue is server-backed");
 assert.equal(await evalJS("!!document.querySelector('[aria-label=\"DHF DMR 专项签批依据\"]')"),true,
  "DHF and DMR independent document-control review shares the original workbench canvas");
 console.log("CDW_QMS_SPECIAL_AUTHORITY_BROWSER_PASS authenticated review queue, compact canvas, no-write");
 const alerts2=await evalJS("(async()=>{const r=await fetch('/api/workbench/qms-special-alerts');return {status:r.status,data:(await r.json()).data}})()");
 assert.equal(alerts2.status,200,"DHF/DMR returned, rejected and revoked alerts are authenticated");
 assert.ok(Array.isArray(alerts2.data?.items),"QMS special status alerts persist in a server-side inbox");
 console.log("CDW_QMS_SPECIAL_REVIEW_ALERT_BROWSER_PASS recipient-only status alerts=read-only");
 const policyImpacts=await evalJS("(async()=>{const r=await fetch('/api/workbench/qms-special-policy-impacts');return {status:r.status,data:(await r.json()).data}})()");
 assert.equal(policyImpacts.status,200,"QMS policy impact tasks are scoped and authenticated");
 assert.ok(Array.isArray(policyImpacts.data?.items),"G14 policy impact assessment tasks are server-backed");
 console.log("CDW_G14_POLICY_IMPACT_BROWSER_PASS live scoped impact task inbox=read-only");
 const cutApprovals=await evalJS("(async()=>{const r=await fetch('/api/workbench/qms-interrupted-approvals');return {status:r.status,data:(await r.json()).data}})()");
 assert.equal(cutApprovals.status,200,"G15 interrupted approvals require authenticated file access");
 assert.ok(Array.isArray(cutApprovals.data?.items),"G15 interrupted instances live in server-side history");
 console.log("CDW_G15_MIDFLIGHT_BROWSER_PASS read-only frozen approvals after policy change");
 const g16=await evalJS("(async()=>{const urls=['/api/workbench/qms-legacy-approval-anomalies','/api/workbench/qms-formal-interruption-notices','/api/workbench/qms-legacy-approval-holds'];return await Promise.all(urls.map(async u=>{const r=await fetch(u);return {status:r.status,items:(await r.json()).data?.items}}))})()");
 assert.ok(g16.every(r=>r.status===200&&Array.isArray(r.items)),
  "G16 historical anomalies and per-recipient notices are authenticated server backed");
 console.log("CDW_G16_LEGACY_NOTICE_BROWSER_PASS scoped historical anomalies and individual notice inbox=read-only");
 const g17=await evalJS("(async()=>{const r=await fetch('/api/workbench/qms-formal-lineage/__nonexistent_g17_approval__');return {status:r.status,data:(await r.json()).data}})()");
 assert.equal(g17.status,404,"G17 cannot manufacture a complete lineage for missing formal approval IDs");
 console.log("CDW_G17_LINEAGE_BROWSER_PASS authenticated lineage endpoint denies missing approvals");
 const g18=await evalJS("(async()=>{const [ledger,audit]=await Promise.all([fetch('/api/workbench/qms-formal-notice-ledger'),fetch('/api/workbench/qms-formal-lineage/__nonexistent_g18_approval__/audit')]);return {ledgerStatus:ledger.status,items:(await ledger.json()).data?.items,auditStatus:audit.status}})()");
 assert.equal(g18.ledgerStatus,200,"G18 document-control ledger must have a real authenticated response");
 assert.ok(Array.isArray(g18.items),"G18 personal notice follow-up ledger is server-backed");
 assert.equal(g18.auditStatus,404,"G18 cannot export fabricated approval audit evidence");
 console.log("CDW_G18_AUDIT_FOLLOWUP_BROWSER_PASS live scoped ledger and missing-audit fail-closed");
 const g19=await evalJS("(async()=>{const [summary,audit]=await Promise.all([fetch('/api/workbench/qms-formal-portfolio'),fetch('/api/workbench/qms-formal-lineage/__nonexistent_g19_approval__/audit-segmented')]);return {status:summary.status,portfolio:(await summary.json()).data,auditStatus:audit.status}})()");
 assert.equal(g19.status,200,"G19 controller-only cross-document portfolio requires live authorization");
 assert.ok(Array.isArray(g19.portfolio?.items),"G19 portfolio must be a server-backed, bounded collection");
 assert.ok(g19.portfolio?.limit===100&&typeof g19.portfolio.hasMore==="boolean",
  "G19 portfolio discloses its cap and incomplete coverage");
 assert.equal(g19.auditStatus,404,"G19 segmented audit cannot fabricate non-existent signed records");
 assert.equal(await evalJS("!!document.querySelector('[aria-label=\"跨文件审批链统计\"]')"),true,
  "G19 compact portfolio shares existing QMS workbench, not a separate page");
 console.log("CDW_G19_SEGMENT_PORTFOLIO_BROWSER_PASS bounded live metrics and segmented audit fail-closed");
 const g20=await evalJS("(async()=>{const endpoints=['/api/workbench/qms-escalation-policies','/api/workbench/qms-escalation-cases'];return Promise.all(endpoints.map(async url=>{const r=await fetch(url);return {status:r.status,items:(await r.json()).data?.items}}))})()");
 assert.ok(g20.every(r=>r.status===200&&Array.isArray(r.items)),
  "G20 escalation policy and case inboxes are live authenticated scoped server data");
 assert.equal(await evalJS("!!document.querySelector('[aria-label=\"受控通知升级及异常闭环\"]')"),true,
  "G20 escalation shares the existing document-control workbench");
 console.log("CDW_G20_ESCALATION_BROWSER_PASS live policy/case lists, no generated company approvals or escalation");

 await evalJS("(()=>{const button=[...document.querySelectorAll('.cdw-rail-item')].find(b=>b.textContent.includes('发行准备'));button?.click();return true;})()");
 await until("document.querySelector('.cdw-rail-item.is-current')?.textContent?.includes('发行准备')");
 assert.equal(await evalJS("[...document.querySelectorAll('.cdw-inbox-actions button')].some(b=>b.textContent.includes('新建工作'))"),false,
  "G8 release register must not display unrelated task-creation action");
 if(controlled.data.items.length){
  const found=await evalJS("(()=>{const node=document.querySelector('.cdw-task-row');node?.click();return !!node})()");
  assert.equal(found,true,"G8 real approved candidate selectable");
  await until("!!document.querySelector('.cdw-review-digest code')");
  const digest=await evalJS("document.querySelector('.cdw-review-digest code')?.textContent.trim()");
  assert.equal(digest.length,64,"G8 source SHA is rendered from approved immutable candidate");
 }
 const controlledLayout=await evalJS("({width:innerWidth,scrollWidth:document.documentElement.scrollWidth})");
 assert.ok(controlledLayout.scrollWidth<=controlledLayout.width+2,"G8 narrow canvas has no page overflow");
 console.log("CDW_G8_PREPARE_BROWSER_PASS candidate-registry+tab+live-source-sha=read-only");
 const effective=await evalJS("(async()=>{const r=await fetch('/api/workbench/controlled/effective-search?limit=10');return {status:r.status,data:(await r.json()).data}})()");
 assert.equal(effective.status,200,"authenticated current effective release search is live");
 assert.ok(Array.isArray(effective.data?.items),"effective search results are not simulated");
 assert.ok(effective.data.items.every(row=>row.releaseId&&row.fileId&&row.sha256?.length===64),
  "each visible search hit is bound to an exact immutable effective release digest");
 await evalJS("(()=>{const b=[...document.querySelectorAll('.cdw-rail-item')].find(x=>x.textContent.includes('生效文件'));b?.click();return Boolean(b)})()");
 await until("!!document.querySelector('.cdw-effective-view input[type=search]')");
 await until("!document.querySelector('.cdw-effective-view .cdw-message')");
 for(const width of [1440,1024,780]){
  await send("Emulation.setDeviceMetricsOverride",{width,height:850,deviceScaleFactor:1,mobile:false});
  await sleep(170);
  const effectiveLayout=await evalJS("(()=>{const v=document.querySelector('.cdw-effective-view'),r=v.getBoundingClientRect();return {viewport:innerWidth,pageWidth:document.documentElement.scrollWidth,left:r.left,right:r.right,bottom:r.bottom}})()");
  assert.ok(effectiveLayout.pageWidth<=width+2&&effectiveLayout.right<=width+2&&effectiveLayout.left>=-2&&effectiveLayout.bottom<=851,
   "effective search viewport overflow: "+JSON.stringify(effectiveLayout));
 }
 const searchInput=await evalJS("(()=>{const input=document.querySelector('.cdw-effective-view input[type=search]');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,'nonexistent-controlled-fulltext-token');input.dispatchEvent(new Event('input',{bubbles:true}));return input.value})()");
 assert.equal(searchInput,"nonexistent-controlled-fulltext-token","effective filename/contents filter accepts input");
 await until("!document.querySelector('.cdw-effective-view .cdw-message')");
 console.log("CDW_G8_EFFECTIVE_SEARCH_BROWSER_PASS live-authorized-api+immutable-sha+search-control+1440/1024/780");
 const scope=await evalJS("(async()=>{const r=await fetch('/api/workbench/distribution-scope/inbox');return {status:r.status,data:(await r.json()).data}})()");
 assert.equal(scope.status,200,"G9 scope approval inbox enforces live authenticated identity");
 assert.ok(Array.isArray(scope.data?.items),"G9 independently appointed scope list is live");
 await evalJS("(()=>{const button=[...document.querySelectorAll('.cdw-rail-item')].find(b=>b.textContent.includes('范围审批'));button?.click();return true;})()");
 await until("document.querySelector('.cdw-rail-item.is-current')?.textContent?.includes('范围审批')");
 assert.equal(await evalJS("[...document.querySelectorAll('.cdw-inbox-actions button')].some(b=>b.textContent.includes('新建工作'))"),false,
  "G9 scope approval cannot masquerade as task delegation");
 console.log("CDW_G9_SCOPE_BROWSER_PASS authenticated-inbox+separate-review-workbench");
 const g9Reads=await evalJS("(async()=>{const r=await fetch('/api/workbench/reading-assignments/inbox');return {status:r.status,data:(await r.json()).data}})()");
 assert.equal(g9Reads.status,200,"G9 reading inbox must enforce actual authenticated reader identity");
 assert.ok(Array.isArray(g9Reads.data?.items),"G9 reader assignments cannot be simulated");
 await evalJS("(()=>{const b=[...document.querySelectorAll('.cdw-rail-item')].find(x=>x.textContent.includes('阅读确认'));b?.click();return true;})()");
 await until("document.querySelector('.cdw-rail-item.is-current')?.textContent?.includes('阅读确认')");
 assert.equal(await evalJS("[...document.querySelectorAll('.cdw-inbox-actions button')].some(x=>x.textContent.includes('新建工作'))"),false,
  "G9 reading view may not show unrelated task-creation control");
 console.log("CDW_G9_READING_BROWSER_PASS authenticated-reading-inbox+separate-personal-confirmation-tab");
 await evalJS("(()=>{const button=[...document.querySelectorAll('.cdw-rail-item')].find(b=>b.textContent.includes('责任待办'));button?.click();return true;})()");
 await until("document.querySelector('.cdw-rail-item.is-current')?.textContent?.includes('责任待办')");
 const obligations=await evalJS("(async()=>{const r=await fetch('/api/workbench/inbox?limit=100');return {status:r.status,data:(await r.json()).data}})()");
 assert.equal(obligations.status,200,"G11 obligation inbox must use real authenticated data");
 const obligationRows=obligations.data.items.filter(item=>item.kind==='obligation');
 const eligibleIndex=obligationRows.findIndex(item=>['manage','integrate','report'].includes(item.obligationKind));
 if(eligibleIndex>=0){
  await evalJS("(()=>{const node=[...document.querySelectorAll('.cdw-task-row')]["+eligibleIndex+"];node?.click()})()");
  await until("!!document.querySelector('.cdw-detail .cdw-review-form')");
  assert.equal(await evalJS("!!document.querySelector('.cdw-detail textarea')"),true,
   "G11 rendered live accountability statement input");
 }
 console.log("CDW_G11_ACCOUNTABILITY_BROWSER_PASS authenticated-inbox+real-obligation-form-when-present");
 // Browser-only fixture: verify the nonempty, deeply linked flow without
 // ever creating a task or approval in the developer database.
 const sample={initiated:{items:[{taskId:"visual_root_1",rootId:"visual_root_1",
  title:"仪器质量文件修订 · 专项交付",fileId:"visual_file_1",state:"submitted",revision:3,
  createdAt:"2026-10-19T04:00:00Z",assigneeName:"负责人甲"}]},
  flow:{taskId:"visual_root_1",rootId:"visual_root_1",truncated:false,
   works:[{id:"visual_root_1",title:"仪器质量文件修订 · 专项交付",state:"submitted",round:2,createdByName:"负责人乙",responsibleName:"负责人甲"},
    {id:"visual_child_1",parentId:"visual_root_1",title:"关键试验验证及交付",state:"accepted",round:1,createdByName:"负责人甲",responsibleName:"负责人丙"}],
   milestones:[{taskId:"visual_child_1",kind:"delivery",reference:"proof_delivery_1",state:"submitted",round:2,actorName:"负责人甲",recordedAt:"2026-10-19T08:00:00Z",detail:"冻结交付稿"},
    {taskId:"visual_child_1",kind:"review",reference:"proof_review_1",state:"awaiting",round:2,actorName:"质量验收人",recordedAt:"2026-10-19T09:00:00Z",detail:"逐级交付验收"}]},
  events:{items:[{id:1,kind:"task",evidenceRef:"visual_root_1",event:"task.create",actorName:"负责人乙",occurredAt:"2026-10-19T04:00:00Z"}]}};
 await evalJS("(()=>{[...document.querySelectorAll('.cdw-rail-item')].find(b=>b.textContent.includes('我发起的'))?.click()})()");
 await until("!!document.querySelector('.cdw-initiated-head')");
 await evalJS(`(()=>{const mock=${JSON.stringify(sample)};const real=window.fetch.bind(window);
  window.__cdwNativeFetch=real;
  window.fetch=(resource,options)=>{const url=new URL(typeof resource==='string'?resource:resource.url,location.origin);
   let result=null;
   if(url.pathname==='/api/workbench/initiated')result=mock.initiated;
   else if(url.pathname==='/api/workbench/initiated/visual_root_1/flow')result=mock.flow;
   else if(url.pathname==='/api/workbench/initiated/visual_root_1/events')result=mock.events;
   return result?Promise.resolve(new Response(JSON.stringify({ok:true,data:result}),{status:200,headers:{'Content-Type':'application/json'}})):real(resource,options);
  };return true})()`);
 await evalJS("(()=>{document.querySelector('.cdw-initiated-head button')?.click()})()");
 await until("document.querySelector('.cdw-flow-work-copy strong')?.textContent?.includes('仪器质量文件修订')");
 assert.equal(await evalJS("document.querySelectorAll('.cdw-flow-work').length"),2,"delegation hierarchy draws two related tasks");
 assert.equal(await evalJS("document.querySelectorAll('.cdw-flow-step').length"),9,"nine independent evidence stage categories render");
 assert.equal(await evalJS("document.querySelectorAll('.cdw-flow-step.has-evidence').length"),2,"only evidenced delivery/review marked observed");
 assert.equal(await evalJS("[...document.querySelectorAll('.cdw-flow-evidence-detail>small')].some(s=>s.textContent.includes('来源工作：关键试验验证及交付'))"),true,"child evidence is attributed to the leaf task");
 assert.equal(await evalJS("document.querySelectorAll('.cdw-flow-step.is-unstarted').length"),7,"unobserved approvals/distribution/effectiveness stay unstarted");
 for(const width of [1440,1024,780,540]){
  await send("Emulation.setDeviceMetricsOverride",{width,height:850,deviceScaleFactor:1,mobile:false});
  await sleep(130);
  const size=await evalJS("(()=>({body:document.documentElement.scrollWidth,canvas:(()=>{const a=document.querySelector('.cdw-flow').getBoundingClientRect();return {left:a.left,right:a.right}})()}))()");
  assert.ok(size.body<=width+2&&size.canvas.left>=-2&&size.canvas.right<=width+2,
   "populated flow canvas must fit "+width+": "+JSON.stringify(size));
  console.log("CDW_FLOW_FIXTURE_LAYOUT_PASS",width);
 }
 await send("Emulation.clearDeviceMetricsOverride");
 await evalJS("(()=>{document.querySelectorAll('.cdw-initiated-tabbar button')[1]?.click()})()");
 await until("!!document.querySelector('.cdw-timeline-item')");
 await evalJS("(()=>{window.fetch=window.__cdwNativeFetch;delete window.__cdwNativeFetch;return true})()");
 console.log("CDW_FLOW_FIXTURE_PASS exact lineage, delegated work, absent nodes and event switch; browser-only no-write fixture");
 console.log("CDW_BROWSER_PASS auth=tasks+review-inbox, responsive=1440/1024/780, review-filter, create-form");
}finally{
 try{ws?.close();}catch{}
 try{process.kill(-chrome.pid,"SIGTERM")}catch{chrome.kill("SIGTERM")}
 if(chrome.exitCode===null&&chrome.signalCode===null)await Promise.race([new Promise(resolve=>chrome.once("exit",resolve)),sleep(2400)]);
 for(let attempt=0;attempt<15;attempt++){
  try{rmSync(profile,{recursive:true,force:true,maxRetries:4,retryDelay:150});break;}
  catch(error){if(attempt===14)throw error;await sleep(270);}
 }
}
