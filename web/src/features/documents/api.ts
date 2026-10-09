import {request} from "../../shared/http";
import {postMultipart} from "../../shared/uploadClient";
import type {FileItem, FileVersion, PreviewData} from "../../entities/file/model";

export type FilePage={items:FileItem[];nextCursor:string};

export type OfficeSessionData={
 sessionId:string;
 documentKey:string;
 baseSeq:number;
 editorUrl:string;
 config:{token:string};
};

// Lock, save, rollback and editor sessions are file endpoints and therefore
// live with the documents feature; approval inbox endpoints live in workflow.
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
 lockStatus:(id:string)=>request<{locked:boolean;ownerName?:string;baseSeq?:number;expiresAt?:string}>("/files/"+id+"/lock"),
 acquireLock:(id:string,baseSeq:number)=>request<{lockToken:string;generation:number;expiresInSeconds:number}>("/files/"+id+"/lock",{method:"POST",body:JSON.stringify({baseSeq})}),
 releaseLock:(id:string,lockToken:string)=>request<{released:string}>("/files/"+id+"/lock",{method:"DELETE",body:JSON.stringify({lockToken})}),
 save:(id:string,baseSeq:number,lockToken:string,data:string,idempotencyKey:string)=>
  request<{fileId:string;versionSeq:number;sha256:string;size:number;status:string}>("/files/"+id+"/save",
   {method:"POST",body:JSON.stringify({baseSeq,lockToken,data,idempotencyKey})}),
 submitForApproval:(id:string,baseSeq:number,data:string)=>
  request<{status:string;approvalId:string;expectedCurrentSeq:number}>("/files/"+id+"/save",
   {method:"POST",body:JSON.stringify({baseSeq,data})}),
 // Rollback appends a new immutable version (SPEC §9.5): targetSeq selects the
 // source version, expectedCurrentSeq is the CAS basis, and the edit lock plus
 // idempotency key keep concurrent rollbacks from double-applying. A 202 reply
 // carries status "pending" (approval-routed) and must not read as committed.
 rollback:(id:string,targetSeq:number,expectedCurrentSeq:number,lockToken:string,reason:string,idempotencyKey:string)=>
  request<{status:string;versionSeq?:number;approvalId?:string;rollbackTargetSeq?:number}>("/files/"+id+"/rollback",
   {method:"POST",body:JSON.stringify({targetSeq,expectedCurrentSeq,lockToken,reason,idempotencyKey})}),
 openOfficeSession:(id:string)=>request<OfficeSessionData>("/files/"+id+"/office/session",{method:"POST",body:"{}"}),
 derivativeStatus:(id:string)=>request<{found:boolean;state:string;format:string;class:string;engine:string;note:string;outputKind?:string;outputSize?:number;outputSha256?:string;errorCode?:string}>("/files/"+id+"/derivative"),
 requestDerivative:(id:string)=>request<{derivativeId:string;state:string;sourceFormat:string;outputKind:string;converter:string}>("/files/"+id+"/derivative",{method:"POST",body:"{}"}),
 cancelOfficeSession:(fileId:string,sessionId:string)=>request<{cancelled:string}>("/files/"+fileId+"/office/session/"+sessionId+"/cancel",{method:"POST",body:"{}"}),
};

type UploadReply={
 ok:boolean;
 data?:{fileId:string;versionSeq:number;sha256:string;size:number;name:string;deduplicated:boolean};
 error?:{code:string;message?:string};
};

// upload bypasses the JSON helper: the body is multipart, but the response is
// still the standard envelope and failures still surface as ApiError with the
// server `code` preserved.
export async function uploadFile(folder:string,file:File,idempotencyKey:string,signal?:AbortSignal):Promise<NonNullable<UploadReply["data"]>>{
 const body=new FormData();
 body.set("folderId",folder);
 body.set("file",file);
 body.set("idempotencyKey",idempotencyKey);
 return postMultipart<NonNullable<UploadReply["data"]>>("/files",body,{signal,fallbackMessage:"上传失败"});
}

export function formatSize(bytes:number):string{
 if(bytes<1024)return bytes+" B";
 if(bytes<1024*1024)return (bytes/1024).toFixed(1)+" KB";
 return (bytes/1024/1024).toFixed(1)+" MB";
}
