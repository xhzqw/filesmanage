import {useMemo} from "react";
import type {User} from "../../entities/user/model";
import type {Department,Workgroup} from "./api";
import {fullPathOf} from "./organizationTreeUtils";

export type StatusFilter="all"|"normal"|"disabled"|"admin";
const CANDIDATE_CAP=50;

function matchesQuery(user:User,needle:string):boolean{
 return user.displayName.toLowerCase().includes(needle)||(user.login??"").toLowerCase().includes(needle);
}
function departmentLabelOf(byId:Map<string,Department>,id:string|undefined):string{
 const key=id??"";
 if(key==="")return "未分配部门";
 return byId.get(key)?.name??`未知部门（${key}）`;
}

/** Indexed selectors shared by the organization tree and both task lists.
 * Recompute only when data or the relevant scope/search inputs change. */
export function useOrganizationSelectors({users,departments,groups,groupMembers,
 selectedDepartment,memberQuery,statusFilter,groupQuery,candidateQuery}:{
 users:User[];departments:Department[];groups:Workgroup[];groupMembers:User[];
 selectedDepartment:string;memberQuery:string;statusFilter:StatusFilter;
 groupQuery:string;candidateQuery:string;
}){
 const deptById=useMemo(()=>new Map(departments.map(d=>[d.id,d])),[departments]);
 const deptIndex=useMemo(()=>{
  const ids=new Set(departments.map(d=>d.id));
  const childrenOf=new Map<string,Department[]>();
  for(const d of departments){
   const key=d.parentId!==null&&ids.has(d.parentId)?d.parentId:"";
   const list=childrenOf.get(key);
   if(list)list.push(d);else childrenOf.set(key,[d]);
  }
  return childrenOf;
 },[departments]);

 const departmentLabel=(id:string|undefined):string=>departmentLabelOf(deptById,id);
 const departmentOptions=useMemo(
  ()=>departments.map(d=>({id:d.id,label:fullPathOf(deptById,d.id)})),
  [departments,deptById]);

 const selectedDeptIds=useMemo(()=>{
  if(selectedDepartment===""||selectedDepartment==="__unassigned")return null;
  const out=new Set<string>();
  const walk=(id:string)=>{
   if(out.has(id))return;
   out.add(id);
   for(const child of deptIndex.get(id)??[])walk(child.id);
  };
  walk(selectedDepartment);
  return out;
 },[selectedDepartment,deptIndex]);

 const unassignedCount=useMemo(
  ()=>users.filter(u=>!u.departmentId||!deptById.has(u.departmentId)).length,
  [users,deptById]);

 const deptCounts=useMemo(()=>{
  const direct=new Map<string,number>();
  for(const user of users){
   const key=user.departmentId??"";
   if(key!=="")direct.set(key,(direct.get(key)??0)+1);
  }
  const totals=new Map<string,number>();
  const visiting=new Set<string>();
  const sum=(id:string):number=>{
   if(visiting.has(id))return 0;
   const cached=totals.get(id);
   if(cached!==undefined)return cached;
   visiting.add(id);
   let total=direct.get(id)??0;
   for(const child of deptIndex.get(id)??[])total+=sum(child.id);
   visiting.delete(id);
   totals.set(id,total);
   return total;
  };
  for(const d of departments)sum(d.id);
  return totals;
 },[users,departments,deptIndex]);

 const activeDeptIds=selectedDepartment!==""&&selectedDepartment!=="__unassigned"?selectedDeptIds:null;
 const needle=memberQuery.trim().toLowerCase();

 const filteredMembers=useMemo(()=>{
  return users.filter(user=>{
   if(selectedDepartment==="__unassigned"){
    const dId=user.departmentId??"";
    if(dId!==""&&deptById.has(dId))return false;
   }else if(activeDeptIds&&!activeDeptIds.has(user.departmentId??"")){
    return false;
   }
   if(statusFilter==="normal"&&user.disabled===true)return false;
   if(statusFilter==="disabled"&&user.disabled!==true)return false;
   if(statusFilter==="admin"&&!user.isAdmin)return false;
   if(needle==="")return true;
   return matchesQuery(user,needle);
  });
 },[users,activeDeptIds,selectedDepartment,deptById,statusFilter,needle]);

 const filteredGroups=useMemo(()=>{
  const keyword=groupQuery.trim().toLowerCase();
  return groups.filter(group=>{
   if(selectedDepartment==="__unassigned"){
    if(group.departmentId&&deptById.has(group.departmentId))return false;
   }else if(selectedDeptIds&&!selectedDeptIds.has(group.departmentId??""))return false;
   return keyword===""||group.name.toLowerCase().includes(keyword);
  });
 },[groups,groupQuery,selectedDepartment,selectedDeptIds,deptById]);

 const candidates=useMemo(()=>{
  const keyword=candidateQuery.trim().toLowerCase();
  const current=new Set(groupMembers.map(m=>m.id));
  return users
   .filter(user=>user.disabled!==true&&!current.has(user.id)&&(keyword===""||matchesQuery(user,keyword)))
   .slice(0,CANDIDATE_CAP);
 },[users,groupMembers,candidateQuery]);

 return {deptById,deptIndex,departmentLabel,departmentOptions,selectedDeptIds,
  unassignedCount,deptCounts,needle,filteredMembers,filteredGroups,candidates};
}
