#!/usr/bin/env node
// Read-only smoke gate for Organization > Permissions P1.
// Run ONLY on the development target (never in the local worktree).
// The credential is read from the remote-only secret and never logged.
import {verifiedAdminSession} from "./qa_session.mjs";

const BASE=(process.env.FILESMANAGE_DEV_URL||"http://127.0.0.1:18091").replace(/\/$/,"");
const assert=(okay,what)=>{if(!okay)throw new Error("FAIL "+what);console.log("PASS "+what);};
let cookie="";

async function request(path,method="GET",body){
 const res=await fetch(BASE+path,{method,headers:{
  "Origin":BASE,"Content-Type":"application/json",
  ...(cookie?{"Cookie":cookie}:{}),
 },...(body!==undefined?{body:JSON.stringify(body)}:{})});
 const json=await res.json().catch(()=>null);
 return {status:res.status,data:json?.data,error:json?.error,
  setCookie:res.headers.get("set-cookie")};
}

const anonymous=await request("/api/permissions/audit");
assert(anonymous.status===401,"audit requires login");
const anonymousExplain=await request("/api/permissions/explain","POST",{subjectKind:"user",subjectId:"x",folderId:"x"});
assert(anonymousExplain.status===401,"explain requires login");
const anonymousRoles=await request("/api/roles/bindings");
assert(anonymousRoles.status===401,"role bindings require login");

const session=await verifiedAdminSession(BASE);
cookie=session.cookie;
assert((await request("/api/me")).status===200,"verified admin session ("+(session.reused?"reused":"new")+")");
const roles=await request("/api/roles/bindings");
assert(roles.status===200&&Array.isArray(roles.data),"admin can list management role bindings");
const myRoles=await request("/api/roles/me");
assert(myRoles.status===200&&Array.isArray(myRoles.data),"self-scoped management roles work");
const users=await request("/api/users");
const folders=await request("/api/folders/tree");
assert(users.status===200&&Array.isArray(users.data),"admin subject list");
assert(folders.status===200&&Array.isArray(folders.data)&&folders.data.length>0,"visible folder list");
const user=users.data.find(u=>u.isAdmin===true)||users.data[0];
const folder=folders.data[0];
const result=await request("/api/permissions/explain","POST",{
 subjectKind:"user",subjectId:user.id,folderId:folder.id,
});
assert(result.status===200&&result.data?.folderId===folder.id&&result.data?.subjectId===user.id,
 "effective permission explanation");
assert(Array.isArray(result.data.effectiveActions)&&Array.isArray(result.data.sources),
 "explanation has decision and source lists");
if(user.isAdmin){
 assert(result.data.effectiveActions.length===9&&
  result.data.sources.some(s=>s.kind==="admin_override"),"admin override comes from server");
}
const invalid=await request("/api/permissions/explain","POST",{
 subjectKind:"group",subjectId:user.id,folderId:folder.id,
});
assert(invalid.status===400,"unsupported principal kind is rejected");
const missing=await request("/api/permissions/explain","POST",{
 subjectKind:"user",subjectId:"missing_subject",folderId:folder.id,
});
assert(missing.status===404,"unknown principal is hidden");
const audit=await request("/api/permissions/audit?limit=2");
assert(audit.status===200&&Array.isArray(audit.data?.items)&&
 typeof audit.data?.nextCursor==="string","admin paged permission audit");
if(audit.data.nextCursor){
 const next=await request("/api/permissions/audit?limit=2&cursor="+encodeURIComponent(audit.data.nextCursor));
 assert(next.status===200&&next.data.items.every(a=>a.id<Number(audit.data.nextCursor)),
  "audit keyset pagination does not repeat rows");
}
const invalidCursor=await request("/api/permissions/audit?cursor=-1");
assert(invalidCursor.status===400,"invalid audit cursor is rejected");
console.log("PERMISSIONS_P1_CHECK_PASS");
