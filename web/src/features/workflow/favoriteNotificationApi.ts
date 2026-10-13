import {request} from "../../shared/http";

export type FavoriteChangeNotice={
 id:number;
 affectedCount:number;
 read:boolean;
 createdAt:string;
};

export const favoriteNotificationApi={
 list:()=>request<{items:FavoriteChangeNotice[];unreadCount:number}>("/favorites/notifications"),
 read:(id:number)=>request<{read:number}>("/favorites/notifications/"+id+"/read",{method:"POST"}),
};
