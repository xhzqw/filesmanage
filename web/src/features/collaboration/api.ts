import {request} from "../../shared/http";
import type {FileItem} from "../../entities/file/model";
import type {Folder} from "../../entities/folder/model";
import type {User} from "../../entities/user/model";

export type Share={
 id:string;
 resourceKind:"file"|"folder";
 resourceId:string;
 resourceName:string;
 recipientKind:"user"|"group";
 recipientId:string;
 recipientName:string;
 actions:string[];
 includeDescendants:boolean;
 expiresAt?:string;
 revoked:boolean;
 createdAt:string;
};

export type Favorite={
 id:string;
 kind:"file"|"folder";
 fileId?:string;
 folderId?:string;
 resourceName:string;
 unavailable:boolean;
 createdAt:string;
};

export type Stats={
 totalFiles:number;
 totalFolders:number;
 totalBytes:number;
 added30Days:number;
 byType:{type:string;count:number}[];
 byMonth:{month:string;count:number}[];
 byUploader:{uploaderId:string;uploaderName:string;count:number}[];
};

export type SearchPage={items:FileItem[];total:number};

export type Workgroup={id:string;name:string;departmentId:string|null};

export type FilePage={items:FileItem[];nextCursor:string};

export const collaborationApi={
 shares:(scope:"received"|"sent")=>request<Share[]>("/shares?scope="+scope),
 createShare:(body:{resourceKind:string;resourceId:string;recipientKind:string;recipientId:string;actions:string[];includeDescendants:boolean;expiresAt?:string})=>
  request<Share>("/shares",{method:"POST",body:JSON.stringify(body)}),
 revokeShare:(id:string)=>request<{revoked:string}>("/shares/"+id,{method:"DELETE"}),
 favorites:()=>request<Favorite[]>("/favorites"),
 setFavorite:(kind:string,id:string,on:boolean)=>request<{id:string;favorited:boolean}>("/favorites/"+kind+"/"+id,{method:on?"PUT":"DELETE"}),
 // Recipient and resource sources for the share wizard and the resource picker.
 // /users and /groups are admin-only on the server: a denied read is surfaced by
 // the dialog, never hidden as "no recipients exist".
 users:()=>request<User[]>("/users"),
 groups:()=>request<Workgroup[]>("/groups"),
 folderTree:()=>request<Folder[]>("/folders/tree"),
 folderFiles:(folderId:string)=>request<FilePage>("/files?"+new URLSearchParams({folder:folderId,sort:"updated_desc",limit:"50"}).toString()),
 search:(params:{folder?:string;scope?:string;q?:string;uploader?:string;type?:string;from?:string;to?:string;sort?:string;limit?:number})=>{
  const query=new URLSearchParams();
  for(const [key,value] of Object.entries(params)){
   if(value!==undefined&&value!=="")query.set(key,String(value));
  }
  return request<SearchPage>("/search?"+query.toString());
 },
 stats:(params:{folder?:string;scope?:string;uploader?:string;type?:string;from?:string;to?:string})=>{
  const query=new URLSearchParams();
  for(const [key,value] of Object.entries(params)){
   if(value!==undefined&&value!=="")query.set(key,String(value));
  }
  return request<Stats>("/stats?"+query.toString());
 },
 exportUrl:(params:{folder?:string;scope?:string;uploader?:string;type?:string;from?:string;to?:string})=>{
  const query=new URLSearchParams();
  for(const [key,value] of Object.entries(params)){
   if(value!==undefined&&value!=="")query.set(key,String(value));
  }
  return "/api/exports/files.csv?"+query.toString();
 },
};

export function formatBytes(bytes:number):string{
 if(bytes<1024)return bytes+" B";
 if(bytes<1024*1024)return (bytes/1024).toFixed(1)+" KB";
 if(bytes<1024*1024*1024)return (bytes/1024/1024).toFixed(2)+" GB";
 return (bytes/1024/1024/1024).toFixed(2)+" TB";
}
