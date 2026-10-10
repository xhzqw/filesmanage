import {request} from "../../shared/http";
import type {TrashEntry} from "../../entities/trash/model";

export type TrashFilters={
 search:string;kind:string;deletedBy:string;sort:string;from:string;offset:number;limit:number;
};
export type TrashPage={items:TrashEntry[];hasMore:boolean};

export const trashApi={
 list:()=>request<TrashEntry[]>("/trash"),
 page:(filters:TrashFilters)=>{
  const params=new URLSearchParams();
  params.set("limit",String(filters.limit));
  params.set("offset",String(filters.offset));
  if(filters.search)params.set("search",filters.search);
  if(filters.kind!=="all")params.set("kind",filters.kind);
  if(filters.deletedBy)params.set("deletedBy",filters.deletedBy);
  if(filters.from)params.set("from",filters.from);
  if(filters.sort!=="recent")params.set("sort",filters.sort);
  return request<TrashPage>("/trash?"+params.toString());
 },
 restore:(id:string,destinationFolderId:string,newName:string)=>{
  const body:{destinationFolderId:string;newName:string}={destinationFolderId,newName};
  return request<TrashEntry>("/trash/"+id+"/restore",{method:"POST",body:JSON.stringify(body)});
 },
 // Permanent delete is admin-only server-side; the UI gates the entry point and
 // confirms twice before calling it (COMPLEX-WORKFLOWS §8.4).
 purge:(id:string)=>request<{purged:string}>("/trash/"+id,{method:"DELETE"}),
};
