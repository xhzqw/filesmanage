import {request} from "../../shared/http";
export type ApprovalEvent={id:number;approvalId:string;actorId:string;actorName:string;kind:"submitted"|"advanced"|"approved"|"rejected"|"cancelled"|"conflicted";stepIndex:number;comment:string;createdAt:string};
export type ApprovalNotification={id:number;approvalId:string;fileName:string;kind:ApprovalEvent["kind"];stepIndex:number;createdAt:string;read:boolean};
export const approvalActivityApi={
 history:(id:string)=>request<ApprovalEvent[]>("/approvals/"+encodeURIComponent(id)+"/history"),
 notifications:()=>request<ApprovalNotification[]>("/approvals/notifications"),
 read:(id:number)=>request<{read:number}>("/approvals/notifications/"+id+"/read",{method:"POST"}),
};
