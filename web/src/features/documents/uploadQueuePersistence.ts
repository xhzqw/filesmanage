import type {UploadTask} from "./uploadQueue";
import {sha256Chunk,sha256Fallback} from "../../shared/sha256Chunk";

// Browser storage holds only small task metadata; never store file bytes.
// Cap tasks, age and record length to bound storage and stale-session leakage.
export const uploadCachePrefix="fm-upload-tasks-v1:";
// The server's resumable-upload session TTL is 24h. Persisting the browser's
// resume hint longer would advertise an already expired upload as resumable.
// Chunk activity can extend the server deadline, but a conservative client
// cutoff guarantees the browser never promises more than its original window.
export const resumeCacheMaxAge=24*60*60*1000;
export type CachedTask={
 queueId:string;name:string;sourceName:string;size:number;fileType:string;
 lastModified:number;fingerprint:string;targetFolderId:string;idempotencyKey:string;at:number;
};
export async function fingerprintFile(file:File):Promise<string>{
 const first=await sha256Chunk(await file.slice(0,65536).arrayBuffer());
 const last=await sha256Chunk(await file.slice(Math.max(0,file.size-65536)).arrayBuffer());
 return sha256Fallback(new TextEncoder().encode([file.size,file.type,first,last].join("|")));
}
function isCached(x:unknown):x is CachedTask{
 if(!x||typeof x!=="object")return false;
 const a=x as Partial<CachedTask>;
 return typeof a.queueId==="string"&&a.queueId.length<100&&
  typeof a.name==="string"&&a.name.length<=200&&
  typeof a.sourceName==="string"&&a.sourceName.length<=200&&
  typeof a.size==="number"&&a.size>0&&a.size<=1073741824&&
  typeof a.lastModified==="number"&&Number.isFinite(a.lastModified)&&
  typeof a.fileType==="string"&&a.fileType.length<256&&
  typeof a.fingerprint==="string"&&/^[0-9a-f]{64}$/.test(a.fingerprint)&&
  typeof a.targetFolderId==="string"&&a.targetFolderId.length<256&&
  typeof a.idempotencyKey==="string"&&a.idempotencyKey.length<200&&
  typeof a.at==="number"&&a.at>Date.now()-resumeCacheMaxAge&&a.at<=Date.now()+60000;
}
export function readUploadTasks(userId:string):CachedTask[]{
 try{
  const raw=localStorage.getItem(uploadCachePrefix+userId);
  if(!raw||raw.length>50000)return [];
  const list:unknown=JSON.parse(raw);
  return Array.isArray(list)?list.filter(isCached).slice(0,40):[];
 }catch{return []}
}
export function storeUploadTasks(userId:string,tasks:UploadTask[]):void{
 if(!userId)return;
 try{
 const cache:CachedTask[]=tasks.filter(t=>t.status!=="committed"&&t.status!=="cancelled"&&
   t.size>=8*1024*1024&&t.size<=1073741824&&!!t.fingerprint&&
   (t.cacheAt??Date.now())>Date.now()-resumeCacheMaxAge)
   .slice(-40).map(t=>({
    queueId:t.queueId,name:t.name,sourceName:t.sourceName??t.file?.name??t.name,
    size:t.size,fileType:t.fileType??t.file?.type??"",lastModified:t.lastModified??t.file?.lastModified??0,
    fingerprint:t.fingerprint!,targetFolderId:t.targetFolderId,idempotencyKey:t.idempotencyKey,
    at:t.cacheAt??Date.now(),
   }));
  if(cache.length)localStorage.setItem(uploadCachePrefix+userId,JSON.stringify(cache));
  else localStorage.removeItem(uploadCachePrefix+userId);
 }catch{}
}
