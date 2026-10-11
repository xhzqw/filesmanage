import {request} from "../../shared/http";
export type LifecycleLedgerRow={fileId:string;fileName:string;folderId:string;state:"released"|"archived";publishedSeq:number;responsibleName:string;dueAt?:string;retentionUntil?:string;dueStatus:"none"|"soon"|"overdue"|"scheduled"};
export type LifecycleLedgerPage={items:LifecycleLedgerRow[];nextCursor:string};
export type LifecycleNotice={id:number;fileId:string;fileName:string;kind:"soon"|"overdue";dueAt:string;createdAt:string;read:boolean};
export type LifecyclePolicy={dueDays:number;retentionDays:number};
export type LifecyclePolicyView=LifecyclePolicy&{sourceKind:string;sourceId:string;canManage:boolean};
export type LifecycleStats={released:number;archived:number;dueSoon:number;overdue:number;retained:number};
export type BulkDueResult={fileId:string;status:"updated"|"unavailable"|"version_conflict"|"conflict"|"invalid"};
export type LifecycleScope={id:string;name:string};
export const lifecycleWorkspaceApi={
 ledger:(cursor="",state="")=>request<LifecycleLedgerPage>("/lifecycle/ledger?"+new URLSearchParams({cursor,state,limit:"30"})),
 notifications:()=>request<LifecycleNotice[]>("/lifecycle/notifications"),
 read:(id:number)=>request<{read:number}>("/lifecycle/notifications/"+id+"/read",{method:"POST"}),
 policy:(kind:"folder"|"department",id:string)=>request<LifecyclePolicyView>("/lifecycle/policy/"+kind+"/"+encodeURIComponent(id)),
 savePolicy:(kind:"folder"|"department",id:string,policy:LifecyclePolicy)=>request<{saved:boolean}>("/lifecycle/policy/"+kind+"/"+encodeURIComponent(id),{method:"PUT",body:JSON.stringify(policy)}),
 clearPolicy:(kind:"folder"|"department",id:string)=>request<{cleared:boolean}>("/lifecycle/policy/"+kind+"/"+encodeURIComponent(id),{method:"DELETE"}),
 statistics:()=>request<LifecycleStats>("/lifecycle/statistics"),
 bulkDue:(items:{fileId:string;expectedVersionSeq:number}[],dueAt:string|null)=>request<BulkDueResult[]>("/lifecycle/bulk-due",{method:"POST",body:JSON.stringify({items,dueAt})}),
 folders:()=>request<LifecycleScope[]>("/folders/tree"),
 departments:()=>request<LifecycleScope[]>("/departments"),
};
