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
 status?:"active"|"trashed"|"inaccessible";
 trashEntryId?:string;
 capabilities?:{open:boolean;share:boolean;unfavorite:boolean};
 createdAt:string;
};

export type Stats={
 totalFiles:number;
 totalFolders:number;
 totalBytes:number;
 added30Days:number;
 byType:{type:string;count:number;bytes:number}[];
 byMonth:{month:string;count:number;bytes:number}[];
 byUploader:{uploaderId:string;uploaderName:string;count:number;bytes:number}[];
 byFolder:FolderCount[];
 folderTree?:FolderCount[];
 treeTruncated?:boolean;
};
export type FileCategory="pdf"|"document"|"sheet"|"slide"|"image"|"video"|"audio"|"cad"|"archive"|"other";
export type FileCategoryCount={category:FileCategory;count:number;bytes:number};
export type FolderCount={folderId:string;folderName:string;parentId?:string|null;count:number;bytes:number;types?:FileCategoryCount[]};

export type SearchPage={items:FileItem[];total:number;nextCursor:string};

export type Workgroup={id:string;name:string;departmentId:string|null};

export type FilePage={items:FileItem[];nextCursor:string};
export type CollaborationPage<T>={items:T[];nextCursor:string};

export const collaborationApi={
 shares:(scope:"received"|"sent")=>request<Share[]>("/shares?scope="+scope),
 sharesPage:(scope:"received"|"sent",cursor="")=>request<CollaborationPage<Share>>("/shares?"+new URLSearchParams({scope,limit:"50",...(cursor?{cursor}:{})}).toString()),
 createShare:(body:{resourceKind:string;resourceId:string;recipientKind:string;recipientId:string;actions:string[];includeDescendants:boolean;expiresAt?:string})=>
  request<Share>("/shares",{method:"POST",body:JSON.stringify(body)}),
 revokeShare:(id:string)=>request<{revoked:string}>("/shares/"+id,{method:"DELETE"}),
 favorites:()=>request<Favorite[]>("/favorites"),
 favoritesPage:(cursor="")=>request<CollaborationPage<Favorite>>("/favorites?"+new URLSearchParams({limit:"50",...(cursor?{cursor}:{})}).toString()),
 // During a rolling deployment the previous server returns the legacy array.
 // After the backend restart the same route returns the authorized sidebar page.
 favoritesSidebar:()=>request<{items:Favorite[]}|Favorite[]>("/favorites?view=sidebar").then(page=>{
  if(Array.isArray(page))return {items:page.filter(item=>!item.unavailable).slice(0,8)};
  // An API/worker version mismatch must not turn a sidebar refresh into a
  // full-page React render crash (undefined.slice in FinderSidebar).
  if(!page||!Array.isArray(page.items))throw new Error("关注列表返回格式无效");
  return {items:page.items};
 }),
 setFavorite:(kind:string,id:string,on:boolean)=>request<{id:string;favorited:boolean}>("/favorites/"+kind+"/"+id,{method:on?"PUT":"DELETE"}),
 // Recipient and resource sources for the share wizard and the resource picker.
 // /users and /groups are admin-only on the server: a denied read is surfaced by
 // the dialog, never hidden as "no recipients exist".
 users:()=>request<User[]>("/users"),
 groups:()=>request<Workgroup[]>("/groups"),
 folderTree:()=>request<Folder[]>("/folders/tree"),
 folderFiles:(folderId:string,cursor="")=>request<FilePage>("/files?"+new URLSearchParams({folder:folderId,sort:"updated_desc",limit:"50",...(cursor?{cursor}:{})}).toString()),
 // The opaque cursor is passed back verbatim; a missing or empty cursor asks for
 // the first page and nextCursor==="" means the server's last page (WF-30).
 search:(params:{folder?:string;scope?:string;q?:string;category?:string;tag?:string;uploader?:string;type?:string;from?:string;to?:string;sort?:string;limit?:number;cursor?:string},signal?:AbortSignal)=>{
  const query=new URLSearchParams();
  for(const [key,value] of Object.entries(params)){
   if(value!==undefined&&value!=="")query.set(key,String(value));
  }
  return request<SearchPage>("/search?"+query.toString(),{signal});
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
 if(bytes<1024*1024*1024)return (bytes/1024/1024).toFixed(1)+" MB";
 if(bytes<1024*1024*1024*1024)return (bytes/1024/1024/1024).toFixed(2)+" GB";
 return (bytes/1024/1024/1024/1024).toFixed(2)+" TB";
}
