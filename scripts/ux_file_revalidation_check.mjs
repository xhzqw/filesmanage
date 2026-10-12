#!/usr/bin/env node
// Only run on the target host. Verify the file window and preview identity
// contracts that protect pagination, selection and expensive media rendering.
import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require=createRequire(new URL("../web/package.json",import.meta.url));
const {build}=require("esbuild");
const built=await build({entryPoints:["web/src/features/documents/revalidate.ts"],absWorkingDir:process.cwd(),
 platform:"node",format:"esm",bundle:true,write:false,logLevel:"silent"});
const {revalidateFileWindow,reuseVerifiedPreview}=await import("data:text/javascript;base64,"+Buffer.from(built.outputFiles[0].contents).toString("base64"));

const latest=Array.from({length:285},(_,i)=>({id:"file-"+i,name:"file "+i,sha256:"sha"+i,sizeBytes:i+1,contentType:"text/plain"}));
const calls=[];
const fetchPage=async(cursor,limit)=>{
 calls.push({cursor,limit});
 const start=cursor?Number(cursor):0;
 const items=latest.slice(start,start+limit);
 const nextCursor=start+items.length<latest.length?String(start+items.length):"";
 return {items,nextCursor};
};
const refreshed=await revalidateFileWindow(fetchPage,270);
assert.equal(refreshed.items.length,270,"revalidation must retain the previously loaded window, not truncate to page one");
assert.deepEqual(calls,[{cursor:"",limit:200},{cursor:"200",limit:70}],"API 200-row page cap and stable cursors");
assert.equal(refreshed.nextCursor,"270");
const first=await revalidateFileWindow(fetchPage,15);
assert.equal(first.items.length,50,"fresh folder shows one default page");

const snapshot=[...latest];
latest.splice(2,1);
latest.unshift({id:"new-upload",name:"new upload",sha256:"new",sizeBytes:1,contentType:"text/plain"});
const changed=await revalidateFileWindow(fetchPage,270);
assert.equal(changed.items.length,270);
assert.equal(changed.items[0].id,"new-upload","new inserts are ordered by authoritative REST response");
assert.ok(!changed.items.some(item=>item.id===snapshot[2].id),"removed rows must not survive from stale pages");
assert.equal(new Set(changed.items.map(item=>item.id)).size,changed.items.length,"no duplicate IDs in reconciled window");

const aborted=new AbortController();aborted.abort();
await assert.rejects(revalidateFileWindow(fetchPage,100,aborted.signal),{name:"AbortError"});

const preview={fileId:"file-4",name:"original.txt",sha256:"abcd",contentType:"text/plain",size:14};
const file={id:"file-4",name:"original.txt",sha256:"abcd",contentType:"text/plain",sizeBytes:14};
assert.equal(reuseVerifiedPreview(preview,file),preview,"unrelated WS update must not remount preview content");
const renamed=reuseVerifiedPreview(preview,{...file,name:"renamed.txt"});
assert.equal(renamed.name,"renamed.txt");
assert.equal(renamed.sha256,"abcd","rename does not download unchanged bytes");
assert.equal(reuseVerifiedPreview(preview,{...file,sha256:"newsha"}),null,"new content hash must reload bytes");
assert.equal(reuseVerifiedPreview(preview,{...file,sizeBytes:99}),null);
assert.equal(reuseVerifiedPreview(preview,{...file,id:"other"}),null);
assert.equal(reuseVerifiedPreview(preview,{...file,contentType:"application/pdf"}),null);
console.log("FILE_REVALIDATION_PASS: loaded cursor window, concurrent insert/delete, cancellation, preview SHA reuse");
