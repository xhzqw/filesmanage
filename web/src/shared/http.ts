// Unified API error contract (UX contracts COMPLEX-WORKFLOWS-v1 §4.1): every
// failure surfaces the stable server `code`, the HTTP status and the request id
// when the server provides one. Features branch on `code`; the message is
// never a transaction truth and a network failure never means the write was
// rolled back.
export class ApiError extends Error{
 readonly code:string;
 readonly httpStatus:number;
 readonly requestId?:string;
 readonly retryable:boolean;
 constructor(code:string,httpStatus:number,requestId?:string,message?:string){
  super(message||code||"请求失败");
  this.name="ApiError";
  this.code=code;
  this.httpStatus=httpStatus;
  this.requestId=requestId;
  this.retryable=httpStatus===0||httpStatus===408||httpStatus===429||httpStatus>=500;
 }
}

type Reply<T>={ok:boolean;data?:T;error?:{code:string;message?:string}};

function requestIdOf(res:Response):string|undefined{
 return res.headers.get("X-Request-Id")||undefined;
}

export async function request<T>(url:string,options?:RequestInit):Promise<T>{
 let res:Response;
 try{
  res=await fetch("/api"+url,{credentials:"same-origin",...options,headers:{"Content-Type":"application/json",...options?.headers}});
 }catch(error){
  // The request never completed: the server outcome is unknown, so callers
  // must verify state (idempotency key / re-read) instead of assuming failure.
  throw new ApiError("E_NETWORK",0,undefined,error instanceof Error?error.message:"网络请求失败");
 }
 let reply:Reply<T>|undefined;
 try{reply=await res.json() as Reply<T>;}catch{reply=undefined;}
 if(!res.ok||!reply||!reply.ok){
  const code=reply?.error?.code||(res.status===401?"E_AUTH":"E_INTERNAL");
  throw new ApiError(code,res.status,requestIdOf(res),reply?.error?.message||"请求失败");
 }
 return reply.data as T;
}
