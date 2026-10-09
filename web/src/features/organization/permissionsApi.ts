import {request} from "../../shared/http";

export type ResourceFolder = {id:string;name:string;parentId:string|null;hasChildren:boolean;path?:string};
export type FolderPage = {items:ResourceFolder[];nextCursor:string};
export type DirectGrant = {
 id:string; subjectKind:"user"|"group";subjectId:string;actions:string[];
 scopeOnly:boolean;expiresAt?:string;grantedByName:string;
};

export const permissionsApi={
 children:(parentId:string,cursor="")=>request<FolderPage>(
  "/folders/children?"+new URLSearchParams({parentId,cursor,limit:"50"}).toString()),
 search:(q:string,cursor="")=>request<FolderPage>(
  "/folders/search?"+new URLSearchParams({q,cursor,limit:"50"}).toString()),
 grants:(id:string)=>request<DirectGrant[]>("/folders/"+encodeURIComponent(id)+"/acls"),
 create:(id:string,data:{subjectKind:"user"|"group";subjectId:string;actions:string[];scopeOnly:boolean;expiresAt?:string})=>
  request<DirectGrant>("/folders/"+encodeURIComponent(id)+"/acls",{method:"POST",body:JSON.stringify(data)}),
 revoke:(id:string)=>request<{revoked:string}>("/acls/"+encodeURIComponent(id),{method:"DELETE"}),
};
