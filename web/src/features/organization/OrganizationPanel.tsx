import {RareTabs} from "../../shared/ui/rare/RareTabs";
import {RareBadge,RareButton,RareInput,RareNotice,RareSelect} from "../../shared/ui/rare";
import {useEffect,useMemo,useRef,useState,type FormEvent,type KeyboardEvent,type ReactNode} from "react";
import {organizationApi,type Department,type Workgroup} from "./api";
import {errorCode,errorCopy} from "../../shared/errors";
import {Dialog} from "../../shared/ui/Dialog";
import type {User} from "../../entities/user/model";
import "./organization.css";
import {useSearchParams} from "react-router-dom";
import {PermissionsPanel} from "./PermissionsPanel";
import {RoleBindingsPanel,DelegatedRolesWorkspace} from "./RoleWorkspace";

type LoadState="loading"|"ready"|"failed";
type Tone="info"|"error";
type Notice={text:string;tone:Tone};
type DialogResult={ok:string}|{error:string};
type DeptRow={department:Department;depth:number};
type StatusFilter="all"|"normal"|"disabled"|"admin";

const MAX_DEPTH=32;
const CANDIDATE_CAP=50;
const DEPT_HIT_CAP=30;
const MEMBER_DISPLAY_STEP=100;
const GROUP_DISPLAY_STEP=60;

function loginOf(user:User):string{return user.login??"";}

function matchesQuery(user:User,needle:string):boolean{
 return user.displayName.toLowerCase().includes(needle)||loginOf(user).toLowerCase().includes(needle);
}

function ancestorPathOf(byId:Map<string,Department>,id:string):string{
 const names:string[]=[];
 const seen=new Set<string>();
 let current=byId.get(id)?.parentId??null;
 while(current!==null&&!seen.has(current)){
  seen.add(current);
  const parent=byId.get(current);
  if(!parent)break;
  names.unshift(parent.name);
  current=parent.parentId;
 }
 return names.join(" / ");
}

function fullPathOf(byId:Map<string,Department>,id:string):string{
 const name=byId.get(id)?.name??id;
 const ancestors=ancestorPathOf(byId,id);
 return ancestors===""?name:ancestors+" / "+name;
}

function departmentLabelOf(byId:Map<string,Department>,id:string|undefined):string{
 const key=id??"";
 if(key==="")return "未分配部门";
 return byId.get(key)?.name??`未知部门（${key}）`;
}

function mutationCopy(error:unknown,fallback:string):string{
 const code=errorCode(error);
 if(code==="E_NETWORK")return "网络中断，无法确认操作是否已提交；请以列表最新状态为准。";
 if(code==="E_PASSWORD_POLICY")return "密码必须为 16–128 个字符。";
 if(code==="E_FORBIDDEN")return "没有执行该操作的权限（服务端拒绝）。";
 if(code==="E_NOT_FOUND")return "服务端已找不到该记录（账号可能已删除或状态已变化），列表已重新读取。";
 if(code==="E_BAD")return "服务端拒绝了本次请求（参数无效或不允许该状态变更）。";
 if(code==="E_NAME_CONFLICT")return "名称已存在，请更换。";
 return errorCopy(error,fallback);
}

function IconBuilding(){
 return <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
  <path d="M2 14V3a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v11h4v1H1v-1h1zm2-10v2h2V4H4zm0 3v2h2V7H4zm0 3v2h2v-2H4zm4-6v2h2V4H8zm0 3v2h2V7H8zm0 3v2h2v-2H8z"/>
 </svg>;
}

function IconFolder(){
 return <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
  <path d="M1.5 2.5A1.5 1.5 0 0 0 0 4v8a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 16 12V6a1.5 1.5 0 0 0-1.5-1.5H8.414l-1.707-1.707A1 1 0 0 0 6 2.5H1.5z"/>
 </svg>;
}

function IconUsers(){
 return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <path d="M11 14v-1.5a2.5 2.5 0 0 0-2.5-2.5h-5A2.5 2.5 0 0 0 1 12.5V14"/>
  <circle cx="6" cy="5" r="3"/>
  <path d="M15 14v-1.2a2.3 2.3 0 0 0-1.8-2.2"/>
  <path d="M11 2.2a2.3 2.3 0 0 1 0 4.5"/>
 </svg>;
}

function IconGroup(){
 return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <rect x="2" y="3" width="12" height="10" rx="2"/>
  <path d="M6 8h4"/>
  <path d="M8 6v4"/>
 </svg>;
}

function IconSearch(){
 return <svg className="org-search-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <circle cx="7" cy="7" r="4.5"/>
  <path d="M10.5 10.5L14 14"/>
 </svg>;
}

function IconPlus(){
 return <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <path d="M8 2v12M2 8h12"/>
 </svg>;
}

function IconChevron({open}:{open:boolean}){
 return <svg className={"org-chevron-svg"+(open?" open":"")} width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <path d="M6 3l5 5-5 5"/>
 </svg>;
}

export function OrganizationPanel({isAdmin,currentUserId}:{isAdmin:boolean;currentUserId:string}){
 const[users,setUsers]=useState<User[]>([]);
 const[departments,setDepartments]=useState<Department[]>([]);
 const[groups,setGroups]=useState<Workgroup[]>([]);
 const[usersState,setUsersState]=useState<LoadState>("loading");
 const[departmentsState,setDepartmentsState]=useState<LoadState>("loading");
 const[groupsState,setGroupsState]=useState<LoadState>("loading");
 const[usersToken,setUsersToken]=useState(0);
 const[departmentsToken,setDepartmentsToken]=useState(0);
 const[groupsToken,setGroupsToken]=useState(0);
 const[notice,setNotice]=useState<Notice|null>(null);

 // 视图与筛选状态：默认 Tab 1 为部门成员，Tab 2 为工作组管理
 const[queryParams,setQueryParams]=useSearchParams();
 const activeTab=queryParams.get("tab")==="roles"?"roles":queryParams.get("tab")==="permissions"?"permissions":queryParams.get("tab")==="groups"?"groups":"members";
 const setActiveTab=(tab:"members"|"groups"|"permissions"|"roles")=>setQueryParams(old=>{
  const next=new URLSearchParams(old);
  next.set("tab",tab);
  if(tab!=="permissions"){next.delete("view");next.delete("folder");}
  return next;
 });
 const[selectedDepartment,setSelectedDepartment]=useState("");
 const[deptQuery,setDeptQuery]=useState("");
 const[expanded,setExpanded]=useState<Set<string>>(()=>new Set<string>());
 const[focusedId,setFocusedId]=useState<string|null>(null);
 const[memberQuery,setMemberQuery]=useState("");
 const[statusFilter,setStatusFilter]=useState<StatusFilter>("all");
 const[memberLimit,setMemberLimit]=useState(MEMBER_DISPLAY_STEP);

 // 工作组状态
 const[selectedGroup,setSelectedGroup]=useState("");
 const[groupQuery,setGroupQuery]=useState("");
 const[groupLimit,setGroupLimit]=useState(GROUP_DISPLAY_STEP);
 const[groupMembers,setGroupMembers]=useState<User[]>([]);
 const[groupMemberLimit,setGroupMemberLimit]=useState(MEMBER_DISPLAY_STEP);
 const[membersState,setMembersState]=useState<LoadState>("loading");
 const[membersToken,setMembersToken]=useState(0);
 const[candidateQuery,setCandidateQuery]=useState("");
 const[addBusy,setAddBusy]=useState("");

 // 对话框表单状态
 const[newUser,setNewUser]=useState({login:"",displayName:"",password:"",departmentId:""});
 const[resetTarget,setResetTarget]=useState<User|null>(null);
 const[stateTarget,setStateTarget]=useState<User|null>(null);
 const[removeTarget,setRemoveTarget]=useState<User|null>(null);
 const[createUserOpen,setCreateUserOpen]=useState(false);
 const[createDepartmentOpen,setCreateDepartmentOpen]=useState(false);
 const[createGroupOpen,setCreateGroupOpen]=useState(false);
 const rootsExpanded=useRef(false);

 useEffect(()=>{
  if(!isAdmin)return;
  let valid=true;
  setUsersState("loading");
  organizationApi.users()
   .then(data=>{if(valid){setUsers(data);setUsersState("ready");}})
   .catch(()=>{if(valid)setUsersState("failed");});
  return()=>{valid=false;};
 },[isAdmin,usersToken]);

 useEffect(()=>{
  if(!isAdmin)return;
  let valid=true;
  setDepartmentsState("loading");
  organizationApi.departments()
   .then(data=>{if(valid){setDepartments(data);setDepartmentsState("ready");}})
   .catch(()=>{if(valid)setDepartmentsState("failed");});
  return()=>{valid=false;};
 },[isAdmin,departmentsToken]);

 useEffect(()=>{
  if(!isAdmin)return;
  let valid=true;
  setGroupsState("loading");
  organizationApi.groups()
   .then(data=>{if(valid){setGroups(data);setGroupsState("ready");}})
   .catch(()=>{if(valid)setGroupsState("failed");});
  return()=>{valid=false;};
 },[isAdmin,groupsToken]);

 useEffect(()=>{
  if(departments.length===0||rootsExpanded.current)return;
  rootsExpanded.current=true;
  const ids=new Set(departments.map(d=>d.id));
  setExpanded(new Set(departments.filter(d=>d.parentId===null||!ids.has(d.parentId)).map(d=>d.id)));
 },[departments]);

 useEffect(()=>{
  if(selectedGroup!=="")return;
  const first=groups[0];
  if(first)setSelectedGroup(first.id);
 },[groups,selectedGroup]);

 useEffect(()=>{
  if(!isAdmin||selectedGroup==="")return;
  let valid=true;
  setMembersState("loading");
  organizationApi.members(selectedGroup)
   .then(data=>{if(valid){setGroupMembers(data);setMembersState("ready");}})
   .catch(()=>{if(valid){setGroupMembers([]);setMembersState("failed");}});
  return()=>{valid=false;};
 },[isAdmin,selectedGroup,membersToken]);

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

 const rows=useMemo(()=>{
  const out:DeptRow[]=[];
  const seen=new Set<string>();
  const walk=(parentId:string,depth:number)=>{
   if(depth>MAX_DEPTH)return;
   for(const d of deptIndex.get(parentId)??[]){
    if(seen.has(d.id))continue;
    seen.add(d.id);
    out.push({department:d,depth});
    if(expanded.has(d.id))walk(d.id,depth+1);
   }
  };
  walk("",0);
  return out;
 },[deptIndex,expanded]);

 useEffect(()=>{
  if(!focusedId)return;
  const node=[...document.querySelectorAll<HTMLElement>("li[data-dept-id]")]
   .find(element=>element.dataset.deptId===focusedId);
  node?.focus();
 },[focusedId]);

 const deptFilter=departmentsState==="ready"?selectedDepartment:"";
 const activeDeptIds=deptFilter!==""&&deptFilter!=="__unassigned"?selectedDeptIds:null;
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
 useEffect(()=>setMemberLimit(MEMBER_DISPLAY_STEP),[selectedDepartment,statusFilter,memberQuery]);

 const deptHits=useMemo(()=>{
  const keyword=deptQuery.trim().toLowerCase();
  if(keyword==="")return{items:[] as Department[],truncated:false};
  const matched=departments.filter(d=>d.name.toLowerCase().includes(keyword));
  return{items:matched.slice(0,DEPT_HIT_CAP),truncated:matched.length>DEPT_HIT_CAP};
 },[departments,deptQuery]);

 const filteredGroups=useMemo(()=>{
  const keyword=groupQuery.trim().toLowerCase();
  if(keyword==="")return groups;
  return groups.filter(g=>g.name.toLowerCase().includes(keyword));
 },[groups,groupQuery]);
 useEffect(()=>setGroupLimit(GROUP_DISPLAY_STEP),[groupQuery]);
 useEffect(()=>setGroupMemberLimit(MEMBER_DISPLAY_STEP),[selectedGroup]);

 const selectedGroupRow=groups.find(g=>g.id===selectedGroup)??null;

 const candidates=useMemo(()=>{
  const keyword=candidateQuery.trim().toLowerCase();
  const current=new Set(groupMembers.map(m=>m.id));
  return users
   .filter(user=>user.disabled!==true&&!current.has(user.id)&&(keyword===""||matchesQuery(user,keyword)))
   .slice(0,CANDIDATE_CAP);
 },[users,groupMembers,candidateQuery]);

 const canCreateUser=
  newUser.login.trim()!==""&&newUser.displayName.trim()!==""&&newUser.password.length>=16;

 async function refreshUsers(failure:string):Promise<void>{
  try{
   setUsers(await organizationApi.users());
   setUsersState("ready");
  }catch{
   setUsers([]);
   setUsersState("failed");
   setNotice({tone:"error",text:failure});
  }
 }

 async function refreshDepartments(failure:string):Promise<void>{
  try{
   setDepartments(await organizationApi.departments());
   setDepartmentsState("ready");
  }catch{
   setDepartments([]);
   setDepartmentsState("failed");
   setNotice({tone:"error",text:failure});
  }
 }

 async function refreshGroups(failure:string):Promise<void>{
  try{
   setGroups(await organizationApi.groups());
   setGroupsState("ready");
  }catch{
   setGroups([]);
   setGroupsState("failed");
   setNotice({tone:"error",text:failure});
  }
 }

 async function refreshMembers(failure:string):Promise<boolean>{
  if(selectedGroup==="")return false;
  try{
   setGroupMembers(await organizationApi.members(selectedGroup));
   setMembersState("ready");
   return true;
  }catch{
   setGroupMembers([]);
   setMembersState("failed");
   setNotice({tone:"error",text:failure});
   return false;
  }
 }

 function toggle(id:string,force?:boolean){
  setExpanded(old=>{
   const next=new Set(old);
   const shouldOpen=force??!next.has(id);
   if(shouldOpen)next.add(id);else next.delete(id);
   return next;
  });
 }

 function focusIndex(index:number){
  if(rows.length===0)return;
  const target=rows[Math.max(0,Math.min(rows.length-1,index))];
  if(target)setFocusedId(target.department.id);
 }

 function onTreeKeyDown(event:KeyboardEvent<HTMLUListElement>){
  if(!focusedId)return;
  const index=rows.findIndex(row=>row.department.id===focusedId);
  const row=index<0?undefined:rows[index];
  if(!row)return;
  const id=row.department.id;
  const isOpen=expanded.has(id);
  const hasChildren=(deptIndex.get(id)??[]).length>0;
  switch(event.key){
   case "ArrowDown":
    event.preventDefault();focusIndex(index+1);break;
   case "ArrowUp":
    event.preventDefault();focusIndex(index-1);break;
   case "ArrowRight":{
    event.preventDefault();
    if(!isOpen){
     if(hasChildren)toggle(id,true);
     break;
    }
    const next=rows[index+1];
    if(next&&next.depth>row.depth)setFocusedId(next.department.id);
    break;
   }
   case "ArrowLeft":{
    event.preventDefault();
    if(isOpen){toggle(id,false);break;}
    for(let at=index-1;at>=0;at--){
     const candidateRow=rows[at];
     if(candidateRow&&candidateRow.depth<row.depth){setFocusedId(candidateRow.department.id);break;}
    }
    break;
   }
   case "Home":
    event.preventDefault();focusIndex(0);break;
   case "End":
    event.preventDefault();focusIndex(rows.length-1);break;
   case "Enter":
   case " ":
    event.preventDefault();setSelectedDepartment(id);break;
  }
 }

 function revealDepartment(id:string){
  const chain:string[]=[];
  const seen=new Set<string>();
  let current=deptById.get(id)?.parentId??null;
  while(current!==null&&!seen.has(current)){
   seen.add(current);
   chain.push(current);
   current=deptById.get(current)?.parentId??null;
  }
  if(chain.length>0)setExpanded(old=>{
   const next=new Set(old);
   for(const ancestor of chain)next.add(ancestor);
   return next;
  });
  setSelectedDepartment(id);
  setDeptQuery("");
 }

 async function createUser():Promise<DialogResult>{
  const login=newUser.login.trim();
  const displayName=newUser.displayName.trim();
  try{
   await organizationApi.createUser(login,displayName,newUser.password,newUser.departmentId);
  }catch(error){
   const code=errorCode(error);
   if(code==="E_NETWORK"||code==="E_NOT_FOUND")
    await refreshUsers(`账号 ${login} 的创建结果未确认，用户列表刷新失败，请重试。`);
   return{error:mutationCopy(error,"创建账号失败")};
  }
  setNewUser({login:"",displayName:"",password:"",departmentId:""});
  setNotice({tone:"info",text:`已创建账号 ${login}（${displayName}），可使用设置的密码直接登录。`});
  await refreshUsers(`已创建账号 ${login}，但用户列表刷新失败，请点击列表中的重试。`);
  return{ok:`已创建账号 ${login}（${displayName}），可直接登录。`};
 }

 async function resetPassword(password:string):Promise<DialogResult>{
  const target=resetTarget;
  if(!target)return{error:"目标账号已变化，请重新打开对话框。"};
  try{
   await organizationApi.resetPassword(target.id,password);
  }catch(error){
   const code=errorCode(error);
   if(code==="E_NETWORK"||code==="E_NOT_FOUND")
    await refreshUsers(`重置 ${loginOf(target)} 密码的结果未确认，用户列表刷新失败，请重试。`);
   return{error:mutationCopy(error,"重置密码失败")};
  }
  setNotice({tone:"info",text:`已重置 ${loginOf(target)} 的密码；全部旧会话已失效，新密码可直接登录。`});
  await refreshUsers(`已重置 ${loginOf(target)} 的密码，但用户列表刷新失败，请点击列表中的重试。`);
  return{ok:`已重置 ${loginOf(target)} 的密码；全部旧会话已失效。`};
 }

 async function applyDisabled():Promise<DialogResult>{
  const target=stateTarget;
  if(!target)return{error:"目标账号已变化，请重新打开对话框。"};
  const disabled=target.disabled!==true;
  try{
   await organizationApi.setDisabled(target.id,disabled);
  }catch(error){
   const code=errorCode(error);
   if(code==="E_NETWORK"||code==="E_NOT_FOUND")
    await refreshUsers(`账号 ${loginOf(target)} 的状态变更未确认，用户列表刷新失败，请重试。`);
   return{error:mutationCopy(error,disabled?"禁用账号失败":"启用账号失败")};
  }
  setNotice({tone:"info",text:`已${disabled?"禁用":"启用"}账号 ${loginOf(target)}。`});
  await refreshUsers(`已${disabled?"禁用":"启用"} ${loginOf(target)}，但用户列表刷新失败，请点击列表中的重试。`);
  return{ok:`已${disabled?"禁用":"启用"}账号 ${loginOf(target)}。${disabled?"其登录会话已失效。":""}`};
 }

 async function removeMember():Promise<DialogResult>{
  const target=removeTarget;
  const group=selectedGroupRow;
  if(!target||!group)return{error:"工作组或成员已变化，请重新选择。"};
  try{
   await organizationApi.removeMember(group.id,target.id);
  }catch(error){
   const code=errorCode(error);
   if(code==="E_NETWORK"||code==="E_NOT_FOUND")
    await refreshMembers("移除成员的结果未确认，工作组成员刷新失败，请重试。");
   return{error:mutationCopy(error,"移除成员失败")};
  }
  setGroupMembers(prev=>prev.filter(member=>member.id!==target.id));
  setNotice({tone:"info",text:`已把 ${target.displayName} 从工作组 ${group.name} 移除。`});
  return{ok:`已把 ${target.displayName} 从工作组 ${group.name} 移除；其直接授权不受影响，最终生效权限由服务端判定。`};
 }

 async function addMember(user:User){
  const group=selectedGroupRow;
  if(!group||addBusy!=="")return;
  setNotice(null);
  setAddBusy(user.id);
  try{
   await organizationApi.addMember(group.id,user.id);
  }catch(error){
   const code=errorCode(error);
   if(code==="E_NETWORK"||code==="E_NOT_FOUND"||code==="E_INTERNAL"||code==="E_NAME_CONFLICT")
    await refreshMembers("添加成员未成功，工作组成员刷新失败，请重试。");
   setNotice({tone:"error",text:code==="E_INTERNAL"||code==="E_NAME_CONFLICT"
    ?"服务端未接受该成员变更；已重新读取成员列表，请确认该账号是否已在工作组中。"
    :mutationCopy(error,"添加成员失败")});
   setAddBusy("");
   return;
  }
  setAddBusy("");
  const refreshed=await refreshMembers(`已把 ${user.displayName} 加入工作组 ${group.name}，但成员列表刷新失败，请点击重试。`);
  if(refreshed)setNotice({tone:"info",text:`已把 ${user.displayName} 加入工作组 ${group.name}。`});
 }

 async function createDepartment(name:string,parentId:string):Promise<DialogResult>{
  try{
   await organizationApi.createDepartment(name,parentId);
  }catch(error){
   const code=errorCode(error);
   if(code==="E_NETWORK")await refreshDepartments("部门创建结果未确认，部门列表刷新失败，请重试。");
   return{error:mutationCopy(error,"创建部门失败")};
  }
  await refreshDepartments(`已创建部门 ${name}，但部门列表刷新失败，请点击列表中的重试。`);
  return{ok:`已创建部门“${name}”。部门成员与工作组需要另行指派。`};
 }

 async function createGroup(name:string,departmentId:string):Promise<DialogResult>{
  try{
   await organizationApi.createGroup(name,departmentId);
  }catch(error){
   const code=errorCode(error);
   if(code==="E_NETWORK")await refreshGroups("工作组创建结果未确认，工作组列表刷新失败，请重试。");
   return{error:mutationCopy(error,"创建工作组失败")};
  }
  setCandidateQuery("");
  await refreshGroups(`已创建工作组 ${name}，但工作组列表刷新失败，请点击列表中的重试。`);
  return{ok:`已创建工作组“${name}”。成员在右侧“添加成员”中维护。`};
 }

 function submitCreateUser(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(!canCreateUser)return;
  setNotice(null);
  setCreateUserOpen(true);
 }

 if(!isAdmin)
  return <DelegatedRolesWorkspace/>;

 const usersReady=usersState==="ready";
 const departmentsReady=departmentsState==="ready";
 const groupsReady=groupsState==="ready";

 const memberEmpty=users.length===0
  ?"还没有账号。"
  :needle!==""
   ?"没有匹配的成员（按姓名或账号搜索）。"
   :selectedDepartment==="__unassigned"
    ?"暂无未分配部门的成员。"
    :deptFilter!==""
     ?"该部门（含子部门）暂无成员。"
     :"没有成员。";

 const scopeText=departmentsState==="failed"
  ?"范围：全部账号（部门数据不可用，暂不能按部门筛选）"
  :selectedDepartment==="__unassigned"
   ?`范围：未分配部门（${unassignedCount} 人）`
   :deptFilter===""
    ?`范围：全体组织（${users.length} 人）`
    :"范围："+departmentLabel(deptFilter)+"（含全部子部门）";

 const scopeLabel=selectedDepartment===""
  ?"全体组织"
  :selectedDepartment==="__unassigned"
   ?"未分配部门"
   :departmentLabel(selectedDepartment);

 const candidateEmpty=!usersReady
  ?"账号列表不可用，无法选择成员。"
  :candidateQuery.trim()!==""
   ?"没有匹配的可加入账号。"
   :"所有可用账号都已在该工作组中。";

 const memberTableEmpty=usersState==="loading"
  ?"正在读取用户…"
  :usersState==="failed"
   ?"用户列表读取失败，请先用上方的重试按钮。"
   :memberEmpty;

 const rendered=new Set<string>();
 function renderDeptNodes(parentId:string,depth:number):ReactNode{
  if(depth>MAX_DEPTH)return null;
  return (deptIndex.get(parentId)??[]).map(department=>{
   if(rendered.has(department.id))return null;
   rendered.add(department.id);
   const isOpen=expanded.has(department.id);
   const hasChildren=(deptIndex.get(department.id)??[]).length>0;
   const count=deptCounts.get(department.id)??0;
   const isSelected=selectedDepartment===department.id;

   return <li key={department.id} data-dept-id={department.id} role="treeitem"
    aria-expanded={hasChildren?isOpen:undefined}
    aria-selected={isSelected}
    tabIndex={focusedId===department.id||(focusedId===null&&rows[0]?.department.id===department.id)?0:-1}
    onFocus={event=>{if(event.target===event.currentTarget)setFocusedId(department.id);}}>
    <div className={"tree-row "+(isSelected?"on":"")} style={{paddingLeft:`${depth*16+14}px`}}>
     {hasChildren
      ?<RareButton type="button" className={"org-tree-chevron"+(isOpen?" open":"")}
        aria-label={(isOpen?"折叠":"展开")+" "+department.name} tabIndex={-1}
        onClick={e=>{e.stopPropagation();toggle(department.id);}}>
        <IconChevron open={isOpen}/>
       </RareButton>
      :<span className="org-tree-chevron-spacer" aria-hidden="true"/>}
     <span className="org-tree-icon" aria-hidden="true"><IconFolder/></span>
     <RareButton type="button" className="org-node-label" tabIndex={-1}
      title={fullPathOf(deptById,department.id)+"｜含子部门 "+String(count)+" 人"}
      onClick={()=>setSelectedDepartment(department.id)}>
      {department.name}
     </RareButton>
     <span className="org-node-count">（{count}）</span>
    </div>
    {isOpen&&<ul role="group">{renderDeptNodes(department.id,depth+1)}</ul>}
   </li>;
  });
 }

 return <div className="work-body">
  {/* 顶部工具栏：指标摘要与全局快捷创建 */}
  <div className="toolbar">
   <span className="toolbar-hint">{activeTab==="permissions"?"按资源目录管理直接授权":activeTab==="roles"?"管理角色 · 授权范围与职责":`账号 ${users.length} · 部门 ${departments.length} · 工作组 ${groups.length}`}</span>
   {activeTab!=="permissions"&&activeTab!=="roles"&&<>
   <RareButton type="button" onClick={()=>{setNotice(null);setCreateDepartmentOpen(true);}}>
    <IconPlus/>新建部门
   </RareButton>
   <RareButton type="button" className="primary" tone="primary" onClick={()=>{setNotice(null);setCreateGroupOpen(true);}}>
    <IconPlus/>创建工作组
   </RareButton></>}
  </div>

  {notice&&<RareNotice tone={notice.tone==="error"?"danger":"info"}>{notice.text}</RareNotice>}

  {/* 双栏主工作台：左侧组织架构树 + 右侧主工作区卡片 */}
  <div className={"org-workbench"+((activeTab==="permissions"||activeTab==="roles")?" org-permissions-workbench":"")}>
   {/* 左侧：组织架构树卡片 */}
   {activeTab!=="permissions"&&activeTab!=="roles"&&<section className="org-card org-dept-card" aria-label="组织架构树">
    <div className="org-card-header">
     <h3 className="org-card-title">
      <IconBuilding/>
      <span>组织架构</span>
      <span className="org-count-pill">{departments.length} 部门</span>
     </h3>
     <RareButton type="button" className="org-header-btn" title="新建部门"
      onClick={()=>{setNotice(null);setCreateDepartmentOpen(true);}}>
      <IconPlus/>新建
     </RareButton>
    </div>

    {departmentsState==="loading"&&<p className="hint" style={{padding:"8px 12px"}}>正在读取部门…</p>}
    {departmentsState==="failed"&&<div style={{padding:"8px 12px"}}>
     <RareNotice tone="danger">读取部门列表失败，部门树与筛选暂不可用。</RareNotice>
     <RareButton type="button" className="secondary-action" onClick={()=>setDepartmentsToken(token=>token+1)}>重试</RareButton>
    </div>}

    {departmentsReady&&<>
     <div className="org-search-box">
      <IconSearch/>
      <RareInput id="org-dept-search" className="org-search" type="search" autoComplete="off"
       value={deptQuery} onChange={event=>setDeptQuery(event.target.value)} placeholder="按部门名称查找"/>
     </div>

     {deptQuery.trim()!==""&&<div className="org-hits-panel">
      {deptHits.items.length===0
       ?<p className="hint">没有匹配的部门。</p>
       :<ul className="org-hits">
        {deptHits.items.map(d=><li key={d.id}>
         <RareButton type="button" aria-label={"选择部门 "+fullPathOf(deptById,d.id)}
          onClick={()=>revealDepartment(d.id)}>
          <span className="org-hit-name">{d.name}</span>
          <span className="hint">{ancestorPathOf(deptById,d.id)||"顶层部门"}</span>
         </RareButton>
        </li>)}
       </ul>}
      {deptHits.truncated&&<p className="hint">结果较多，仅显示前 {deptHits.items.length} 个，请细化关键词。</p>}
     </div>}

     <div className="org-tree-scroll">
      <ul className="tree" role="tree" aria-label="部门树" onKeyDown={onTreeKeyDown}>
       {/* 全体组织根节点 */}
       <li role="treeitem" aria-selected={selectedDepartment===""} tabIndex={0}
        onClick={()=>setSelectedDepartment("")}>
        <div className={"tree-row "+(selectedDepartment===""?"on":"")} style={{paddingLeft:"10px"}}>
         <span className="org-tree-chevron-spacer" aria-hidden="true"/>
         <span className="org-tree-icon" aria-hidden="true"><IconBuilding/></span>
         <RareButton type="button" className="org-node-label" tabIndex={-1}
          title={"全体组织｜共 "+String(users.length)+" 人"}
          onClick={()=>setSelectedDepartment("")}>
          全体组织
         </RareButton>
         <span className="org-node-count">（{users.length}）</span>
        </div>
       </li>

       {/* 部门层级子树 */}
       {departments.length===0&&<li role="none" className="hint" style={{padding:"8px 12px"}}>还没有部门；可用上方按钮创建。</li>}
       {renderDeptNodes("",0)}

       {/* 未分配部门节点 */}
       {unassignedCount>0&&<li role="treeitem" aria-selected={selectedDepartment==="__unassigned"} tabIndex={-1}
        onClick={()=>setSelectedDepartment("__unassigned")}>
        <div className={"tree-row "+(selectedDepartment==="__unassigned警"||selectedDepartment==="__unassigned"?"on":"")} style={{paddingLeft:"10px"}}>
         <span className="org-tree-chevron-spacer" aria-hidden="true"/>
         <span className="org-tree-icon" aria-hidden="true"><IconUsers/></span>
         <RareButton type="button" className="org-node-label" tabIndex={-1}
          title={"未分配部门｜共 "+String(unassignedCount)+" 人"}
          onClick={()=>setSelectedDepartment("__unassigned")}>
          未分配部门
         </RareButton>
         <span className="org-node-count">（{unassignedCount}）</span>
        </div>
       </li>}
      </ul>
     </div>
    </>}
   </section>}

   {/* 右侧：组织工作区 */}
   <section className="org-card org-stage-card" aria-label="组织管理主工作区">
    <div className="org-tabs-bar">
     <RareTabs className="org-tabs-nav" label="组织管理视图">
      <RareButton type="button" role="tab" aria-selected={activeTab==="members"} tabIndex={activeTab==="members"?0:-1} id="org-tab-members" aria-controls="org-panel-members"
       className={"org-tab"+(activeTab==="members"?" active":"")}
       onClick={()=>setActiveTab("members")}>
       <span className="org-tab-icon"><IconUsers/></span>
       <span>部门成员</span>
       <span className="org-tab-badge">{filteredMembers.length}</span>
      </RareButton>
      <RareButton type="button" role="tab" aria-selected={activeTab==="groups"} tabIndex={activeTab==="groups"?0:-1} id="org-tab-groups" aria-controls="org-panel-groups"
       className={"org-tab"+(activeTab==="groups"?" active":"")}
       onClick={()=>setActiveTab("groups")}>
       <span className="org-tab-icon"><IconGroup/></span>
       <span>工作组管理</span>
       <span className="org-tab-badge">{groups.length}</span>
      </RareButton>
      <RareButton type="button" role="tab" aria-selected={activeTab==="permissions"} tabIndex={activeTab==="permissions"?0:-1} id="org-tab-permissions" aria-controls="org-panel-permissions"
       className={"org-tab"+(activeTab==="permissions"?" active":"")}
       onClick={()=>setActiveTab("permissions")}>权限管理</RareButton>
      <RareButton type="button" role="tab" aria-selected={activeTab==="roles"} tabIndex={activeTab==="roles"?0:-1} id="org-tab-roles" aria-controls="org-panel-roles"
       className={"org-tab"+(activeTab==="roles"?" active":"")}
       onClick={()=>setActiveTab("roles")}>管理角色</RareButton>
     </RareTabs>

     {/* 当前部门范围标识 */}
     {activeTab!=="permissions"&&activeTab!=="roles"&&<div className="org-scope-badge">
      <span className="org-scope-dot" aria-hidden="true"/>
      <span>范围：{scopeLabel}</span>
      {selectedDepartment!==""&&<RareButton type="button" className="org-scope-reset"
       title="清除部门筛选，显示全体" onClick={()=>setSelectedDepartment("")}>✕</RareButton>}
     </div>}
    </div>

    {activeTab==="permissions"&&<div className="rare-tab-panel" role="tabpanel" id="org-panel-permissions" aria-labelledby="org-tab-permissions"><PermissionsPanel users={users} groups={groups}
     usersState={usersState} groupsState={groupsState}
     onRetryUsers={()=>setUsersToken(token=>token+1)}
     onRetryGroups={()=>setGroupsToken(token=>token+1)}/></div>}
    {activeTab==="roles"&&<div className="rare-tab-panel" role="tabpanel" id="org-panel-roles" aria-labelledby="org-tab-roles"><RoleBindingsPanel users={users}/></div>}

    {/* Tab 1: 部门成员 */}
    {activeTab==="members"&&<div className="org-tab-stage" role="tabpanel" id="org-panel-members" aria-labelledby="org-tab-members">
     {/* 搜索与筛选条 */}
     <div className="org-filter-bar">
      <div className="org-filter-left">
       <div className="org-member-search-wrap">
        <IconSearch/>
        <RareInput className="org-search" type="search" aria-label="搜索成员" autoComplete="off"
         placeholder="按姓名或账号搜索成员" value={memberQuery} onChange={event=>setMemberQuery(event.target.value)}/>
       </div>
       <RareSelect className="org-select" aria-label="按状态筛选"
        value={statusFilter} onChange={e=>setStatusFilter(e.target.value as StatusFilter)}>
        <option value="all">全部状态</option>
        <option value="normal">正常</option>
        <option value="disabled">已禁用</option>
        <option value="admin">系统管理员</option>
       </RareSelect>
       {usersState==="failed"&&<RareButton type="button" className="secondary-action" onClick={()=>setUsersToken(token=>token+1)}>重新读取用户</RareButton>}
      </div>
      <span className="toolbar-hint">显示 {Math.min(memberLimit,filteredMembers.length)} / {filteredMembers.length} 位成员</span>
     </div>

     {notice&&notice.tone==="error"&&usersState==="failed"&&<RareNotice tone="danger">{notice.text}</RareNotice>}

     {/* 成员数据表格 */}
     <div className="org-table-container">
      <table aria-label="成员列表" aria-busy={usersState==="loading"?true:undefined}>
       <thead>
        <tr>
         <th scope="col" style={{width:"22%"}}>姓名</th>
         <th scope="col" style={{width:"18%"}}>账号</th>
         <th scope="col" style={{width:"24%"}}>部门</th>
         <th scope="col" style={{width:"18%"}}>状态</th>
         <th scope="col" style={{width:"18%"}}>操作</th>
        </tr>
       </thead>
       <tbody>
        {filteredMembers.slice(0,memberLimit).map(user=><tr key={user.id}>
         <td>
          <div className="org-user-cell">
           <span className="org-avatar" aria-hidden="true">{user.displayName.slice(0,1)}</span>
           <span className="org-user-name">{user.displayName}</span>
          </div>
         </td>
         <td>
          <code className="org-user-login">{loginOf(user)||"—"}</code>
         </td>
         <td title={user.departmentId&&!deptById.has(user.departmentId)?user.departmentId:undefined}>
          <span className="org-dept-tag">{departmentLabel(user.departmentId)}</span>
         </td>
         <td>
          <span className="org-badges">
           {user.isAdmin&&<RareBadge tone="info" dot>系统管理员</RareBadge>}
           {user.disabled===true&&<RareBadge tone="danger" dot
            title="账号已禁用：无法登录，现有会话已失效；其工作组与授权记录仍保留。">已禁用</RareBadge>}
           {user.disabled!==true&&<RareBadge tone="success" dot>正常</RareBadge>}
          </span>
         </td>
         <td className="row-actions">
          <RareButton type="button" onClick={()=>{setNotice(null);setResetTarget(user);}}>重置密码</RareButton>
          {user.id===currentUserId
           ?<RareButton type="button" disabled title="不能对当前登录账号执行禁用">禁用</RareButton>
           :<RareButton type="button" tone={user.disabled===true?"neutral":"danger"} className={user.disabled===true?"org-btn-enable":"danger"}
             onClick={()=>{setNotice(null);setStateTarget(user);}}>{user.disabled===true?"启用":"禁用"}</RareButton>}
         </td>
        </tr>)}
        {filteredMembers.length===0&&<tr><td colSpan={5} className="empty">{memberTableEmpty}</td></tr>}
       </tbody>
      </table>
     </div>
     {filteredMembers.length>memberLimit&&<div className="org-list-more">
      <span className="hint">已显示 {memberLimit} / {filteredMembers.length} 位成员</span>
      <RareButton type="button" onClick={()=>setMemberLimit(limit=>limit+MEMBER_DISPLAY_STEP)}>
       显示更多成员
      </RareButton>
     </div>}


     {/* 快速添加成员卡片 */}
     <div className="org-create-user-card">
      <div className="org-create-user-head">
       <div className="org-create-user-title">
        <IconPlus/>
        <span>快速添加新成员</span>
       </div>
       <span className="hint">密码至少 16 位，创建后即可登录</span>
      </div>
      <form className="inline-form org-form org-create-form" onSubmit={submitCreateUser}>
       <div className="org-field">
        <label className="org-field-label" htmlFor="org-new-login">新账号</label>
        <RareInput id="org-new-login" aria-label="新账号" placeholder="新账号" value={newUser.login}
         onChange={event=>setNewUser(prev=>({...prev,login:event.target.value}))}/>
       </div>
       <div className="org-field">
        <label className="org-field-label" htmlFor="org-new-name">姓名</label>
        <RareInput id="org-new-name" aria-label="姓名" placeholder="姓名" value={newUser.displayName}
         onChange={event=>setNewUser(prev=>({...prev,displayName:event.target.value}))}/>
       </div>
       <div className="org-field">
        <label className="org-field-label" htmlFor="org-new-pwd">初始密码</label>
        <RareInput id="org-new-pwd" aria-label="初始密码" placeholder="初始密码（≥16 位）" type="password" autoComplete="new-password" value={newUser.password}
         onChange={event=>setNewUser(prev=>({...prev,password:event.target.value}))}/>
       </div>
       <div className="org-field">
        <label className="org-field-label" htmlFor="org-new-dept">部门</label>
        <RareSelect id="org-new-dept" className="org-select" aria-label="部门" value={newUser.departmentId}
         onChange={event=>setNewUser(prev=>({...prev,departmentId:event.target.value}))}>
         <option value="">未分配部门</option>
         {departmentOptions.map(option=><option key={option.id} value={option.id}>{option.label}</option>)}
        </RareSelect>
       </div>
       <RareButton className="primary" tone="primary" type="submit" disabled={!canCreateUser}>创建用户</RareButton>
      </form>
     </div>
    </div>}

    {/* Tab 2: 工作组管理（Master-Detail 双栏结构） */}
    {activeTab==="groups"&&<div className="org-groups-stage" role="tabpanel" id="org-panel-groups" aria-labelledby="org-tab-groups">
     {/* 左侧：工作组卡片列表 */}
     <div className="org-group-list-col">
      <div className="org-card-header">
       <h4 className="org-card-title">
        <IconGroup/>
        <span>工作组列表</span>
        <span className="org-count-pill">{groups.length}</span>
       </h4>
       <RareButton type="button" className="org-header-btn" title="创建工作组"
        onClick={()=>{setNotice(null);setCreateGroupOpen(true);}}>
        <IconPlus/>新建
       </RareButton>
      </div>

      <div className="org-search-box">
       <IconSearch/>
       <RareInput className="org-search" type="search" placeholder="搜索工作组..."
        value={groupQuery} onChange={e=>setGroupQuery(e.target.value)}/>
      </div>

      {groupsState==="loading"&&<p className="hint" style={{padding:"8px 12px"}}>正在读取工作组…</p>}
      {groupsState==="failed"&&<div style={{padding:"8px 12px"}}>
       <RareNotice tone="danger">读取工作组列表失败。</RareNotice>
       <RareButton type="button" className="secondary-action" onClick={()=>setGroupsToken(t=>t+1)}>重试</RareButton>
      </div>}

      {groupsReady&&groups.length===0&&<p className="empty" style={{padding:"16px 12px"}}>暂无工作组，可点上方“新建”创建。</p>}

      {groupsReady&&groups.length>0&&<ul className="org-group-cards-list">
       {filteredGroups.slice(0,groupLimit).map(group=>{
        const isSelected=group.id===selectedGroup;
        return <li key={group.id}>
         <RareButton type="button" className={"org-group-card"+(isSelected?" active":"")}
          aria-pressed={isSelected} onClick={()=>setSelectedGroup(group.id)}>
          <div className="org-group-card-header">
           <span className="org-group-name">{group.name}</span>
           {isSelected&&<span className="org-active-pill">选中</span>}
          </div>
          <div className="org-group-card-sub">
           <span className="org-dept-pill">
            {group.departmentId?departmentLabel(group.departmentId):"公共工作组"}
           </span>
          </div>
         </RareButton>
        </li>;
       })}
       {filteredGroups.length===0&&<li className="empty">没有匹配的工作组。</li>}
      </ul>}
      {filteredGroups.length>groupLimit&&<div className="org-list-more">
       <span className="hint">已显示 {groupLimit} / {filteredGroups.length} 个工作组</span>
       <RareButton type="button" onClick={()=>setGroupLimit(limit=>limit+GROUP_DISPLAY_STEP)}>显示更多工作组</RareButton>
      </div>}
     </div>

     {/* 右侧：所选工作组详情与成员维护 */}
     <div className="org-group-detail-col">
      {selectedGroupRow===null
       ?<div className="empty" style={{margin:"auto",textAlign:"center"}}>请从左侧选择一个工作组以查看并配置成员。</div>
       :<>
        <div className="org-group-banner">
         <div className="org-group-banner-info">
          <h4 className="org-group-detail-title">{selectedGroupRow.name}</h4>
          <span className="org-dept-pill">
           {selectedGroupRow.departmentId?departmentLabel(selectedGroupRow.departmentId):"公共工作组"}
          </span>
         </div>
         <span className="toolbar-hint">当前成员 {groupMembers.length} 人</span>
        </div>

        {/* 组内成员列表 */}
        <div className="org-group-section">
         <div className="org-section-header">
          <h5>组内成员（{groupMembers.length}）</h5>
          {membersState==="failed"&&<RareButton type="button" className="secondary-action" onClick={()=>setMembersToken(t=>t+1)}>重试</RareButton>}
         </div>

         {membersState==="loading"&&<p className="hint">正在读取工作组成员…</p>}
         {membersState==="ready"&&<div className="org-member-grid">
          {groupMembers.slice(0,groupMemberLimit).map(member=><div key={member.id} className="org-member-card">
           <div className="org-member-card-info">
            <span className="org-avatar" aria-hidden="true">{member.displayName.slice(0,1)}</span>
            <div className="org-member-card-text">
             <span className="org-member-card-name">{member.displayName}</span>
             <code className="org-member-card-login">{loginOf(member)}</code>
            </div>
            {member.disabled===true&&<RareBadge tone="danger" dot>已禁用</RareBadge>}
           </div>
           <RareButton type="button" tone="danger" className="danger org-action-btn"
            onClick={()=>{setNotice(null);setRemoveTarget(member);}}>移除</RareButton>
          </div>)}
          {groupMembers.length===0&&<p className="empty" style={{gridColumn:"1/-1"}}>该工作组暂无成员，可在下方添加成员。</p>}
         </div>}
         {membersState==="ready"&&groupMembers.length>groupMemberLimit&&
          <div className="org-list-more">
           <span className="hint">已显示 {groupMemberLimit} / {groupMembers.length} 位工作组成员</span>
           <RareButton type="button" onClick={()=>setGroupMemberLimit(n=>n+MEMBER_DISPLAY_STEP)}>
            显示更多组内成员
           </RareButton>
          </div>}
        </div>

        {/* 添加成员到工作组 */}
        <div className="org-group-section">
         <div className="org-section-header">
          <h5>添加成员</h5>
          <span className="hint">仅显示未加入该工作组的正常账号</span>
         </div>

         {!usersReady
          ?<p className="hint">{usersState==="loading"?"正在读取可选择的账号…":"账号列表不可用，无法选择新成员。"}</p>
          :<>
           <div className="org-search-box" style={{border:"1px solid var(--border-hairline)",borderRadius:"var(--radius-sm)",padding:"0 var(--space-2)"}}>
            <IconSearch/>
            <RareInput className="org-search" type="search" aria-label="搜索可加入的账号" autoComplete="off"
             placeholder="按姓名或账号搜索可加入的账号" value={candidateQuery} onChange={event=>setCandidateQuery(event.target.value)}
             style={{border:"0"}}/>
           </div>

           <div className="org-candidate-grid">
            {candidates.map(user=><div key={user.id} className="org-candidate-card">
             <div className="org-candidate-info">
              <span className="org-avatar" aria-hidden="true">{user.displayName.slice(0,1)}</span>
              <div className="org-candidate-text">
               <span className="org-candidate-name">{user.displayName}</span>
               <code className="org-candidate-login">{loginOf(user)}</code>
              </div>
              <span className="org-dept-pill">{departmentLabel(user.departmentId)}</span>
             </div>
             <RareButton type="button" className="primary org-action-btn" onClick={()=>addMember(user)} disabled={addBusy!==""}>
              {addBusy===user.id?"加入中…":"加入"}
             </RareButton>
            </div>)}
            {candidates.length===0&&<p className="empty" style={{gridColumn:"1/-1"}}>{candidateEmpty}</p>}
           </div>

           {candidates.length>=CANDIDATE_CAP&&<p className="hint">最多显示 {CANDIDATE_CAP} 个候选账号，继续输入可缩小范围。</p>}
          </>}
        </div>
       </>}
     </div>
    </div>}
   </section>
  </div>

  {/* 对话框保持原样 */}
  {resetTarget&&<ResetPasswordDialog target={resetTarget} department={departmentLabel(resetTarget.departmentId)}
   onClose={()=>setResetTarget(null)} onSubmit={resetPassword}/>}
  {stateTarget&&<SetDisabledDialog target={stateTarget} department={departmentLabel(stateTarget.departmentId)}
   onClose={()=>setStateTarget(null)} onSubmit={applyDisabled}/>}
  {removeTarget&&<RemoveMemberDialog member={removeTarget} groupName={selectedGroupRow?.name??""}
   department={departmentLabel(removeTarget.departmentId)}
   onClose={()=>setRemoveTarget(null)} onSubmit={removeMember}/>}
  {createUserOpen&&<CreateUserConfirmDialog draft={{login:newUser.login.trim(),displayName:newUser.displayName.trim()}}
   department={departmentLabel(newUser.departmentId)}
   onClose={()=>setCreateUserOpen(false)} onSubmit={createUser}/>}
  {createDepartmentOpen&&<CreateDepartmentDialog options={departmentOptions} defaultParentId={deptFilter}
   listAvailable={departmentsReady}
   onClose={()=>setCreateDepartmentOpen(false)} onSubmit={createDepartment}/>}
  {createGroupOpen&&<CreateGroupDialog options={departmentOptions} defaultDepartmentId={deptFilter}
   listAvailable={departmentsReady}
   onClose={()=>setCreateGroupOpen(false)} onSubmit={createGroup}/>}
 </div>;
}

function ResetPasswordDialog({target,department,onClose,onSubmit}:{
 target:User;
 department:string;
 onClose:()=>void;
 onSubmit:(password:string)=>Promise<DialogResult>;
}){
 const[password,setPassword]=useState("");
 const[busy,setBusy]=useState(false);
 const[result,setResult]=useState<{text:string;tone:Tone}|null>(null);
 const[confirmDiscard,setConfirmDiscard]=useState(false);
 const dirty=password!==""&&result===null;

 async function submit(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(busy||password.length<16)return;
  setBusy(true);
  const outcome=await onSubmit(password);
  setBusy(false);
  if("error" in outcome)setResult({text:outcome.error,tone:"error"});
  else{
   setPassword("");
   setResult({text:outcome.ok,tone:"info"});
  }
 }

 function requestClose(){
  if(busy)return;
  if(dirty){setConfirmDiscard(true);return;}
  onClose();
 }

 return <Dialog open title={`重置密码 — ${target.displayName}`} onClose={onClose} className="org-dialog"
  initialFocus="#org-reset-password"
  closeGuard={()=>{if(busy)return false;if(dirty){setConfirmDiscard(true);return false;}return true;}}>
  {confirmDiscard
   ?<>
    <p className="hint">已输入的新密码将被丢弃，不会提交给服务端。</p>
    <div className="dialog-actions">
     <RareButton type="button" className="secondary-action" onClick={()=>setConfirmDiscard(false)} disabled={busy}>继续编辑</RareButton>
     <RareButton type="button" tone="danger" className="danger" onClick={onClose} disabled={busy}>放弃并关闭</RareButton>
    </div>
   </>
   :result
    ?<>
     <RareNotice tone={result.tone==="error"?"danger":"success"}>{result.text}</RareNotice>
     <div className="dialog-actions"><RareButton type="button" tone="primary" className="primary" onClick={onClose} autoFocus>关闭</RareButton></div>
    </>
    :<form onSubmit={submit}>
     <p>账号：{loginOf(target)||"—"}</p>
     <p>部门：{department}</p>
     {target.disabled===true&&<p className="hint">该账号当前已禁用：重置密码不会启用账号。</p>}
     <p className="hint">提交后该账号的全部登录会话立即失效，可使用新密码直接登录。</p>
     <label htmlFor="org-reset-password">新密码</label>
     <RareInput id="org-reset-password" type="password" autoComplete="new-password" value={password}
      onChange={event=>setPassword(event.target.value)} disabled={busy}/>
     <p className="hint">至少 16 个字符（客户端只校验长度，密码策略以服务端判定为准）。</p>
     <div className="dialog-actions">
      <RareButton type="button" className="secondary-action" onClick={requestClose} disabled={busy}>取消</RareButton>
      <RareButton type="submit" tone="primary" className="primary" loading={busy} disabled={busy||password.length<16}>{busy?"重置中…":"确认重置密码"}</RareButton>
     </div>
    </form>}
 </Dialog>;
}

function SetDisabledDialog({target,department,onClose,onSubmit}:{
 target:User;
 department:string;
 onClose:()=>void;
 onSubmit:()=>Promise<DialogResult>;
}){
 const[busy,setBusy]=useState(false);
 const[result,setResult]=useState<{text:string;tone:Tone}|null>(null);
 const disabling=target.disabled!==true;

 async function run(){
  if(busy)return;
  setBusy(true);
  const outcome=await onSubmit();
  setBusy(false);
  if("error" in outcome)setResult({text:outcome.error,tone:"error"});
  else setResult({text:outcome.ok,tone:"info"});
 }

 return <Dialog open title={disabling?"禁用账号":"启用账号"} onClose={onClose} closeGuard={()=>!busy} className="org-dialog">
  {result
   ?<>
    <RareNotice tone={result.tone==="error"?"danger":"success"}>{result.text}</RareNotice>
    <div className="dialog-actions"><RareButton type="button" tone="primary" className="primary" onClick={onClose} autoFocus>关闭</RareButton></div>
   </>
   :<form onSubmit={event=>{event.preventDefault();run();}}>
    <p>账号：{loginOf(target)||"—"}（{target.displayName}）</p>
    <p>部门：{department}</p>
    <p>当前状态：{target.disabled===true?"已禁用":"正常"}</p>
    <p>{disabling
     ?"影响：禁用后该账号立即无法登录，现有登录会话立即失效；其工作组与授权记录保留，启用后恢复。该操作写入审计日志。"
     :"影响：启用后该账号可再次登录，并恢复原有的工作组与授权（最终生效权限由服务端判定）。"}</p>
    <div className="dialog-actions">
     <RareButton type="button" className="secondary-action" onClick={onClose} disabled={busy}>取消</RareButton>
     <RareButton type="submit" tone={disabling?"danger":"primary"} className={disabling?"danger":"primary"} loading={busy}>
      {busy?(disabling?"禁用中…":"启用中…"):(disabling?"确认禁用":"确认启用")}
     </RareButton>
    </div>
   </form>}
 </Dialog>;
}

function RemoveMemberDialog({member,groupName,department,onClose,onSubmit}:{
 member:User;
 groupName:string;
 department:string;
 onClose:()=>void;
 onSubmit:()=>Promise<DialogResult>;
}){
 const[busy,setBusy]=useState(false);
 const[result,setResult]=useState<{text:string;tone:Tone}|null>(null);

 async function run(){
  if(busy)return;
  setBusy(true);
  const outcome=await onSubmit();
  setBusy(false);
  if("error" in outcome)setResult({text:outcome.error,tone:"error"});
  else setResult({text:outcome.ok,tone:"info"});
 }

 return <Dialog open title="移除工作组成员" onClose={onClose} closeGuard={()=>!busy} className="org-dialog">
  {result
   ?<>
    <RareNotice tone={result.tone==="error"?"danger":"success"}>{result.text}</RareNotice>
    <div className="dialog-actions"><RareButton type="button" tone="primary" className="primary" onClick={onClose} autoFocus>关闭</RareButton></div>
   </>
   :<form onSubmit={event=>{event.preventDefault();run();}}>
    <p>工作组：{groupName||"—"}</p>
    <p>成员：{member.displayName}（{loginOf(member)||"—"}）</p>
    <p>部门：{department}</p>
    <p>影响：移除后该账号不再通过本工作组获得授权；直接授予该账号的权限不受影响，最终生效权限由服务端判定。之后可以重新加入。</p>
    <div className="dialog-actions">
     <RareButton type="button" className="secondary-action" onClick={onClose} disabled={busy}>取消</RareButton>
     <RareButton type="submit" tone="danger" loading={busy}>{busy?"移除中…":"确认移除"}</RareButton>
    </div>
   </form>}
 </Dialog>;
}

function CreateUserConfirmDialog({draft,department,onClose,onSubmit}:{
 draft:{login:string;displayName:string};
 department:string;
 onClose:()=>void;
 onSubmit:()=>Promise<DialogResult>;
}){
 const[busy,setBusy]=useState(false);
 const[result,setResult]=useState<{text:string;tone:Tone}|null>(null);

 async function run(){
  if(busy)return;
  setBusy(true);
  const outcome=await onSubmit();
  setBusy(false);
  if("error" in outcome)setResult({text:outcome.error,tone:"error"});
  else setResult({text:outcome.ok,tone:"info"});
 }

 return <Dialog open title="创建账号确认" onClose={onClose} closeGuard={()=>!busy} className="org-dialog">
  {result
   ?<>
    <RareNotice tone={result.tone==="error"?"danger":"success"}>{result.text}</RareNotice>
    <div className="dialog-actions"><RareButton type="button" tone="primary" className="primary" onClick={onClose} autoFocus>关闭</RareButton></div>
   </>
   :<form onSubmit={event=>{event.preventDefault();run();}}>
    <p>账号：{draft.login}</p>
    <p>姓名：{draft.displayName}</p>
    <p>部门：{department}</p>
    <p className="hint">密码不会在界面回显；创建后该账号可直接使用此密码登录。</p>
    <p className="hint">取消不会清空表单内容，可以修改后再提交。</p>
    <div className="dialog-actions">
     <RareButton type="button" className="secondary-action" onClick={onClose} disabled={busy}>返回修改</RareButton>
     <RareButton type="submit" tone="primary" loading={busy}>{busy?"创建中…":"确认创建"}</RareButton>
    </div>
   </form>}
 </Dialog>;
}

function CreateDepartmentDialog({options,defaultParentId,listAvailable,onClose,onSubmit}:{
 options:{id:string;label:string}[];
 defaultParentId:string;
 listAvailable:boolean;
 onClose:()=>void;
 onSubmit:(name:string,parentId:string)=>Promise<DialogResult>;
}){
 const[name,setName]=useState("");
 const[parentId,setParentId]=useState(defaultParentId);
 const[busy,setBusy]=useState(false);
 const[result,setResult]=useState<{text:string;tone:Tone}|null>(null);

 async function run(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(busy||name.trim()==="")return;
  setBusy(true);
  const outcome=await onSubmit(name.trim(),parentId);
  setBusy(false);
  if("error" in outcome)setResult({text:outcome.error,tone:"error"});
  else setResult({text:outcome.ok,tone:"info"});
 }

 return <Dialog open title="新建部门" onClose={onClose} closeGuard={()=>!busy} className="org-dialog">
  {result
   ?<>
    <RareNotice tone={result.tone==="error"?"danger":"success"}>{result.text}</RareNotice>
    <div className="dialog-actions"><RareButton type="button" tone="primary" className="primary" onClick={onClose} autoFocus>关闭</RareButton></div>
   </>
   :<form onSubmit={run}>
    <label htmlFor="org-new-department">部门名称</label>
    <RareInput id="org-new-department" value={name} maxLength={80} disabled={busy}
     onChange={event=>setName(event.target.value)}/>
    <label htmlFor="org-new-department-parent">上级部门</label>
    <RareSelect id="org-new-department-parent" className="org-select" value={parentId} disabled={busy}
     onChange={event=>setParentId(event.target.value)}>
     <option value="">（顶层部门）</option>
     {options.map(option=><option key={option.id} value={option.id}>{option.label}</option>)}
    </RareSelect>
    <p className="hint">{listAvailable
     ?"默认挂在部门树当前筛选的部门下（未选择时为顶层部门），可更改。"
     :"部门列表不可用，只能创建顶层部门。"}名称最多 80 个字符；成员与工作组需要另行指派。</p>
    <div className="dialog-actions">
     <RareButton type="button" className="secondary-action" onClick={onClose} disabled={busy}>取消</RareButton>
     <RareButton type="submit" tone="primary" className="primary" loading={busy} disabled={busy||name.trim()===""}>{busy?"创建中…":"创建部门"}</RareButton>
    </div>
   </form>}
 </Dialog>;
}

function CreateGroupDialog({options,defaultDepartmentId,listAvailable,onClose,onSubmit}:{
 options:{id:string;label:string}[];
 defaultDepartmentId:string;
 listAvailable:boolean;
 onClose:()=>void;
 onSubmit:(name:string,departmentId:string)=>Promise<DialogResult>;
}){
 const[name,setName]=useState("");
 const[departmentId,setDepartmentId]=useState(defaultDepartmentId);
 const[busy,setBusy]=useState(false);
 const[result,setResult]=useState<{text:string;tone:Tone}|null>(null);

 async function run(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(busy||name.trim()==="")return;
  setBusy(true);
  const outcome=await onSubmit(name.trim(),departmentId);
  setBusy(false);
  if("error" in outcome)setResult({text:outcome.error,tone:"error"});
  else setResult({text:outcome.ok,tone:"info"});
 }

 return <Dialog open title="创建工作组" onClose={onClose} closeGuard={()=>!busy} className="org-dialog">
  {result
   ?<>
    <RareNotice tone={result.tone==="error"?"danger":"success"}>{result.text}</RareNotice>
    <div className="dialog-actions"><RareButton type="button" tone="primary" className="primary" onClick={onClose} autoFocus>关闭</RareButton></div>
   </>
   :<form onSubmit={run}>
    <label htmlFor="org-new-group">工作组名称</label>
    <RareInput id="org-new-group" value={name} maxLength={80} disabled={busy}
     onChange={event=>setName(event.target.value)}/>
    <label htmlFor="org-new-group-department">所属部门</label>
    <RareSelect id="org-new-group-department" className="org-select" value={departmentId} disabled={busy}
     onChange={event=>setDepartmentId(event.target.value)}>
     <option value="">（不指定部门）</option>
     {options.map(option=><option key={option.id} value={option.id}>{option.label}</option>)}
    </RareSelect>
    <p className="hint">{listAvailable
     ?"默认使用部门树当前筛选的部门（未选择时留空），可更改。"
     :"部门列表不可用，只能创建不指定部门的工作组。"}名称最多 80 个字符；成员在创建后于“添加成员”中维护。</p>
    <div className="dialog-actions">
     <RareButton type="button" className="secondary-action" onClick={onClose} disabled={busy}>取消</RareButton>
     <RareButton type="submit" tone="primary" className="primary" loading={busy} disabled={busy||name.trim()===""}>{busy?"创建中…":"创建工作组"}</RareButton>
    </div>
   </form>}
 </Dialog>;
}
