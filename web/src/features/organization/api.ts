import {request} from "../../shared/http";
import type {User} from "../../entities/user/model";

export type Department={id:string;name:string;parentId:string|null};
export type Workgroup={id:string;name:string;departmentId:string|null};

export const organizationApi={
 users:()=>request<User[]>("/users"),
 createUser:(login:string,displayName:string,password:string,departmentId:string)=>request<User>("/users",{method:"POST",body:JSON.stringify({login,displayName,password,departmentId})}),
 resetPassword:(id:string,password:string)=>request<{reset:string}>("/users/"+id+"/password",{method:"POST",body:JSON.stringify({password})}),
 setDisabled:(id:string,disabled:boolean)=>request<{id:string;disabled:boolean}>("/users/"+id+"/"+(disabled?"disable":"enable"),{method:"POST"}),
 departments:()=>request<Department[]>("/departments"),
 createDepartment:(name:string)=>request<Department>("/departments",{method:"POST",body:JSON.stringify({name})}),
 groups:()=>request<Workgroup[]>("/groups"),
 createGroup:(name:string)=>request<Workgroup>("/groups",{method:"POST",body:JSON.stringify({name})}),
 members:(groupId:string)=>request<User[]>("/groups/"+groupId+"/members"),
 addMember:(groupId:string,userId:string)=>request<{groupId:string;userId:string}>("/groups/"+groupId+"/members",{method:"POST",body:JSON.stringify({userId})}),
 removeMember:(groupId:string,userId:string)=>request<{removed:boolean}>("/groups/"+groupId+"/members/"+userId,{method:"DELETE"}),
};
