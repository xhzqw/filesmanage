// Unified API error contract: stable server code, HTTP status and optional retry window.
export type SessionIssue="expired";
let issueListener:((issue:SessionIssue)=>void)|null=null;
// Transport remains independent of React and Zustand.
export function subscribeSessionIssues(listener:(issue:SessionIssue)=>void):()=>void{
 issueListener=listener;
 return ()=>{if(issueListener===listener)issueListener=null};
}
// Shared by JSON, multipart/XHR and binary endpoints.
export function reportSessionIssue(status:number,code:string,url:string):void{
 if(status===401&&code==="E_AUTH"&&url!=="/login"&&url!=="/logout"&&url!=="/me"){
  issueListener?.("expired");
 }
}
export async function reportSessionResponse(res:Response,url:string):Promise<void>{
 if(res.ok)return;
 let body:Reply<unknown>|undefined;
 try{body=await res.clone().json() as Reply<unknown>;}catch{body=undefined;}
 reportSessionIssue(res.status,body?.error?.code||(res.status===401?"E_AUTH":""),url);
}

export class ApiError extends Error{
 readonly code:string;
 readonly httpStatus:number;
 readonly requestId?:string;
 readonly retryable:boolean;
 readonly retryAfterSeconds?:number;
 constructor(code:string,httpStatus:number,requestId?:string,message?:string,retryAfterSeconds?:number){
  super(message||code||"请求失败");
  this.name="ApiError";
  this.code=code;
  this.httpStatus=httpStatus;
  this.requestId=requestId;
  this.retryable=httpStatus===0||httpStatus===408||httpStatus===429||httpStatus>=500;
  this.retryAfterSeconds=retryAfterSeconds;
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
  // A network error does not prove whether the write committed.
  throw new ApiError("E_NETWORK",0,undefined,error instanceof Error?error.message:"网络请求失败");
 }
 let reply:Reply<T>|undefined;
 try{reply=await res.json() as Reply<T>;}catch{reply=undefined;}
 if(!res.ok||!reply||!reply.ok){
  const code=reply?.error?.code||(res.status===401?"E_AUTH":"E_INTERNAL");
  reportSessionIssue(res.status,code,url);
  const header=res.headers.get("Retry-After");
  const parsed=header===null?NaN:Number(header);
  const retryAfter=Number.isFinite(parsed)&&parsed>0?parsed:undefined;
  throw new ApiError(code,res.status,requestIdOf(res),reply?.error?.message||"请求失败",retryAfter);
 }
 return reply.data as T;
}
