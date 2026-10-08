import {request} from "../../shared/http";
import type {Folder} from "../../entities/folder/model";

export type Grant={id:string;subjectKind:"user"|"group";subjectId:string;actions:string[];scopeOnly:boolean;grantedByName:string};

export const folderApi={
 tree:()=>request<Folder[]>("/folders/tree"),
 create:(parentId:string,name:string)=>request<Folder>("/folders",{method:"POST",body:JSON.stringify({parentId,name})}),
 rename:(id:string,name:string)=>request<Folder>("/folders/"+id,{method:"PATCH",body:JSON.stringify({name})}),
 move:(id:string,targetParentId:string)=>request<Folder>("/folders/"+id+"/move",{method:"POST",body:JSON.stringify({targetParentId})}),
 remove:(id:string)=>request<{trashId:string;folders:number}>("/folders/"+id,{method:"DELETE"}),
 grants:(id:string)=>request<Grant[]>("/folders/"+id+"/acls"),
 createGrant:(id:string,subjectKind:string,subjectId:string,actions:string[],scopeOnly:boolean)=>
  request<Grant>("/folders/"+id+"/acls",{method:"POST",body:JSON.stringify({subjectKind,subjectId,actions,scopeOnly})}),
 revokeGrant:(grantId:string)=>request<{revoked:string}>("/acls/"+grantId,{method:"DELETE"}),
};
