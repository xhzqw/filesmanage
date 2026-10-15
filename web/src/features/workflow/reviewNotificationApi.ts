import {request} from "../../shared/http";

export type ReviewNotice={id:number;reviewId:number;fileId:string;fileName:string;kind:string;createdAt:string;read:boolean};
export const reviewNotificationApi={
 list:()=>request<{items:ReviewNotice[];unreadCount:number}>("/review-notifications"),
 read:(id:number)=>request<{id:number}>("/review-notifications/"+id+"/read",{method:"POST"})
};
