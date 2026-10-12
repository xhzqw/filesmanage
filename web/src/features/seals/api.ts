import {request} from "../../shared/http";
import type {SealAsset,FileSealMark,SealPlacement,SealUserPermission} from "../../entities/seal/model";

export const sealsApi={
 myPermission:()=>request<SealUserPermission>("/seal-permissions/me"),
 permissions:()=>request<SealUserPermission[]>("/seal-permissions"),
 updatePermission:(userId:string,canSign:boolean,canStamp:boolean)=>request<SealUserPermission>("/seal-permissions/"+encodeURIComponent(userId),{method:"PUT",body:JSON.stringify({canSign,canStamp})}),

 list:()=>request<SealAsset[]>("/seals"),
 imageUrl:(id:string)=>"/api/seals/"+encodeURIComponent(id)+"/image",
 create:(data:{kind:"personal"|"company";name:string;ownerId:string;pngBase64:string})=>request<SealAsset>("/seals",{method:"POST",body:JSON.stringify(data)}),
 configure:(id:string,action:"bind"|"grant"|"revoke"|"retire"|"rename",userId="")=>request<{updated:string}>("/seals/"+encodeURIComponent(id)+"/manage",{method:"POST",body:JSON.stringify({action,userId})}),
 used:(fileId:string)=>request<string[]>("/files/"+encodeURIComponent(fileId)+"/seals/used"),
 marks:(fileId:string,version:number)=>request<FileSealMark[]>("/files/"+encodeURIComponent(fileId)+"/seals?version="+version),
 markImageUrl:(fileId:string,markId:string)=>"/api/files/"+encodeURIComponent(fileId)+"/seals/"+encodeURIComponent(markId)+"/image",
 exportUrl:(fileId:string,version:number)=>"/api/files/"+encodeURIComponent(fileId)+"/seals/export?version="+version,
 apply:(fileId:string,placement:SealPlacement)=>request<FileSealMark>("/files/"+encodeURIComponent(fileId)+"/seals",{method:"POST",body:JSON.stringify(placement)}),
};
