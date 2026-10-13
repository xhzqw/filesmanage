import {request} from "../../shared/http";
import {publishResourceChange} from "../../shared/resourceSync";
import type {Folder} from "../../entities/folder/model";
import type {FolderPickerPage} from "../../shared/ui/FolderPicker";

export type Grant={id:string;subjectKind:"user"|"group";subjectId:string;actions:string[];scopeOnly:boolean;grantedByName:string;expiresAt?:string};

function folderChanged<T>(promise:Promise<T>,deleted=false):Promise<T>{
 return promise.then(data=>{
  publishResourceChange({scope:"folder"});
  if(deleted){publishResourceChange({scope:"trash"});publishResourceChange({scope:"file"});}
  return data;
 });
}

export const folderApi={
 tree:()=>request<Folder[]>("/folders/tree"),
 children:(parentId:string,cursor="")=>request<FolderPickerPage>(
  "/folders/children?"+new URLSearchParams({parentId,cursor,limit:"50"}).toString()),
 search:(q:string,cursor="")=>request<FolderPickerPage>(
  "/folders/search?"+new URLSearchParams({q,cursor,limit:"50"}).toString()),
 get:(id:string)=>request<Folder>("/folders/"+encodeURIComponent(id)),
 create:(parentId:string,name:string)=>folderChanged(request<Folder>("/folders",{method:"POST",body:JSON.stringify({parentId,name})})),
 rename:(id:string,name:string)=>folderChanged(request<Folder>("/folders/"+id,{method:"PATCH",body:JSON.stringify({name})})),
 move:(id:string,targetParentId:string)=>folderChanged(request<Folder>("/folders/"+id+"/move",{method:"POST",body:JSON.stringify({targetParentId})})),
 remove:(id:string)=>folderChanged(request<{trashId:string;folders:number}>("/folders/"+id,{method:"DELETE"}),true),
 grants:(id:string)=>request<Grant[]>("/folders/"+id+"/acls"),
 createGrant:(id:string,subjectKind:string,subjectId:string,actions:string[],scopeOnly:boolean,expiresAt?:string)=>
  request<Grant>("/folders/"+id+"/acls",{method:"POST",body:JSON.stringify({subjectKind,subjectId,actions,scopeOnly,...(expiresAt?{expiresAt}:{})})}),
 revokeGrant:(grantId:string)=>request<{revoked:string}>("/acls/"+grantId,{method:"DELETE"}),
};
