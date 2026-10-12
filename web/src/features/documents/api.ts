import {request} from "../../shared/http";
import {postMultipart} from "../../shared/uploadClient";
import {publishResourceChange} from "../../shared/resourceSync";
import type {FileItem, FileVersion, PreviewData, FileMetadata} from "../../entities/file/model";

export type CompareDiffLine={kind:"equal"|"added"|"removed";left?:number;right?:number;text:string};
export type OfficeSemanticChange={kind:"added"|"removed"|"changed";section:string;key:string;before:string;after:string};
export type VersionComparison={left:{seq:number;sha256:string;sizeBytes:number};right:{seq:number;sha256:string;sizeBytes:number};mode:"identical"|"metadata"|"large"|"text";detail?:"office_parts"|"office_semantic";semanticChanges?:OfficeSemanticChange[];lines:CompareDiffLine[];added:number;removed:number};
export type FileReviewComment={id:number;fileId:string;versionSeq:number;lineNumber?:number;body:string;authorId:string;authorName:string;createdAt:string;resolvedAt?:string;resolvedBy?:string};
export type ReviewCommentPage={items:FileReviewComment[];nextCursor:string};
export type FilePage={items:FileItem[];nextCursor:string};
export type FileLifecycle={fileId:string;state:"draft"|"released"|"archived";publishedSeq:number;publishedAt:string;publishedBy:string;responsibleId?:string;dueAt?:string;retentionUntil?:string;dueStatus:"none"|"soon"|"overdue"|"scheduled";note:string;updatedAt:string;canManage:boolean};
export type LifecycleDraft={action:"publish"|"archive"|"unarchive"|"set_due"|"assign";expectedVersionSeq:number;dueAt:string|null;note:string;retentionDays?:number;responsibleId?:string};

export type OfficeSessionData={
 sessionId:string;
 documentKey:string;
 baseSeq:number;
 editorUrl:string;
 config:{token:string};
};

function changed<T>(promise:Promise<T>,fileId:string,addsTrash=false):Promise<T>{
 return promise.then(data=>{
  publishResourceChange({scope:"file",id:fileId});
  if(addsTrash)publishResourceChange({scope:"trash"});
  return data;
 });
}

// Lock, save, rollback and editor sessions are file endpoints and therefore
// live with the documents feature; approval inbox endpoints live in workflow.
export const fileApi={
 list:(folder:string,sort:string,cursor:string,limit:number,signal?:AbortSignal)=>{
  const query=new URLSearchParams({folder,sort,limit:String(limit)});
  if(cursor)query.set("cursor",cursor);
  return request<FilePage>("/files?"+query.toString(),{signal});
 },
 meta:(id:string,signal?:AbortSignal)=>request<{file:FileItem;versions:FileVersion[]}>("/files/"+id,{signal}),
 lifecycle:(id:string)=>request<FileLifecycle>("/files/"+id+"/lifecycle"),
 setLifecycle:(id:string,draft:LifecycleDraft)=>changed(request<FileLifecycle>("/files/"+id+"/lifecycle",{method:"PUT",body:JSON.stringify(draft)}),id),
 metadata:(id:string)=>request<FileMetadata>("/files/"+id+"/metadata"),
 setMetadata:(id:string,body:{category:string;description:string;tags:string[]})=>changed(request<FileMetadata>("/files/"+id+"/metadata",{method:"PUT",body:JSON.stringify(body)}),id),
	preview:(id:string,signal?:AbortSignal)=>request<PreviewData>("/files/"+id+"/preview",{signal}),
 pdfPages:(id:string,sha:string)=>request<{pageCount:number}>("/files/"+encodeURIComponent(id)+"/preview/pdf/pages?sha256="+encodeURIComponent(sha)),
 pdfPageUrl:(id:string,sha:string,page:number)=>"/api/files/"+encodeURIComponent(id)+"/preview/pdf/page?"+new URLSearchParams({sha256:sha,page:String(page)}),
 convertDOCXForSigning:(id:string,expectedSeq:number,expectedSha256:string,idempotencyKey:string)=>request<{fileId:string;versionSeq:number;sha256:string;name:string}>("/files/"+encodeURIComponent(id)+"/convert-for-signing",{method:"POST",body:JSON.stringify({expectedSeq,expectedSha256,idempotencyKey})}),

  preparePrint:(id:string,expectedSha256:string)=>request<{fileId:string;name:string;versionSeq:number;sha256:string}>(
   "/files/"+encodeURIComponent(id)+"/print/prepare",{method:"POST",body:JSON.stringify({expectedSha256})}),
  printMediaUrl:(id:string,sha:string)=>"/api/files/"+encodeURIComponent(id)+"/print/media?sha256="+encodeURIComponent(sha),
  printOfficeUrl:(id:string,sha:string,sheet="")=>"/api/files/"+encodeURIComponent(id)+"/print/office-pdf?"+new URLSearchParams({
   sha256:sha,...(sheet?{sheet}:{})
  }).toString(),
  printSheets:(id:string,sha:string)=>request<{name:string}[]>("/files/"+encodeURIComponent(id)+"/print/sheets?sha256="+encodeURIComponent(sha)),
	mediaUrl:(id:string,sha:string)=>"/api/files/"+encodeURIComponent(id)+"/preview/media?v="+encodeURIComponent(sha),
 versions:(id:string)=>request<FileVersion[]>("/files/"+id+"/versions"),
 compareVersions:(id:string,left:number,right:number)=>request<VersionComparison>("/files/"+id+"/versions/compare?"+new URLSearchParams({left:String(left),right:String(right)})),
 reviewComments:(id:string,version:number,cursor="")=>request<ReviewCommentPage>("/files/"+id+"/review-comments?"+new URLSearchParams({version:String(version),limit:"30",cursor})),
 addReviewComment:(id:string,body:{version:number;body:string;lineNumber?:number})=>request<FileReviewComment>("/files/"+id+"/review-comments",{method:"POST",body:JSON.stringify(body)}),
 resolveReviewComment:(id:string,commentId:number)=>request<{resolved:number}>("/files/"+id+"/review-comments/"+commentId+"/resolve",{method:"POST"}),
 rename:(id:string,name:string)=>changed(request<FileItem>("/files/"+id,{method:"PATCH",body:JSON.stringify({name})}),id),
 remove:(id:string)=>changed(request<{id:string;oldName:string}>("/files/"+id,{method:"DELETE"}),id,true),
 lockStatus:(id:string)=>request<{locked:boolean;ownerName?:string;baseSeq?:number;expiresAt?:string}>("/files/"+id+"/lock"),
 acquireLock:(id:string,baseSeq:number)=>request<{lockToken:string;generation:number;expiresInSeconds:number}>("/files/"+id+"/lock",{method:"POST",body:JSON.stringify({baseSeq})}),
 releaseLock:(id:string,lockToken:string)=>request<{released:string}>("/files/"+id+"/lock",{method:"DELETE",body:JSON.stringify({lockToken})}),
 save:(id:string,baseSeq:number,lockToken:string,data:string,idempotencyKey:string)=>
  changed(request<{fileId:string;versionSeq:number;sha256:string;size:number;status:string}>("/files/"+id+"/save",
   {method:"POST",body:JSON.stringify({baseSeq,lockToken,data,idempotencyKey})}),id),
 submitForApproval:(id:string,baseSeq:number,data:string)=>
  request<{status:string;approvalId:string;expectedCurrentSeq:number}>("/files/"+id+"/save",
   {method:"POST",body:JSON.stringify({baseSeq,data})}),
 // Rollback appends a new immutable version (SPEC §9.5): targetSeq selects the
 // source version, expectedCurrentSeq is the CAS basis, and the edit lock plus
 // idempotency key keep concurrent rollbacks from double-applying. A 202 reply
 // carries status "pending" (approval-routed) and must not read as committed.
 rollback:(id:string,targetSeq:number,expectedCurrentSeq:number,lockToken:string,reason:string,idempotencyKey:string)=>
  changed(request<{status:string;versionSeq?:number;approvalId?:string;rollbackTargetSeq?:number}>("/files/"+id+"/rollback",
   {method:"POST",body:JSON.stringify({targetSeq,expectedCurrentSeq,lockToken,reason,idempotencyKey})}),id),
 // Move is a CAS write (COMPLEX-WORKFLOWS-v1 §3.2 B): expectedFolderId pins the
 // folder the user saw, and the idempotency key replays the recorded result
 // instead of applying a second move when a retry follows an unclear outcome.
 move:(id:string,targetFolderId:string,expectedFolderId:string,idempotencyKey:string)=>
  changed(request<{fileId:string;fromFolderId:string;toFolderId:string;status:string}>("/files/"+id+"/move",
   {method:"POST",body:JSON.stringify({targetFolderId,expectedFolderId,idempotencyKey})}),id),
 // Batch move (WF-07/WF-08, ADR-UX-02): one all-or-nothing transaction, so
 // there is no per-file CAS basis; fileIds is the whole working set. A 200
 // answer discriminates its own outcome — status "conflict" carries the
 // failing items and means nothing was written. The idempotency key makes a
 // retry replay the recorded result instead of moving a second time.
 moveBatch:(fileIds:string[],targetFolderId:string,idempotencyKey:string)=>
  request<{status:string;moved:{fileId:string;fromFolderId:string;toFolderId:string}[];conflicts:{id:string;code:string;message?:string}[];count:number}>("/files/move-batch",
   {method:"POST",body:JSON.stringify({fileIds,targetFolderId,mode:"all_or_nothing",idempotencyKey})}).then(data=>{
    if(data.status==="committed")for(const moved of data.moved)publishResourceChange({scope:"file",id:moved.fileId});
    return data;
   }),
 openOfficeSession:(id:string)=>request<OfficeSessionData>("/files/"+id+"/office/session",{method:"POST",body:"{}"}),
 officeNativeSaveStatus:(id:string,sessionId:string)=>request<{versionSeq:number;savedCount:number;failedCount:number}>(
  "/files/"+encodeURIComponent(id)+"/office/session/"+encodeURIComponent(sessionId)+"/state"),
 requestOfficeSave:(id:string,sessionId:string)=>request<{status:"pending"|"unchanged";requestId?:string}>(
  "/files/"+encodeURIComponent(id)+"/office/session/"+encodeURIComponent(sessionId)+"/save",{method:"POST",body:"{}"}),
 officeSaveStatus:(id:string,sessionId:string,requestId:string)=>request<{status:"pending"|"committed"|"failed";versionSeq:number}>(
  "/files/"+encodeURIComponent(id)+"/office/session/"+encodeURIComponent(sessionId)+"/save/"+encodeURIComponent(requestId)),
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
