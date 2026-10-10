import {request} from "../../shared/http";
export type FolderApprovalPolicy={configured:boolean;approverId?:string;enabled?:boolean};
export const approvalPolicyApi={
 get:(folderId:string)=>request<FolderApprovalPolicy>("/folders/"+encodeURIComponent(folderId)+"/approval-policy"),
 set:(folderId:string,approverId:string,enabled:boolean)=>request<FolderApprovalPolicy>("/folders/"+encodeURIComponent(folderId)+"/approval-policy",{method:"PUT",body:JSON.stringify({approverId,enabled})}),
 clear:(folderId:string)=>request<FolderApprovalPolicy>("/folders/"+encodeURIComponent(folderId)+"/approval-policy",{method:"DELETE"}),
};
