import {request} from "../../shared/http";
export type LifecycleLedgerRow={fileId:string;fileName:string;folderId:string;state:"released"|"archived";publishedSeq:number;dueAt?:string;retentionUntil?:string;dueStatus:"none"|"soon"|"overdue"|"scheduled"};
export type LifecycleLedgerPage={items:LifecycleLedgerRow[];nextCursor:string};
export type LifecycleNotice={id:number;fileId:string;fileName:string;kind:"soon"|"overdue";dueAt:string;createdAt:string;read:boolean};
export const lifecycleWorkspaceApi={
 ledger:(cursor="",state="")=>request<LifecycleLedgerPage>("/lifecycle/ledger?"+new URLSearchParams({cursor,state,limit:"30"})),
 notifications:()=>request<LifecycleNotice[]>("/lifecycle/notifications"),
 read:(id:number)=>request<{read:number}>("/lifecycle/notifications/"+id+"/read",{method:"POST"}),
};
