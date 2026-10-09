import {ApiError} from "./http";

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
  const code=reply?.error?.code||(res.status===401?"E_AUTH":"E_INTERNAL");
  throw new ApiError(code,res.status,res.headers.get("X-Request-Id")||undefined,reply?.error?.message||options?.fallbackMessage||"请求失败");
 }
 return reply.data as T;
}
