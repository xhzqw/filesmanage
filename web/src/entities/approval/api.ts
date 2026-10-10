import {request} from "../../shared/http";
export type FolderApprovalPolicy={configured:boolean;approverId?:string;approverIds?:string[];enabled?:boolean};
export const approvalPolicyApi={
 get:(folderId:string)=>request<FolderApprovalPolicy>("/folders/"+encodeURIComponent(folderId)+"/approval-policy"),
 set:(folderId:string,approverIds:string[],enabled:boolean)=>request<FolderApprovalPolicy>("/folders/"+encodeURIComponent(folderId)+"/approval-policy",{method:"PUT",body:JSON.stringify({approverId:approverIds[0],approverIds,enabled})}),
 clear:(folderId:string)=>request<FolderApprovalPolicy>("/folders/"+encodeURIComponent(folderId)+"/approval-policy",{method:"DELETE"}),
};
