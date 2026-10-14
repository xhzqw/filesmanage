#!/usr/bin/env node
// Real TS upload client's network uncertainty contract; fake transport only,
// never writes live/QA databases. Runs remotely as part of scripts/build.sh.
import assert from "node:assert/strict";
import {File} from "node:buffer";
import {createRequire} from "node:module";
const require=createRequire(new URL("../web/package.json",import.meta.url));
const {build}=require("esbuild");
const bundled=await build({entryPoints:["web/src/shared/resumableUpload.ts"],absWorkingDir:process.cwd(),
 platform:"node",format:"esm",bundle:true,write:false,logLevel:"silent"});
const {uploadResumable}=await import("data:text/javascript;base64,"+Buffer.from(bundled.outputFiles[0].contents).toString("base64"));

const bytes="lost-response-recover";
const file=new File([bytes],"recovery.bin",{type:"application/octet-stream",lastModified:1740000000});
const result={fileId:"file_recovered",versionSeq:1,sha256:"a".repeat(64),size:file.size,name:file.name,deduplicated:false};
const open=()=>({id:"upload_recovery",received:0,size:file.size,state:"open",expiresAt:new Date(Date.now()+3600000).toISOString()});
const response=(value,status=200)=>({ok:status>=200&&status<300,status,headers:new Headers(),json:async()=>status===200?{ok:true,data:value}:{ok:false,error:{code:"E_VERSION_CONFLICT"}}});
const key="resume-operation-123456";

let state=open(),patches=0,completes=0,starts=0,statusChecks=0;
globalThis.fetch=async(url,init)=>{
 const path=String(url),method=init?.method;
 if(path==="/api/uploads/resumable"&&method==="POST"){starts++;return response(state);}
 if(path.endsWith("/upload_recovery")&&method==="PATCH"){
  patches++;state={...state,received:file.size};
  throw new TypeError("chunk response disconnected AFTER commit to spool");
 }
 if(path.endsWith("/upload_recovery")&&method==="GET"){statusChecks++;return response(state);}
 if(path.endsWith("/upload_recovery/complete")&&method==="POST"){
  completes++;state={...state,state:"committed",result};
  throw new TypeError("completion response disconnected AFTER commit");
 }
 throw Error("unexpected "+method+" "+path);
};
const progress=[];
assert.deepEqual(await uploadResumable("folder_root",file,key,{onProgress:p=>progress.push(p)}),result);
assert.equal(starts,1);
assert.equal(patches,1,"lost chunk response must reconcile the durable offset, not retransmit");
assert.equal(completes,1,"lost commit response must return the durable result without a second commit");
assert.ok(statusChecks>=2);
assert.equal(progress.at(-1)?.loaded,file.size);

let otherCalls=0;
globalThis.fetch=async(url,init)=>{
 if(String(url)==="/api/uploads/resumable"&&init?.method==="POST")return response({...open(),state:"committed",received:file.size,result});
 otherCalls++;
 throw Error("committed session must not send extra requests");
};
assert.deepEqual(await uploadResumable("folder_root",file,key,{}),result);
assert.equal(otherCalls,0,"re-attach on refresh reuses committed server result");

globalThis.fetch=async()=>response({...open(),received:file.size+1});
await assert.rejects(uploadResumable("folder_root",file,key,{}),e=>e.code==="E_VERSION_CONFLICT");

let forbiddenCalls=0;
globalThis.fetch=async()=>{forbiddenCalls++;return response(null,409);};
await assert.rejects(uploadResumable("folder_root",file,key,{}),e=>e.code==="E_VERSION_CONFLICT");
assert.equal(forbiddenCalls,1,"an expired session must not silently start a new upload");

// The opposite uncertainty: completion failed before commit, server still
// advertises fully received data; retry the SAME idempotent completion once.
state={...open(),received:file.size};
completes=0;
globalThis.fetch=async(url,init)=>{
 const path=String(url),method=init?.method;
 if(path==="/api/uploads/resumable"&&method==="POST")return response(state);
 if(path.endsWith("/upload_recovery/complete")&&method==="POST"){
  completes++;
  if(completes===1)throw new TypeError("no response");
  state={...state,state:"committed",result};
  return response(result);
 }
 if(path.endsWith("/upload_recovery")&&method==="GET")return response(state);
 throw Error("unexpected "+method+" "+path);
};
assert.deepEqual(await uploadResumable("folder_root",file,key,{}),result);
assert.equal(completes,2,"retry same complete only after status confirms all bytes received");
console.log("RESUMABLE_RECONCILE_PASS: lost chunk/commit response, committed replay, invalid offset, expired session, safe complete retry");
