import {request} from "../../shared/http";
export type LifecycleNotice={id:number;fileId:string;fileName:string;kind:"soon"|"overdue";dueAt:string;createdAt:string;read:boolean};
export const lifecycleNotificationApi={
 notifications:()=>request<LifecycleNotice[]>("/lifecycle/notifications"),
 read:(id:number)=>request<{read:number}>("/lifecycle/notifications/"+id+"/read",{method:"POST"}),
};
