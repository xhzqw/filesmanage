#!/usr/bin/env node
// Pure client-state contract tests, executed only on the remote build host.
// Bundle TS in memory so Node runs the exact module used by the browser app.
import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require=createRequire(new URL("../web/package.json",import.meta.url));
const {build}=require("esbuild");

async function load(entry){
 const bundled=await build({entryPoints:[entry],absWorkingDir:process.cwd(),
  platform:"node",format:"esm",bundle:true,write:false,logLevel:"silent"});
 return import("data:text/javascript;base64,"+Buffer.from(bundled.outputFiles[0].contents).toString("base64"));
}

const queue=await load("web/src/features/documents/uploadQueue.ts");
const folders=await load("web/src/features/folders/folderPageMerge.ts");
const persistence=await load("web/src/features/documents/uploadQueuePersistence.ts");
const row=(index,status)=>({
 queueId:"task"+index,name:"file"+index,size:8*1024*1024,
 targetFolderId:"folder_root",idempotencyKey:"key"+index,status,
 file:null,fileType:"application/octet-stream",sourceName:"file"+index,
 lastModified:123456,fingerprint:"a".repeat(64),cacheAt:Date.now()-23*60*60*1000,
});
const history=[
 ...Array.from({length:55},(_,index)=>row(index,"committed")),
 row(55,"failed"),row(56,"interrupted"),row(57,"queued"),row(58,"uploading"),row(59,"cancelled")
];
const bounded=queue.limitFinishedHistory(history);
assert.equal(bounded.filter(queue.isFinished).length,40);
assert.equal(bounded.length,44);
assert.deepEqual(bounded.filter(x=>!queue.isFinished(x)).map(x=>x.status),["failed","interrupted","queued","uploading"]);
assert.equal(bounded[0].queueId,"task16");
assert.equal(bounded.at(-1).queueId,"task59");
const remaining=queue.clearFinishedTasks(bounded);
assert.deepEqual(remaining.map(x=>x.status),["failed","interrupted","queued","uploading"]);
assert.equal(queue.limitFinishedHistory(remaining).length,4);

// A same-name upload must not silently replace an existing document. Only an
// explicit confirmed target transitions the failed task into a new operation.
const conflict={...row(61,"failed"),file:{name:"part.step"},failureCode:"E_NAME_CONFLICT"};
assert.equal(queue.replaceTask([conflict],conflict.queueId,{fileId:"file_1",versionSeq:3})[0].status,"queued");
const confirmed=queue.replaceTask([conflict],conflict.queueId,{fileId:"file_1",versionSeq:3})[0];
assert.deepEqual(confirmed.replacement,{fileId:"file_1",versionSeq:3});
assert.notEqual(confirmed.idempotencyKey,conflict.idempotencyKey,"replacement has its own replay identity");
assert.deepEqual(queue.replaceTask([{...conflict,failureCode:"E_FORBIDDEN"}],conflict.queueId,{fileId:"file_1",versionSeq:3})[0].status,"failed");
assert.equal(queue.renameTask([confirmed],confirmed.queueId,"other.step")[0].replacement,undefined);

const merged=folders.mergeDistinctById(
 [{id:"a",name:"original"},{id:"b",name:"B"}],
 [{id:"b",name:"other"},{id:"c",name:"C"},{id:"c",name:"duplicate"}]
);
assert.deepEqual(merged.map(x=>x.id),["a","b","c"]);
assert.equal(merged[1].name,"B");
assert.deepEqual(folders.mergeDistinctById([],[]),[]);

const storage=new Map();
globalThis.localStorage={
 getItem:key=>storage.get(key)??null,
 setItem:(key,value)=>storage.set(key,String(value)),
 removeItem:key=>storage.delete(key),
};
const stamp=Date.now()-23*60*60*1000;
const resumed={...row(8,"failed"),cacheAt:stamp};
persistence.storeUploadTasks("testuser",[resumed]);
const key=persistence.uploadCachePrefix+"testuser";
assert.equal(JSON.parse(storage.get(key))[0].at,stamp);
persistence.storeUploadTasks("testuser",[{...resumed,status:"uploading",progress:{loaded:12,total:24}}]);
assert.equal(JSON.parse(storage.get(key))[0].at,stamp,"progress must not renew cache TTL");
assert.equal(persistence.readUploadTasks("testuser")[0].at,stamp);
persistence.storeUploadTasks("testuser",[{...resumed,cacheAt:Date.now()-25*60*60*1000}]);
assert.equal(storage.has(key),false,"expired resume metadata must be dropped");
assert.equal(persistence.resumeCacheMaxAge,24*60*60*1000);
console.log("UX_QUEUE_STATE_PASS: capped history, actionable retention, folder deduplication, server-aligned 24h resume expiry");
