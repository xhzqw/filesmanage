import {ApiError,reportSessionIssue} from "./http";
import {sha256Chunk} from "./sha256Chunk";

export type ResumableUploadResult={fileId:string;versionSeq:number;sha256:string;size:number;name:string;deduplicated:boolean};
export type ResumableProgress={loaded:number;total:number};
type UploadSession={id:string;received:number;size:number;state:"open"|"committed"|"cancelled";expiresAt:string;result?:ResumableUploadResult};
type Reply<T>={ok:boolean;data?:T;error?:{code:string;message?:string}};
const chunkSize=2<<20;
export const resumableThreshold=8<<20;
export const resumableMaxFile=1<<30;
async function requestUpload<T>(url:string,method:string,body:BodyInit|undefined,headers:Record<string,string>,signal?:AbortSignal):Promise<T>{
 let response:Response;
 try{
  response=await fetch("/api"+url,{method,credentials:"same-origin",headers,body,signal});
 }catch(e){
  if(signal?.aborted)throw new ApiError("E_CANCELLED",0,undefined,"已取消");
  throw new ApiError("E_NETWORK",0,undefined,e instanceof Error?e.message:"连接中断");
 }
 let reply:Reply<T>|undefined;
 try{reply=await response.json() as Reply<T>;}catch{reply=undefined;}
 if(!response.ok||!reply?.ok){
  const code=reply?.error?.code||(response.status===401?"E_AUTH":"E_INTERNAL");
  reportSessionIssue(response.status,code,url);
  throw new ApiError(code,response.status,response.headers.get("X-Request-Id")??undefined,reply?.error?.message??"上传失败");
 }
 return reply.data as T;
}
// The per-user upload queue owns the single durable operation key. A separate
// localStorage key derived only from the file would cross user/session
// boundaries and can accidentally attach an unrelated operation. Never cache
// a second identifier here; re-attaching is gated by the queue fingerprint.
export async function uploadResumable(folder:string,file:File,operationKey:string,handlers:{
 onProgress?:(progress:ResumableProgress)=>void;signal?:AbortSignal;
}):Promise<ResumableUploadResult>{
 if(file.size<1||file.size>resumableMaxFile)throw new ApiError("E_BAD",400,undefined,"文件大小不支持分块上传");
 if(operationKey.length<8||operationKey.length>128)throw new ApiError("E_BAD",400,undefined,"无效的上传操作标识");
 const signal=handlers.signal;
 const key=operationKey;
 let session:UploadSession|undefined;
 const path=(id:string)=>"/uploads/resumable/"+encodeURIComponent(id);
 try{
  session=await requestUpload<UploadSession>("/uploads/resumable","POST",JSON.stringify({
   folderId:folder,name:file.name,contentType:file.type||"application/octet-stream",
   size:file.size,idempotencyKey:key,sha256:"",
  }),{"Content-Type":"application/json"},signal);
  if(session.state==="cancelled")throw new ApiError("E_VERSION_CONFLICT",409);
  if(session.size!==file.size)throw new ApiError("E_VERSION_CONFLICT",409);
  if(!Number.isSafeInteger(session.received)||session.received<0||session.received>file.size){
   throw new ApiError("E_VERSION_CONFLICT",409,undefined,"服务端上传偏移量不合法");
  }
  // A previous /complete may have committed while its response was lost.
  // Return the server's persisted result, never create a new upload.
  if(session.state==="committed"&&session.result)return session.result;
  if(session.state!=="open"&&session.state!=="committed")throw new ApiError("E_VERSION_CONFLICT",409);
  let offset=session.received;
  handlers.onProgress?.({loaded:offset,total:file.size});
  while(offset<file.size){
   if(signal?.aborted)throw new ApiError("E_CANCELLED",0);
   const end=Math.min(file.size,offset+chunkSize);
   const part=await file.slice(offset,end).arrayBuffer();
   const digest=await sha256Chunk(part);
   let transmitted=false;
   for(let attempt=0;attempt<3&&!transmitted;attempt++){
    try{
     const after=await requestUpload<UploadSession>(path(session.id),"PATCH",part,{
      "Content-Type":"application/octet-stream","X-Chunk-Offset":String(offset),"X-Chunk-Sha256":digest,
     },signal);
     if(after.received!==end)throw new ApiError("E_VERSION_CONFLICT",409);
     offset=end;transmitted=true;
    }catch(err){
     if(signal?.aborted)throw err;
     if(!(err instanceof ApiError)||(err.code!=="E_NETWORK"&&err.code!=="E_VERSION_CONFLICT"))throw err;
     // A dropped response may mean the server safely accepted the chunk.
     // Reconcile with its durable offset before deciding to retransmit.
     const checked=await requestUpload<UploadSession>(path(session.id),"GET",undefined,{},signal);
     if(checked.received===end){offset=end;transmitted=true;break;}
     if(checked.received!==offset)throw new ApiError("E_VERSION_CONFLICT",409);
     if(attempt===2)throw err;
     await new Promise(resolve=>setTimeout(resolve,200*(attempt+1)));
    }
   }
   handlers.onProgress?.({loaded:offset,total:file.size});
  }
  const result=await requestUpload<ResumableUploadResult>(path(session.id)+"/complete","POST",undefined,{},signal)
   .catch(async err=>{
    if(signal?.aborted||!(err instanceof ApiError)||err.code!=="E_NETWORK")throw err;
    // Unknown commit response: consult the durable server session before any
    // replay. A committed response already contains the authoritative result.
    const current=await requestUpload<UploadSession>(path(session!.id),"GET",undefined,{},signal);
    if(current.state==="committed"&&current.result)return current.result;
    if(current.state==="open"&&current.received===file.size){
     return requestUpload<ResumableUploadResult>(path(session!.id)+"/complete","POST",undefined,{},signal);
    }
    throw err;
   });
  return result;
 }catch(err){
  if(signal?.aborted){
   // Identity changes stop local I/O, but must retain the previous user's
   // durable server offset for a later explicit recovery with the same file.
   if(signal.reason!=="identity.changed"){
    if(session)void requestUpload(path(session.id),"DELETE",undefined,{}).catch(()=>undefined);
   }
   throw new ApiError("E_CANCELLED",0);
  }
  throw err;
 }
}
