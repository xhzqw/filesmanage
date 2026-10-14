import {request} from "../../shared/http";
import type {User} from "../../entities/user/model";

export type Department={id:string;name:string;parentId:string|null};
export type Workgroup={id:string;name:string;departmentId:string|null};
// POST /departments 与 POST /groups 目前只返回 {id,name}（internal/httpx/organization.go 的
// createDepartment/createWorkgroup），响应里没有 parentId/departmentId，所以调用方必须
// 在成功后重读列表，不能把这个响应当作完整的 Department/Workgroup。
export type Created={id:string;name:string};

type Page<T>={items:T[];nextCursor:string};
// Keyset paging rather than a single truncated 1000-row response. A page must
// strictly advance its cursor; never silently display a partial org directory.
async function allPages<T>(resource:"/users"|"/groups"):Promise<T[]>{
 const result:T[]=[];
 let cursor="";
 const seen=new Set<string>();
 for(;;){
  const suffix="?limit=200"+(cursor?"&cursor="+encodeURIComponent(cursor):"");
  const page=await request<Page<T>>(resource+suffix);
  if(!Array.isArray(page.items)||typeof page.nextCursor!=="string"){
   throw Error("组织列表分页响应格式不正确");
  }
  result.push(...page.items);
  if(!page.nextCursor)return result;
  if(seen.has(page.nextCursor)||page.nextCursor===cursor||result.length>100000){
   throw Error("组织列表分页游标未前进");
  }
  seen.add(page.nextCursor);
  cursor=page.nextCursor;
 }
}

export const organizationApi={
 users:()=>allPages<User>("/users"),
 createUser:(login:string,displayName:string,password:string,departmentId:string)=>request<User>("/users",{method:"POST",body:JSON.stringify({login,displayName,password,departmentId})}),
 resetPassword:(id:string,password:string)=>request<{reset:string}>("/users/"+id+"/password",{method:"POST",body:JSON.stringify({password})}),
 setDisabled:(id:string,disabled:boolean)=>request<{id:string;disabled:boolean}>("/users/"+id+"/"+(disabled?"disable":"enable"),{method:"POST"}),
 departments:()=>request<Department[]>("/departments"),
 createDepartment:(name:string,parentId:string)=>request<Created>("/departments",{method:"POST",body:JSON.stringify({name,parentId})}),
 groups:()=>allPages<Workgroup>("/groups").then(groups=>
  groups.sort((a,b)=>a.name.localeCompare(b.name,"zh-CN")||a.id.localeCompare(b.id))),
 createGroup:(name:string,departmentId:string)=>request<Created>("/groups",{method:"POST",body:JSON.stringify({name,departmentId})}),
 deleteGroup:(id:string)=>request<{id:string;deleted:boolean}>("/groups/"+encodeURIComponent(id),{method:"DELETE"}),
 members:(groupId:string)=>request<User[]>("/groups/"+groupId+"/members"),
 addMember:(groupId:string,userId:string)=>request<{groupId:string;userId:string}>("/groups/"+groupId+"/members",{method:"POST",body:JSON.stringify({userId})}),
 removeMember:(groupId:string,userId:string)=>request<{removed:boolean}>("/groups/"+groupId+"/members/"+userId,{method:"DELETE"}),
};
