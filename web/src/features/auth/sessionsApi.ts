import {request} from "../../shared/http";

export type DeviceSession={
 id:string;device:string;address:string;createdAt:string;lastSeenAt:string;
 expiresAt:string;current:boolean;
};
export type AuthActivity={
 type:string;device:string;address:string;count?:number;occurredAt:string;
};
export const sessionApi={
 list:()=>request<DeviceSession[]>("/me/sessions"),
 activity:()=>request<AuthActivity[]>("/me/auth-activity"),
 revoke:(id:string)=>request<{revoked:boolean}>("/me/sessions/"+encodeURIComponent(id),{method:"DELETE"}),
 revokeOthers:()=>request<{revoked:number}>("/me/sessions/others",{method:"DELETE"}),
};
