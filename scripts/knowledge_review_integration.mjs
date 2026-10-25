import assert from "node:assert/strict";
import {verifiedAdminSession} from "./qa_session.mjs";
const base="http://127.0.0.1:18096";
const folder=process.argv[2],file=process.argv[3];
const {cookie}=await verifiedAdminSession(base);
async function req(method,url,data,status=200){
 const r=await fetch(base+url,{method,headers:{Cookie:cookie,"content-type":"application/json"},body:data?JSON.stringify(data):undefined});
 const raw=await r.text();assert.equal(r.status,status,method+" "+url+" "+raw.slice(0,150));
 return status<400?JSON.parse(raw).data:null;
}
const root="/api/knowledge",p=id=>root+"/pages/"+encodeURIComponent(id);
assert.equal((await fetch(base+root+"/pages")).status,401);
assert.equal((await req("GET",root+"/folders/"+folder+"/home")).pageId,"");
const a=await req("POST",root+"/pages",{title:"Notion-QA",folderId:folder},201);
const child=await req("POST",root+"/pages",{title:"Child-QA",folderId:folder,parentId:a.id},201);
assert.equal(child.parentId,a.id);
const blocks=[{id:"b1",type:"heading1",text:"DHF"},{id:"b2",type:"todo",text:"review",checked:true}];
const saved=await req("PUT",p(a.id),{title:"Notion-QA-Edit",revision:1,blocks});
assert.equal(saved.revision,2);
await req("PUT",p(a.id),{title:"stale",revision:1,blocks},409);
const v=await req("GET",p(a.id)+"/history");
assert.deepEqual(v.map(x=>x.revision),[2,1]);
await req("PUT",p(a.id)+"/links/"+child.id);
const forward=await req("GET",p(a.id)+"/links");
const backward=await req("GET",p(child.id)+"/links");
assert.equal(forward.some(x=>x.pageId===child.id&&x.direction==="outgoing"),true);
assert.equal(backward.some(x=>x.pageId===a.id&&x.direction==="incoming"),true);
await req("PUT",p(a.id)+"/links/"+a.id,undefined,400);
await req("PUT",p(a.id)+"/links/no-such-page",undefined,404);
await req("DELETE",p(a.id)+"/links/"+child.id);
assert.equal((await req("GET",p(child.id)+"/links")).length,0);


await req("PUT",root+"/folders/"+folder+"/home",{pageId:a.id});
assert.equal((await req("GET",root+"/folders/"+folder+"/home")).pageId,a.id);
await req("PUT",p(a.id)+"/files/"+file);
const linked=await req("GET",p(a.id));
assert.equal(linked.files.some(x=>x.fileId===file),true);
assert.equal((await req("GET",root+"/files/"+file+"/backlinks")).some(x=>x.pageId===a.id),true);
await req("POST",p(a.id)+"/archive",{revision:2},409);
await req("DELETE",root+"/folders/"+folder+"/home");
assert.equal((await req("GET",root+"/folders/"+folder+"/home")).pageId,"");
await req("DELETE",p(a.id)+"/files/"+file);
assert.equal((await req("GET",p(a.id))).files.length,0);
await req("POST",p(child.id)+"/archive",{revision:1});
await req("POST",p(a.id)+"/archive",{revision:2});
await req("GET",p(a.id),undefined,404);
console.log("KNOWLEDGE_API_INTEGRATION_PASS");
