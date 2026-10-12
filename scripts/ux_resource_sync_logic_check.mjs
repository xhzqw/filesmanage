#!/usr/bin/env node
// Resource invalidation contract: verify cross-tab storage signals are hints
// only and current-tab dialogs are never preemptively unmounted on a mutation.
import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require=createRequire(new URL("../web/package.json",import.meta.url));
const {build}=require("esbuild");
const built=await build({entryPoints:["web/src/shared/resourceSync.ts"],absWorkingDir:process.cwd(),
 platform:"node",format:"esm",bundle:true,write:false,logLevel:"silent"});
const browser=new EventTarget();
const documentTarget=new EventTarget();
documentTarget.visibilityState="visible";
const store=new Map();
browser.localStorage={
 getItem:key=>store.get(key)??null,
 setItem:(key,value)=>store.set(key,value),
 removeItem:key=>store.delete(key),
};
globalThis.window=browser;
globalThis.document=documentTarget;
globalThis.CustomEvent ??= class CustomEvent extends Event {
 constructor(type,options={}){super(type);this.detail=options.detail;}
};
const sync=await import("data:text/javascript;base64,"+Buffer.from(built.outputFiles[0].contents).toString("base64"));
const recorded=[];
const stop=sync.observeResourceChange("file",change=>recorded.push(change));
sync.publishResourceChange({scope:"file",id:"file-1"});
assert.equal(recorded.length,0,"local mutation must not interrupt its own editor");
const message=store.get("fm-workspace-change-v1");
assert.ok(message,"other tabs receive a storage change token");
const event=new Event("storage");
Object.defineProperties(event,{key:{value:"fm-workspace-change-v1"},newValue:{value:message}});
browser.dispatchEvent(event);
assert.deepEqual(recorded,[{scope:"file",id:"file-1"}]);
const malformed=new Event("storage");
Object.defineProperties(malformed,{key:{value:"fm-workspace-change-v1"},newValue:{value:'{"change":{"scope":"nonsense"}}'}});
browser.dispatchEvent(malformed);
assert.equal(recorded.length,1,"invalid hints are ignored");
const workspace=[];
const stopWorkspace=sync.observeWorkspaceChange(()=>workspace.push("presets"),["presets"]);
sync.receiveRemoteResourceChanges(["file","presets","presets"]);
assert.deepEqual(recorded,[{scope:"file",id:"file-1"},{scope:"file"}],
 "anonymous WebSocket file change revalidates authorized resource subscribers once");
assert.deepEqual(workspace,["presets"],"workspace observers filter and dedupe scopes");
sync.receiveRemoteResourceChanges(["organization"]);
assert.equal(workspace.length,1,"unrelated workspace scopes never trigger preset re-reads");
stopWorkspace();
sync.receiveRemoteResourceChanges(["presets"]);
assert.equal(workspace.length,1,"unmounted workspace listeners are removed");
stop();
browser.dispatchEvent(event);
assert.equal(recorded.length,2,"listeners unsubscribe on unmount");
let returned=0;
const close=sync.observeWindowReturn(()=>returned++);
browser.dispatchEvent(new Event("focus"));
assert.equal(returned,1,"focus revalidates an inactive preview");
documentTarget.dispatchEvent(new Event("visibilitychange"));
assert.equal(returned,1,"focus and visibility events are coalesced");
close();
console.log("RESOURCE_SYNC_PASS: cross-tab, WebSocket scope deduplication, local-editor safety, focus revalidation, cleanup");
