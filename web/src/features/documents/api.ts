import {request} from "../../shared/http";
import type {FileItem, FileVersion, PreviewData} from "../../entities/file/model";

export type FilePage={items:FileItem[];nextCursor:string};

export const fileApi={
 list:(folder:string,sort:string,cursor:string,limit:number)=>{
  const query=new URLSearchParams({folder,sort,limit:String(limit)});
  if(cursor)query.set("cursor",cursor);
  return request<FilePage>("/files?"+query.toString());
 },
 meta:(id:string)=>request<{file:FileItem;versions:FileVersion[]}>("/files/"+id),
 preview:(id:string)=>request<PreviewData>("/files/"+id+"/preview"),
 versions:(id:string)=>request<FileVersion[]>("/files/"+id+"/versions"),
 rename:(id:string,name:string)=>request<FileItem>("/files/"+id,{method:"PATCH",body:JSON.stringify({name})}),
 remove:(id:string)=>request<{id:string;oldName:string}>("/files/"+id,{method:"DELETE"}),
};

type UploadReply={
 ok:boolean;
 data?:{fileId:string;versionSeq:number;sha256:string;size:number;name:string;deduplicated:boolean};
 error?:{code:string;message?:string};
};

// upload bypasses the JSON helper: the body is multipart and the response is
// still the standard envelope, so it is parsed the same way here.
export async function uploadFile(folder:string,file:File,idempotencyKey:string):Promise<NonNullable<UploadReply["data"]>>{
 const body=new FormData();
 body.set("folderId",folder);
 body.set("file",file);
 body.set("idempotencyKey",idempotencyKey);
 const res=await fetch("/api/files",{method:"POST",credentials:"same-origin",body});
 const reply=await res.json() as UploadReply;
 if(!res.ok||!reply.ok||!reply.data){
  const failure=new Error(reply.error?.message||reply.error?.code||"上传失败");
  if(reply.error)Object.assign(failure,{code:reply.error.code});
  throw failure;
 }
 return reply.data;
}

export function formatSize(bytes:number):string{
 if(bytes<1024)return bytes+" B";
 if(bytes<1024*1024)return (bytes/1024).toFixed(1)+" KB";
 return (bytes/1024/1024).toFixed(1)+" MB";
}
