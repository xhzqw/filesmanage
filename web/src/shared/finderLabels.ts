import {request} from "./http";
import {publishResourceChange} from "./resourceSync";
// Keep the transport DTO in shared; shared cannot import the entities layer.
export type TaggedFile={id:string;folderId:string;name:string;uploadedBy:string;contentType:string;sizeBytes:number;sha256:string;currentVersionSeq:number;updatedAt:string};
export type TaggedFolder={id:string;name:string;parentId:string|null;updatedAt?:string};

export const FINDER_COLORS=[
 {id:"red",name:"红色",hex:"var(--ui-tag-red)"},
 {id:"orange",name:"橙色",hex:"var(--ui-tag-orange)"},
 {id:"yellow",name:"黄色",hex:"var(--ui-tag-yellow)"},
 {id:"green",name:"绿色",hex:"var(--ui-tag-green)"},
 {id:"blue",name:"蓝色",hex:"var(--ui-tag-blue)"},
 {id:"purple",name:"紫色",hex:"var(--ui-tag-purple)"},
 {id:"gray",name:"灰色",hex:"var(--ui-tag-gray)"},
] as const;
export type FinderColor=typeof FINDER_COLORS[number]["id"];
export type FinderLabel={id:string;name:string;color:FinderColor;sortOrder:number;isDefault:boolean};
export const finderColor=(color:string)=>FINDER_COLORS.find(entry=>entry.id===color)?.hex??"var(--ui-tag-gray)";
function changedLabels(){window.dispatchEvent(new Event("filesmanage:labels-change"));}
export const labelApi={
 list:()=>request<FinderLabel[]>("/labels"),
 create:(name:string,color:FinderColor)=>request<FinderLabel>("/labels",{method:"POST",body:JSON.stringify({name,color})}).then(value=>{changedLabels();return value;}),
 update:(id:string,name:string,color:FinderColor)=>request<FinderLabel>("/labels/"+encodeURIComponent(id),{method:"PATCH",body:JSON.stringify({name,color})}).then(value=>{changedLabels();return value;}),
 remove:(id:string)=>request<{deleted:boolean}>("/labels/"+encodeURIComponent(id),{method:"DELETE"}).then(value=>{changedLabels();return value;}),
 files:(id:string)=>request<{items:TaggedFile[]}>("/labels/"+encodeURIComponent(id)+"/files"),
 resources:(id:string)=>request<{items:TaggedFile[];folders:TaggedFolder[]}>("/labels/"+encodeURIComponent(id)+"/resources"),
 folderLabels:(id:string)=>request<string[]>("/folders/"+encodeURIComponent(id)+"/labels"),
 folderAssignments:(folderIds:string[])=>request<Record<string,string[]>>("/labels/folder-assignments",{method:"POST",body:JSON.stringify({folderIds})}),
 setResources:(id:string,fileIds:string[],folderIds:string[],add:boolean)=>request<{updated:number}>("/labels/"+encodeURIComponent(id)+"/resources",{method:"PUT",body:JSON.stringify({fileIds,folderIds,add})}).then(data=>{
  for(const fileId of fileIds)publishResourceChange({scope:"file",id:fileId});
  for(const folderId of folderIds)publishResourceChange({scope:"folder",id:folderId});
  changedLabels();
  return data;
 }),
 assignments:(fileIds:string[])=>request<Record<string,string[]>>("/labels/assignments",{method:"POST",body:JSON.stringify({fileIds})}),
 setFiles:(id:string,fileIds:string[],add:boolean)=>request<{updated:number}>("/labels/"+encodeURIComponent(id)+"/files",{method:"PUT",body:JSON.stringify({fileIds,add})}).then(data=>{
  for(const fileId of fileIds)publishResourceChange({scope:"file",id:fileId});
  changedLabels();
  return data;
 }),
};
