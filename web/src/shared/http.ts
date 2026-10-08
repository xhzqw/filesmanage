type Reply<T>={ok:boolean;data?:T;error?:{code:string;message?:string}};
export async function request<T>(url:string,options?:RequestInit):Promise<T>{
 const res=await fetch("/api"+url,{credentials:"same-origin",...options,headers:{"Content-Type":"application/json",...options?.headers}});
 const reply=await res.json() as Reply<T>;
 if(!res.ok||!reply.ok||reply.data===undefined)throw new Error(reply.error?.message||reply.error?.code||"请求失败");
 return reply.data;
}
