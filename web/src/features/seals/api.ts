import {ApiError,request,reportSessionResponse} from "../../shared/http";
import type {SealAsset,FileSealMark,SealPlacement,SealUserPermission} from "../../entities/seal/model";

export const sealsApi={
 myPermission:()=>request<SealUserPermission>("/seal-permissions/me"),
 permissions:()=>request<SealUserPermission[]>("/seal-permissions"),
 updatePermission:(userId:string,canSign:boolean,canStamp:boolean)=>request<SealUserPermission>("/seal-permissions/"+encodeURIComponent(userId),{method:"PUT",body:JSON.stringify({canSign,canStamp})}),

 list:()=>request<SealAsset[]>("/seals"),
 importBundle:async(file:File):Promise<{created:number;existing:number;total:number}>=>{
  if(file.size<40||file.size>6*1024*1024||(!file.name.toLowerCase().endsWith(".zip")))throw new Error("请选择 6 MB 以内的签章 ZIP 导入包");
  const res=await fetch("/api/seals/bulk",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/zip"},body:file});
  await reportSessionResponse(res,"/seals/bulk");
  let reply:{ok:boolean;data?:{created:number;existing:number;total:number};error?:{code:string;message:string}}|undefined;
  try{reply=await res.json()}catch{}
  if(!res.ok||!reply?.ok||!reply.data)throw new ApiError(reply?.error?.code||"E_IMPORT",res.status,undefined,reply?.error?.message||"批量导入失败");
  return reply.data;
 },

 imageUrl:(id:string)=>"/api/seals/"+encodeURIComponent(id)+"/image",
 create:(data:{kind:"personal"|"company";name:string;ownerId:string;pngBase64:string})=>request<SealAsset>("/seals",{method:"POST",body:JSON.stringify(data)}),
 configure:(id:string,action:"bind"|"grant"|"revoke"|"retire"|"rename",userId="")=>request<{updated:string}>("/seals/"+encodeURIComponent(id)+"/manage",{method:"POST",body:JSON.stringify({action,userId})}),
 used:(fileId:string)=>request<string[]>("/files/"+encodeURIComponent(fileId)+"/seals/used"),
 marks:(fileId:string,version:number)=>request<FileSealMark[]>("/files/"+encodeURIComponent(fileId)+"/seals?version="+version),
 history:(fileId:string,version:number)=>request<{current:number;revisions:{revision:number;markCount:number;action:string;actorName?:string;createdAt?:string;restoredFrom?:number}[]}>("/files/"+encodeURIComponent(fileId)+"/seals/revisions?version="+version),
 restore:(fileId:string,data:{versionSeq:number;fileSha256:string;expectedRevision:number;targetRevision:number;password:string})=>request<{revision:number;markCount:number}>("/files/"+encodeURIComponent(fileId)+"/seals/restore",{method:"POST",body:JSON.stringify(data)}),

 markImageUrl:(fileId:string,markId:string)=>"/api/files/"+encodeURIComponent(fileId)+"/seals/"+encodeURIComponent(markId)+"/image",
 exportUrl:(fileId:string,version:number)=>"/api/files/"+encodeURIComponent(fileId)+"/seals/export?version="+version,
 apply:(fileId:string,placement:SealPlacement)=>request<FileSealMark>("/files/"+encodeURIComponent(fileId)+"/seals",{method:"POST",body:JSON.stringify(placement)}),
 applyBatch:(fileId:string,data:{versionSeq:number;fileSha256:string;password:string;placements:Omit<SealPlacement,"password"|"versionSeq"|"fileSha256">[]})=>request<FileSealMark[]>("/files/"+encodeURIComponent(fileId)+"/seals/batch",{method:"POST",body:JSON.stringify(data)}),
};
