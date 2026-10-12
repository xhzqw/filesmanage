#!/usr/bin/env node
// Isolated store contract checks: transpile (do not bundle) the production
// feedback module and exercise it with a deterministic virtual clock.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {runInNewContext} from "node:vm";

const require=createRequire(import.meta.url);
const ts=require("../web/node_modules/typescript");
const source=readFileSync(new URL("../web/src/shared/ui/feedback.ts",import.meta.url),"utf8");
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;

function harness(){
 let clock=1000,nextTimer=0;
 const timers=new Map();
 let state={items:[]};
 const store={
  getState:()=>state,
  setState:update=>{
   const value=typeof update==="function"?update(state):update;
   state={...state,...value};
  },
 };
 const module={exports:{}};
 const sandbox={
  module,exports:module.exports,
  require:id=>{
   if(id==="zustand")return {create:initial=>{state=initial();return store;}};
   if(id==="../errors")return {errorCode:e=>e?.code??"",errorCopy:(_,fallback)=>fallback};
   throw Error("unexpected module "+id);
  },
  Date:class extends Date{static now(){return clock;}},
  setTimeout:(callback,delay)=>{const id=++nextTimer;timers.set(id,{at:clock+delay,callback});return id;},
  clearTimeout:id=>timers.delete(id),
 };
 runInNewContext(js,sandbox,{filename:"feedback.ts"});
 return {
  toast:module.exports.toast,
  items:()=>store.getState().items,
  advance:(ms)=>{
   clock+=ms;
   for(const [id,timer] of Array.from(timers)){
    if(timer.at<=clock){timers.delete(id);timer.callback();}
   }
  },
 };
}
function deferred(){
 let resolve,reject;
 const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
 return {promise,resolve,reject};
}
const labels={loading:"保存中",success:"已保存",error:"保存失败"};

{
 const h=harness();
 const task=h.toast.track(async()=>42,labels);
 assert.equal(await task,42);
 assert.deepEqual(h.items().map(x=>x.tone),["success"]);
 assert.equal(h.items()[0].duration,4000);
}
{
 const h=harness(),a=deferred(),b=deferred();
 const first=h.toast.track(()=>a.promise,labels);
 const second=h.toast.track(()=>b.promise,labels);
 h.advance(451);
 assert.equal(h.items().filter(x=>x.tone==="loading").length,2,"parallel writes have independent pending IDs");
 const ids=h.items().map(x=>x.id);
 assert.notEqual(ids[0],ids[1]);
 a.resolve(1);await first;
 assert.equal(h.items().find(x=>x.id===ids[0]).tone,"success");
 assert.equal(h.items().find(x=>x.id===ids[1]).tone,"loading","first completion cannot dismiss second spinner");
 b.resolve(2);await second;
 assert.equal(h.items().find(x=>x.id===ids[1]).tone,"success");
}
{
 const h=harness(),task=deferred();
 const promise=h.toast.track(()=>task.promise,labels);
 h.advance(451);
 task.reject(Object.assign(Error("offline"),{code:"E_NETWORK"}));
 await assert.rejects(promise);
 assert.deepEqual(h.items().map(x=>x.tone),["warning"]);
 assert.match(h.items()[0].text,/未确认/);
}
{
 const h=harness();
 const first=h.toast.success("重复成功");
 const oldRevision=h.items()[0].revision;
 h.advance(400);
 const second=h.toast.success("重复成功");
 assert.equal(first,second);
 assert.ok(h.items()[0].revision>oldRevision,"repeat refreshes the timeout revision");
 h.advance(901);
 assert.notEqual(h.toast.success("重复成功"),first,"later user actions still get new notices");
}
{
 const h=harness();
 h.toast.error("操作失败 A");h.toast.error("操作失败 B");
 h.toast.error("操作失败 C");h.toast.warning("结果未知");
 h.toast.success("例行操作完成");
 assert.equal(h.items().length,4);
 assert.equal(h.items().some(x=>x.text==="例行操作完成"),false,"routine success cannot push out warnings");
}
{
 const h=harness(),task=deferred();
 h.toast.bindOwner("alice");
 const promise=h.toast.track(()=>task.promise,labels);
 h.advance(451);
 assert.equal(h.items().length,1);
 h.toast.bindOwner("bob");
 assert.equal(h.items().length,0);
 task.resolve(1);await promise;
 assert.equal(h.items().length,0,"old account cannot publish a tracked result");
}
{
 const h=harness(),task=deferred();
 const promise=h.toast.track(()=>task.promise,{...labels,errorToast:false});
 h.advance(451);
 task.reject(Object.assign(Error("invalid"),{code:"E_BAD"}));
 await assert.rejects(promise);
 assert.equal(h.items().length,0,"field-level validation can suppress a duplicate global alert");
}
console.log("TOAST_FEEDBACK_CHECK_PASS: parallel, expiry revision, severity, identity, uncertainty, modal errors");
