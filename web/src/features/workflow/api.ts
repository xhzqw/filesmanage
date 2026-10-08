import {request} from "../../shared/http";

export type Approval={
 id:string;
 fileId:string;
 fileName:string;
 requesterId:string;
 requesterName:string;
 approverId:string;
 approverName:string;
 baseSeq:number;
 action:"edit"|"rollback";
 state:"pending"|"approved"|"rejected"|"cancelled"|"conflicted";
 reason:string;
 decisionComment:string;
 payloadSha256:string;
 payloadSize:number;
 createdAt:string;
 decidedAt?:string;
 rollbackTargetSeq?:number;
};

// Approval workflow endpoints: inbox, decisions and folder policies.
export const workflowApi={
 approvals:(scope:"inbox"|"mine")=>request<Approval[]>("/approvals?scope="+scope),
 approve:(id:string,comment:string)=>request<{fileId:string;versionSeq:number;status:string}>("/approvals/"+id+"/approve",{method:"POST",body:JSON.stringify({comment})}),
 reject:(id:string,comment:string)=>request<{rejected:string}>("/approvals/"+id+"/reject",{method:"POST",body:JSON.stringify({comment})}),
 cancel:(id:string)=>request<{cancelled:string}>("/approvals/"+id+"/cancel",{method:"POST"}),
 policy:(folderId:string)=>request<{configured:boolean;approverId?:string;enabled?:boolean}>("/folders/"+folderId+"/approval-policy"),
 setPolicy:(folderId:string,approverId:string,enabled:boolean)=>request<{configured:boolean;approverId:string;enabled:boolean}>("/folders/"+folderId+"/approval-policy",{method:"PUT",body:JSON.stringify({approverId,enabled})}),
 clearPolicy:(folderId:string)=>request<{configured:boolean}>("/folders/"+folderId+"/approval-policy",{method:"DELETE"}),
};
