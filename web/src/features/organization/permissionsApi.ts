import {request} from "../../shared/http";

export type ResourceFolder = {id:string;name:string;parentId:string|null;hasChildren:boolean;path?:string};
export type FolderPage = {items:ResourceFolder[];nextCursor:string};
export type DirectGrant = {
 id:string; subjectKind:"user"|"group";subjectId:string;actions:string[];
 scopeOnly:boolean;expiresAt?:string;grantedByName:string;
};

export type PermissionSource={
 kind:"direct_acl"|"inherited_acl"|"workgroup_acl"|"folder_share"|"admin_override";
 resourceId:string;grantId?:string;subjectKind?:string;subjectId?:string;
 actions:string[];scopeOnly:boolean;depth:number;expiresAt?:string;
};
export type PermissionExplanation={
 subjectKind:"user";subjectId:string;folderId:string;subjectDisabled:boolean;
 effectiveActions:string[];sources:PermissionSource[];evaluatedAt:string;
};
export type PermissionAuditRow={
 id:number;actorId:string;eventType:string;targetKind:string;targetId:string;
 outcome:string;details:Record<string,unknown>;createdAt:string;
};
export type PermissionAuditPage={items:PermissionAuditRow[];nextCursor:string};

export const permissionsApi={
 children:(parentId:string,cursor="")=>request<FolderPage>(
  "/folders/children?"+new URLSearchParams({parentId,cursor,limit:"50"}).toString()),
 search:(q:string,cursor="")=>request<FolderPage>(
  "/folders/search?"+new URLSearchParams({q,cursor,limit:"50"}).toString()),
 grants:(id:string)=>request<DirectGrant[]>("/folders/"+encodeURIComponent(id)+"/acls"),
 create:(id:string,data:{subjectKind:"user"|"group";subjectId:string;actions:string[];scopeOnly:boolean;expiresAt?:string})=>
  request<DirectGrant>("/folders/"+encodeURIComponent(id)+"/acls",{method:"POST",body:JSON.stringify(data)}),
 revoke:(id:string)=>request<{revoked:string}>("/acls/"+encodeURIComponent(id),{method:"DELETE"}),
 explain:(subjectId:string,folderId:string)=>request<PermissionExplanation>("/permissions/explain",{
  method:"POST",body:JSON.stringify({subjectKind:"user",subjectId,folderId}),
 }),
 audit:(cursor="")=>request<PermissionAuditPage>(
  "/permissions/audit?"+new URLSearchParams({limit:"30",cursor}).toString()),
};
