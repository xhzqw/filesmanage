import {ApiError,reportSessionIssue} from "./http";

type UploadReply={ok:boolean;data?:unknown;error?:{code:string;message?:string}};

// Multipart uploads bypass the JSON helper but keep the same envelope, session,
// cancellation and error-code contract (UX contracts COMPLEX-WORKFLOWS-v1
// §4.1): failures always throw an ApiError carrying the server `code`.
export async function postMultipart<T>(url:string,body:FormData,options?:{signal?:AbortSignal;fallbackMessage?:string}):Promise<T>{
 let res:Response;
 try{
  res=await fetch("/api"+url,{method:"POST",credentials:"same-origin",body,signal:options?.signal});
 }catch(error){
  if(options?.signal?.aborted)throw new ApiError("E_CANCELLED",0,undefined,"已取消");
  throw new ApiError("E_NETWORK",0,undefined,error instanceof Error?error.message:options?.fallbackMessage||"网络请求失败");
 }
 let reply:UploadReply|undefined;
 try{reply=await res.json() as UploadReply;}catch{reply=undefined;}
 if(!res.ok||!reply||!reply.ok){
  throw envelopeError(res.status,res.headers.get("X-Request-Id")||undefined,reply,options?.fallbackMessage);
 }
 return reply.data as T;
}

// One error shape for both transports (§4.1): the fetch multipart helper and
// the XHR uploader must not drift into two code/status/message mappings.
function envelopeError(status:number,requestId:string|undefined,reply:UploadReply|undefined,fallbackMessage?:string):ApiError{
 const code=reply?.error?.code||(status===401?"E_AUTH":"E_INTERNAL");
 reportSessionIssue(status,code,"/files");
 return new ApiError(code,status,requestId,reply?.error?.message||fallbackMessage||"请求失败");
}

function parseEnvelope(text:string):UploadReply|undefined{
 try{return JSON.parse(text) as UploadReply;}catch{return undefined;}
}

export type UploadProgress={loaded:number;total:number};

export type UploadedFile={fileId:string;versionSeq:number;sha256:string;size:number;name:string;deduplicated:boolean};

// XHR transport for byte-level sending progress. fetch cannot report request
// progress, and COMPLEX-WORKFLOWS-v1 §5.1 requires distinguishing "the browser
// sent bytes" from "the server committed": onProgress never claims success,
// while the promise resolves only on the committed 2xx envelope. Same endpoint,
// body, session and error shaping as postMultipart.
export function uploadFileWithProgress(folderId:string,file:File,idempotencyKey:string,handlers:{onProgress?:(progress:UploadProgress)=>void;signal?:AbortSignal}):Promise<UploadedFile>{
 const body=new FormData();
 body.set("folderId",folderId);
 body.set("file",file);
 body.set("idempotencyKey",idempotencyKey);
 return new Promise<UploadedFile>((resolve,reject)=>{
  if(handlers.signal?.aborted){reject(new ApiError("E_CANCELLED",0,undefined,"已取消"));return;}
  const xhr=new XMLHttpRequest();
  xhr.open("POST","/api/files");
  xhr.withCredentials=true;
  xhr.responseType="text";
  const onAbort=()=>xhr.abort();
  handlers.signal?.addEventListener("abort",onAbort);
  const detach=()=>handlers.signal?.removeEventListener("abort",onAbort);
  xhr.upload.onprogress=event=>{
   if(!handlers.onProgress)return;
   const total=event.lengthComputable&&event.total>0?event.total:file.size;
   handlers.onProgress({loaded:event.loaded,total});
  };
  // The body is fully on the wire. Some browsers skip the terminal onprogress
  // event, so emit one final "all bytes sent" edge; callers must still wait for
  // the resolved envelope before claiming success.
  xhr.upload.onload=()=>handlers.onProgress?.({loaded:file.size,total:file.size});
  xhr.onload=()=>{
   detach();
   const reply=parseEnvelope(xhr.responseText);
   if(xhr.status<200||xhr.status>=300||!reply||!reply.ok){
    reject(envelopeError(xhr.status,xhr.getResponseHeader("X-Request-Id")||undefined,reply,"上传失败"));
    return;
   }
   resolve(reply.data as UploadedFile);
  };
  xhr.onerror=()=>{
   detach();
   reject(new ApiError("E_NETWORK",0,undefined,"网络请求失败"));
  };
  xhr.onabort=()=>{
   detach();
   reject(new ApiError("E_CANCELLED",0,undefined,"已取消"));
  };
  xhr.send(body);
 });
}
