#!/usr/bin/env node
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {runInNewContext} from "node:vm";

const require=createRequire(import.meta.url);
const ts=require("../web/node_modules/typescript");
function load(path){
 const source=readFileSync(path,"utf8");
 const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const module={exports:{}};
 runInNewContext(code,{module,exports:module.exports,Intl,Date});
 return module.exports;
}
const {compareFinderFolders,compareFinderFiles}=load("web/src/features/documents/finderSort.ts");
const {readFinderAssignmentBatches}=load("web/src/features/documents/finderAssignmentBatches.ts");
const {compactExplorerName}=load("web/src/shared/explorerDisplayName.ts");
const folders=[
 {id:"a",name:"旅程目录-2",updatedAt:"2026-10-01T00:00:00Z"},
 {id:"b",name:"旅程目录-10",updatedAt:"2026-10-10T00:00:00Z"},
 {id:"c",name:"市场部",updatedAt:"2026-10-04T00:00:00Z"},
 {id:"d",name:"没有修改时间"},
];
const files=[
 {id:"a",name:"示范01.pdf",sizeBytes:500,updatedAt:"2026-10-03T00:00:00Z"},
 {id:"b",name:"示范2.pdf",sizeBytes:100,updatedAt:"2026-10-05T00:00:00Z"},
 {id:"c",name:"普门-糖化血红蛋白校准品-9SX1230070(1)_副本.pdf",sizeBytes:1200,updatedAt:"2026-10-02T00:00:00Z"},
];
for(const sort of ["updated_desc","name_asc","name_desc","size_desc"]){
 const f=[...folders].sort((a,b)=>compareFinderFolders(a,b,sort));
 const x=[...files].sort((a,b)=>compareFinderFiles(a,b,sort));
 assert(f.length===4&&x.length===3);
 assert.equal(new Set(f.map(item=>item.id)).size,4);
 if(sort==="updated_desc")assert.deepEqual(f.map(item=>item.id),["b","c","a","d"]);
 if(sort==="name_asc")assert(f.findIndex(item=>item.id==="a")<f.findIndex(item=>item.id==="b"));
 if(sort==="size_desc")assert.deepEqual(x.map(item=>item.id),["c","a","b"]);
 if(sort==="name_desc")assert(x.findIndex(item=>item.id==="a")>x.findIndex(item=>item.id==="b"));
}
// Stress mixed-script filenames and astral Unicode code points without
// corrupting extension delimiters.
for(let i=0;i<1200;i++){
 const input="📁设备-中晟-"+i+"-质量核对-批号"+i.toString(36).padStart(4,"0")+"_副本 ("+i+").STEP";
 const result=compactExplorerName(input);
 assert(result.includes("…")&&result.endsWith(".STEP"),JSON.stringify({input,result}));
 assert(!result.includes(" .STEP"));
}
assert.equal(compactExplorerName("RFID-RC522 .step"),"RFID-RC522.step");
const ids=Array.from({length:734},(_,i)=>"file_"+i);
let calls=0,active=0,maxActive=0;
const assignments=await readFinderAssignmentBatches(ids,async batch=>{
 calls++;active++;maxActive=Math.max(maxActive,active);
 assert(batch.length>0&&batch.length<=100);
 await new Promise(resolve=>setTimeout(resolve,2));
 active--;
 return Object.fromEntries(batch.map(id=>[id,["tag"]]));
});
assert.equal(calls,8);
assert(maxActive<=3);
assert.equal(Object.keys(assignments).length,ids.length);
assert.deepEqual(assignments.file_733,["tag"]);
let cancelled=false;
const partial=await readFinderAssignmentBatches(ids,async batch=>{
 cancelled=true;return Object.fromEntries(batch.map(id=>[id,["tag"]]));
},()=>!cancelled);
assert.equal(Object.keys(partial).length,0,"Stale assignment generation must not publish partial batches");
console.log("FINDER_SECOND_ROUND_SORT_CJK_HIGH_VOLUME_PASS",JSON.stringify({sorts:4,names:1200,assignments:734,batches:calls,maxConcurrent:maxActive}));
