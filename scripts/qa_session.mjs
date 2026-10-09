// Remote-target QA helper. Reuse a legitimate, verified admin session so
// independent read-only UI checks do not consume /api/login's security budget.
// Never share this file or its contents, log tokens, or weaken rate limiting.
import {readFileSync,writeFileSync,statSync,renameSync,unlinkSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {resolve} from "node:path";

const CACHE=resolve(".secrets/qa-admin-session.json");
const MAX_AGE_MS=2*60*60*1000;
const LOOPBACK=new Set(["localhost","127.0.0.1","::1"]);

async function validCookie(base,cookie){
 try{
  const res=await fetch(base+"/api/me",{headers:{Cookie:cookie},signal:AbortSignal.timeout(6000)});
  if(!res.ok)return false;
  const reply=await res.json();
  return reply?.ok===true&&reply?.data?.isAdmin===true;
 }catch{return false;}
}

export async function verifiedAdminSession(base="http://127.0.0.1:18091"){
 const uri=new URL(base);
 if(uri.protocol!=="http:"||!LOOPBACK.has(uri.hostname)||uri.username||uri.password){
  throw Error("QA session only supports direct remote-target loopback HTTP");
 }
 base=uri.origin;
 try{
  const file=statSync(CACHE);
  if(!file.isFile()||(file.mode&0o077)!==0||(process.getuid&&file.uid!==process.getuid())){
   throw Error("QA session cache must be a private owner-only file");
  }
  const entry=JSON.parse(readFileSync(CACHE,"utf8"));
  if(entry.base===base&&typeof entry.cookie==="string"&&
     /^fm_session=[A-Za-z0-9_.\-]+$/.test(entry.cookie)&&
     Date.now()-entry.createdAt<MAX_AGE_MS&&
     await validCookie(base,entry.cookie)){
   return {cookie:entry.cookie,reused:true};
  }
 }catch(error){
  if(error?.code!=="ENOENT"&&!String(error?.message??"").includes("JSON")){
   throw error;
  }
 }
 const secret=readFileSync(".secrets/admin.password","utf8").trim();
 const res=await fetch(base+"/api/login",{
  method:"POST",headers:{"Content-Type":"application/json","Origin":base},
  body:JSON.stringify({login:"admin",password:secret}),
  signal:AbortSignal.timeout(9000),
 });
 if(res.status===429){
  const retry=res.headers.get("Retry-After")??"unspecified";
  throw Error(`QA authentication rate-limited (HTTP 429); respect Retry-After=${retry}s. No retry attempted.`);
 }
 if(!res.ok)throw Error(`QA authentication failed (HTTP ${res.status})`);
 const value=res.headers.get("set-cookie")?.split(";")[0];
 if(!value||!/^fm_session=[A-Za-z0-9_.\-]+$/.test(value)){
  throw Error("QA authentication did not return a valid session cookie");
 }
 if(!await validCookie(base,value))throw Error("QA admin session verification failed");
 const temp=CACHE+"."+randomUUID();
 try{
  writeFileSync(temp,JSON.stringify({base,cookie:value,createdAt:Date.now()}),
   {mode:0o600,flag:"wx"});
  renameSync(temp,CACHE);
 }finally{
  try{unlinkSync(temp);}catch(error){if(error?.code!=="ENOENT")throw error;}
 }
 return {cookie:value,reused:false};
}
