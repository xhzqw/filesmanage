import {request} from "./http";
import {publishResourceChange} from "./resourceSync";
import type {FileItem} from "../entities/file/model";

export const FINDER_COLORS=[
 {id:"red",name:"红色",hex:"#ff5a58"},
 {id:"orange",name:"橙色",hex:"#ffb900"},
 {id:"yellow",name:"黄色",hex:"#f6e300"},
 {id:"green",name:"绿色",hex:"#00d96b"},
 {id:"blue",name:"蓝色",hex:"#0aa5f8"},
 {id:"purple",name:"紫色",hex:"#db60e9"},
 {id:"gray",name:"灰色",hex:"#aeb1bb"},
] as const;
export type FinderColor=typeof FINDER_COLORS[number]["id"];
export type FinderLabel={id:string;name:string;color:FinderColor;sortOrder:number;isDefault:boolean};
export const finderColor=(color:string)=>FINDER_COLORS.find(entry=>entry.id===color)?.hex??"#aeb1bb";
function changedLabels(){window.dispatchEvent(new Event("filesmanage:labels-change"));}
export const labelApi={
 list:()=>request<FinderLabel[]>("/labels"),
 create:(name:string,color:FinderColor)=>request<FinderLabel>("/labels",{method:"POST",body:JSON.stringify({name,color})}).then(value=>{changedLabels();return value;}),
 update:(id:string,name:string,color:FinderColor)=>request<FinderLabel>("/labels/"+encodeURIComponent(id),{method:"PATCH",body:JSON.stringify({name,color})}).then(value=>{changedLabels();return value;}),
 remove:(id:string)=>request<{deleted:boolean}>("/labels/"+encodeURIComponent(id),{method:"DELETE"}).then(value=>{changedLabels();return value;}),
 files:(id:string)=>request<{items:FileItem[]}>("/labels/"+encodeURIComponent(id)+"/files"),
 assignments:(fileIds:string[])=>request<Record<string,string[]>>("/labels/assignments",{method:"POST",body:JSON.stringify({fileIds})}),
 setFiles:(id:string,fileIds:string[],add:boolean)=>request<{updated:number}>("/labels/"+encodeURIComponent(id)+"/files",{method:"PUT",body:JSON.stringify({fileIds,add})}).then(data=>{
  for(const fileId of fileIds)publishResourceChange({scope:"file",id:fileId});
  changedLabels();
  return data;
 }),
};
