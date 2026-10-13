#!/usr/bin/env node
// WebSocket client behavioral contract. Run only through remote scripts/build.sh.
// No credentials and no server dependency: all transport responses are mocked.
import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require=createRequire(new URL("../web/package.json",import.meta.url));
const {build}=require("esbuild");
const built=await build({entryPoints:["web/src/app/liveConnection.ts"],
 absWorkingDir:process.cwd(),platform:"node",format:"esm",bundle:true,write:false,logLevel:"silent"});

const browser=new EventTarget();
const realSetTimeout=globalThis.setTimeout;
const realClearTimeout=globalThis.clearTimeout;
const pendingLong=new Map();
const intervals=new Map();
let nextId=10000;
browser.location={protocol:"http:",host:"files.local:18091"};
const cursorStore=new Map();
browser.sessionStorage={
 getItem:key=>cursorStore.get(key)??null,
 setItem:(key,value)=>cursorStore.set(key,value),
};
browser.setTimeout=(callback,ms)=>{
 // Keep fast 16ms invalidation on a real timer; hold back the 250ms
 // reconnect delay so the test can deterministically advance it.
 if(ms>30){const id=++nextId;pendingLong.set(id,callback);return id;}
 return realSetTimeout(callback,ms);
};
browser.clearTimeout=id=>{
 pendingLong.delete(id);
 realClearTimeout(id);
};
browser.setInterval=callback=>{const id=++nextId;intervals.set(id,callback);return id;};
browser.clearInterval=id=>intervals.delete(id);
const replies=[];
globalThis.fetch=(_url,_init)=>new Promise(resolve=>replies.push(resolve));
globalThis.window=browser;
globalThis.document={visibilityState:"visible"};
globalThis.CustomEvent ??= class CustomEvent extends Event{
 constructor(type,options={}){super(type);this.detail=options.detail;}
};
class FakeSocket {
 static CONNECTING=0;
 static OPEN=1;
 static CLOSED=3;
 static instances=[];
 constructor(url){
  assert.ok(url.startsWith("ws://files.local:18091/api/events/ws"),"same-origin WebSocket only");
  this.url=url;
  this.readyState=FakeSocket.CONNECTING;
  FakeSocket.instances.push(this);
 }
 open(){this.readyState=FakeSocket.OPEN;this.onopen?.();}
 message(data){this.onmessage?.({data:JSON.stringify(data)});}
 close(){
  if(this.readyState===FakeSocket.CLOSED)return;
  this.readyState=FakeSocket.CLOSED;
  this.onclose?.();
 }
}
globalThis.WebSocket=FakeSocket;
const imported=await import("data:text/javascript;base64,"+Buffer.from(built.outputFiles[0].contents).toString("base64"));
const identities=[];
const scoped=[];
const onWorkspace=e=>scoped.push(e.detail.scopes);
browser.addEventListener("filesmanage:workspace-changed",onWorkspace);
const stop=imported.connectSessionEvents(user=>identities.push(user?.id??null));
assert.equal(FakeSocket.instances.length,1,"one connection per session");
const first=FakeSocket.instances[0];
first.open();
first.message({type:"connection.ready",version:2,resync:true});
assert.equal(replies.length,1,"ready requests identity reconciliation");
first.message({type:"session.changed"});
assert.equal(replies.length,2,"a session change bypasses the 2.5s validation throttle");
const success=user=>({ok:true,status:200,headers:{get:()=>null},json:async()=>({ok:true,data:{id:user}})});
// The newer identity response wins even if the older request finishes later.
replies[1](success("new-user"));
await new Promise(resolve=>setImmediate(resolve));
replies[0](success("stale-user"));
await new Promise(resolve=>setImmediate(resolve));
assert.deepEqual(identities,["new-user"],"stale identity responses never overwrite the latest identity");

first.message({type:"workspace.changed",scopes:["file","stats"]});
first.message({type:"workspace.changed",scopes:["file","trash"]});
await new Promise(resolve=>realSetTimeout(resolve,65));
assert.equal(scoped.length,1,"WebSocket events within one flush window coalesce");
assert.deepEqual(scoped[0].sort(),["file","folder","trash","permissions","collaboration","organization","search","stats","review","lifecycle","approval-policy","presets"].sort(),
 "initial reconnect triggers complete state revalidation");

first.message({type:"session.changed"});
assert.equal(replies.length,3);
first.message({type:"session.revoked"});
assert.equal(identities.at(-1),null,"revocation clears the session synchronously");
replies[2](success("not-authorized"));
await new Promise(resolve=>setImmediate(resolve));
assert.equal(identities.at(-1),null,"in-flight identity checks cannot resurrect a revoked session");
assert.equal(first.readyState,FakeSocket.CLOSED,"revoked sockets close immediately");
stop();
assert.equal(intervals.size,0,"the liveness watchdog is removed at unmount");
assert.equal(pendingLong.size,0,"revoked sessions cannot schedule reconnects");

// A network disconnect schedules bounded reconnect; a fresh ready frame
// revalidates resources even if no individual event survived the outage.
const identities2=[];
const stop2=imported.connectSessionEvents(user=>identities2.push(user?.id??null));
const second=FakeSocket.instances.at(-1);
second.open();
const originalNow=Date.now;
const start=Date.now();
Date.now=()=>start+45000;
for(const watchdog of intervals.values())watchdog();
Date.now=originalNow;
assert.equal(second.readyState,FakeSocket.CLOSED,"missed heartbeats must close a half-open connection");
assert.equal(replies.length,4,"disconnect initiates a bounded identity recheck");
assert.equal(pendingLong.size,1,"disconnect schedules exactly one retry");
const retry=pendingLong.values().next().value;
pendingLong.clear();
retry();
assert.equal(FakeSocket.instances.length,3,"retry opens one replacement socket");
const replacement=FakeSocket.instances.at(-1);
replacement.open();
replacement.message({type:"connection.ready",version:2,resync:true});
assert.equal(replies.length,5,"reconnect rechecks identity");
replies[4](success("restored-user"));
await new Promise(resolve=>setImmediate(resolve));
replies[3](success("stale-user"));
await new Promise(resolve=>setImmediate(resolve));
assert.deepEqual(identities2,["restored-user"]);
stop2();
// A v3 cursor is stored only after invalidation has been dispatched, then
// replayed after a fresh socket connects. Bookmarks are partitioned by user.
const stop3=imported.connectSessionEvents(()=>{},"u_replay");
const replaySocket=FakeSocket.instances.at(-1);
replaySocket.open();
assert.ok(!replaySocket.url.includes("cursor="),"no bookmark for a fresh user");
replaySocket.message({type:"connection.ready",version:3,resync:true,cursor:"31"});
assert.equal(cursorStore.get("fm-live-cursor-v3:u_replay"),undefined,"cannot ack before refresh");
await new Promise(resolve=>realSetTimeout(resolve,170));
assert.equal(cursorStore.get("fm-live-cursor-v3:u_replay"),"31");
replaySocket.message({type:"workspace.changed",scopes:["file"],cursor:"32"});
assert.equal(cursorStore.get("fm-live-cursor-v3:u_replay"),"31","unapplied event remains replayable");
await new Promise(resolve=>realSetTimeout(resolve,170));
assert.equal(cursorStore.get("fm-live-cursor-v3:u_replay"),"32","applied hint persists its cursor");
stop3();
const stop4=imported.connectSessionEvents(()=>{},"u_replay");
const resumed=FakeSocket.instances.at(-1);
assert.ok(resumed.url.endsWith("?cursor=32"),"reconnect must replay from durable bookmark");
resumed.open();
resumed.message({type:"connection.ready",version:3,resync:false,cursor:"32"});
await new Promise(resolve=>realSetTimeout(resolve,170));
assert.equal(cursorStore.get("fm-live-cursor-v3:u_replay"),"32");
stop4();
// A second browser tab must not inherit the first tab's applied bookmark.
// sessionStorage is tab-local, unlike localStorage, so it must reconnect
// without a cursor and reconcile all visible state instead.
const tabAStorage=browser.sessionStorage;
browser.sessionStorage={
 getItem:()=>null,
 setItem:()=>{},
};
const stopOtherTab=imported.connectSessionEvents(()=>{},"u_replay");
const otherTab=FakeSocket.instances.at(-1);
assert.ok(!otherTab.url.includes("cursor="),"separate tabs must never share replay progress");
stopOtherTab();
browser.sessionStorage=tabAStorage;
browser.removeEventListener("filesmanage:workspace-changed",onWorkspace);
assert.equal(pendingLong.size,0);
assert.equal(intervals.size,0);
console.log("LIVE_CONNECTION_PASS: event coalescing, identity ordering, revocation safety, heartbeat watchdog, reconnect reconciliation, cleanup");
