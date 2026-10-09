import {request} from "../../shared/http";
import type {TrashEntry} from "../../entities/trash/model";

export const trashApi={
 list:()=>request<TrashEntry[]>("/trash"),
 restore:(id:string,destinationFolderId:string,newName:string)=>{
  const body:{destinationFolderId:string;newName:string}={destinationFolderId,newName};
  return request<TrashEntry>("/trash/"+id+"/restore",{method:"POST",body:JSON.stringify(body)});
 },
 // Permanent delete is admin-only server-side; the UI gates the entry point and
 // confirms twice before calling it (COMPLEX-WORKFLOWS §8.4).
 purge:(id:string)=>request<{purged:string}>("/trash/"+id,{method:"DELETE"}),
};
