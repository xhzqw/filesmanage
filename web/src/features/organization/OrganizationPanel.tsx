import {RareTabs} from "../../shared/ui/rare/RareTabs";
import {observeWorkspaceChange} from "../../shared/resourceSync";
import {RareBadge,RareButton,RareDataTable,RareInput,RareNotice,RareRowActions,RareSelect} from "../../shared/ui/rare";
import {useCallback,useEffect,useMemo,useRef,useState,type FormEvent} from "react";
import {organizationApi,type Department,type Workgroup} from "./api";
import {errorCode,errorCopy} from "../../shared/errors";
import {Dialog} from "../../shared/ui/Dialog";
import type {User} from "../../entities/user/model";
import "./organization.css";
import "./memberWorkbench.css";
import {useSearchParams} from "react-router-dom";
import {PermissionsPanel} from "./PermissionsPanel";
import {ApprovalPoliciesPanel} from "./ApprovalPoliciesPanel";
import {RoleBindingsPanel,DelegatedRolesWorkspace} from "./RoleWorkspace";
import {DepartmentNavigator} from "./DepartmentNavigator";
import {WorkgroupMemberRow} from "./WorkgroupMemberRow";
import {IconUsers,IconSearch} from "./OrganizationIcons";
import {fullPathOf} from "./organizationTreeUtils";
import {ResetPasswordDialog,SetDisabledDialog,RemoveMemberDialog,CreateUserConfirmDialog,CreateDepartmentDialog,CreateGroupDialog,type DialogResult} from "./OrganizationDialogs";

type LoadState="loading"|"ready"|"failed";
type Tone="info"|"error";
type Notice={text:string;tone:Tone};
type StatusFilter="all"|"normal"|"disabled"|"admin";

const CANDIDATE_CAP=50;
const MEMBER_DISPLAY_STEP=100;
const GROUP_DISPLAY_STEP=60;

function loginOf(user:User):string{return user.login??"";}

function matchesQuery(user:User,needle:string):boolean{
 return user.displayName.toLowerCase().includes(needle)||loginOf(user).toLowerCase().includes(needle);
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

function IconGroup(){
 return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <rect x="2" y="3" width="12" height="10" rx="2"/>
  <path d="M6 8h4"/>
  <path d="M8 6v4"/>
 </svg>;
}

function IconPlus(){
 return <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <path d="M8 2v12M2 8h12"/>
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
 const activeTab=queryParams.get("tab")==="approvals"&&isAdmin?"approvals":queryParams.get("tab")==="roles"?"roles":queryParams.get("tab")==="permissions"?"permissions":queryParams.get("tab")==="groups"?"groups":"members";
 // The resource folder is shared across tabs; leaving a dirty editor requires consent.
 const[hasUnsavedChanges,setHasUnsavedChanges]=useState(false);
 const[discardDialogOpen,setDiscardDialogOpen]=useState(false);
 const pendingNavigation=useRef<(()=>void)|null>(null);
 const requestNavigation=useCallback((navigate:()=>void)=>{
  if(hasUnsavedChanges){pendingNavigation.current=navigate;setDiscardDialogOpen(true);}
  else navigate();
 },[hasUnsavedChanges]);
 const setActiveTab=(tab:"members"|"groups"|"permissions"|"roles"|"approvals")=>{
  if(tab===activeTab)return;
  requestNavigation(()=>setQueryParams(old=>{
   const next=new URLSearchParams(old);next.set("tab",tab);return next;
  }));
 };
 useEffect(()=>{
  if(!hasUnsavedChanges)return;
  const beforeUnload=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue="";};
  window.addEventListener("beforeunload",beforeUnload);
  return()=>window.removeEventListener("beforeunload",beforeUnload);
 },[hasUnsavedChanges]);
 const[selectedDepartment,setSelectedDepartment]=useState("");
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
 const[createFormOpen,setCreateFormOpen]=useState(false);
 const[resetTarget,setResetTarget]=useState<User|null>(null);
 const[stateTarget,setStateTarget]=useState<User|null>(null);
 const[removeTarget,setRemoveTarget]=useState<User|null>(null);
 const[createUserOpen,setCreateUserOpen]=useState(false);
 const[createDepartmentOpen,setCreateDepartmentOpen]=useState(false);
 const[createGroupOpen,setCreateGroupOpen]=useState(false);

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
 useEffect(()=>observeWorkspaceChange(()=>{
  setUsersToken(token=>token+1);setDepartmentsToken(token=>token+1);
  setGroupsToken(token=>token+1);setMembersToken(token=>token+1);
 },["organization","permissions"]),[]);

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

 const filteredGroups=useMemo(()=>{
  const keyword=groupQuery.trim().toLowerCase();
  return groups.filter(group=>{
   if(selectedDepartment==="__unassigned"){
    if(group.departmentId&&deptById.has(group.departmentId))return false;
   }else if(selectedDeptIds&&!selectedDeptIds.has(group.departmentId??""))return false;
   return keyword===""||group.name.toLowerCase().includes(keyword);
  });
 },[groups,groupQuery,selectedDepartment,selectedDeptIds,deptById]);
 useEffect(()=>{
  if(!filteredGroups.some(group=>group.id===selectedGroup))
   setSelectedGroup(filteredGroups[0]?.id??"");
 },[filteredGroups,selectedGroup]);
 useEffect(()=>setGroupLimit(GROUP_DISPLAY_STEP),[groupQuery,selectedDepartment]);
 useEffect(()=>setGroupMemberLimit(MEMBER_DISPLAY_STEP),[selectedGroup]);

 const selectedGroupRow=filteredGroups.find(g=>g.id===selectedGroup)??null;

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
  setCreateFormOpen(false);
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

 return <div className="work-body">
  {/* 顶部工具栏：指标摘要与全局快捷创建 */}
  <div className="toolbar">
   <span className="toolbar-hint">{`账号 ${users.length} · 部门 ${departments.length} · 工作组 ${groups.length}`}</span>
   <RareButton type="button" onClick={()=>{setNotice(null);setCreateDepartmentOpen(true);}}>
    <IconPlus/>新建部门
   </RareButton>
   <RareButton type="button" className="primary" tone="primary" onClick={()=>{setNotice(null);setCreateGroupOpen(true);}}>
    <IconPlus/>创建工作组
   </RareButton>
  </div>

  {notice&&<RareNotice tone={notice.tone==="error"?"danger":"info"}>{notice.text}</RareNotice>}

  {/* 双栏主工作台：左侧组织架构树 + 右侧主工作区卡片 */}
  <div className="org-workbench">
   <DepartmentNavigator departments={departments} departmentsState={departmentsState}
    deptIndex={deptIndex} deptById={deptById} deptCounts={deptCounts}
    selectedDepartment={selectedDepartment} onSelect={setSelectedDepartment}
    usersCount={users.length} unassignedCount={unassignedCount}
    onRetry={()=>setDepartmentsToken(token=>token+1)}/>

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
       <span className="org-tab-badge">{filteredGroups.length}</span>
      </RareButton>
      <RareButton type="button" role="tab" aria-selected={activeTab==="permissions"} tabIndex={activeTab==="permissions"?0:-1} id="org-tab-permissions" aria-controls="org-panel-permissions"
       className={"org-tab"+(activeTab==="permissions"?" active":"")}
       onClick={()=>setActiveTab("permissions")}>权限管理</RareButton>
      {isAdmin&&<RareButton type="button" role="tab" aria-selected={activeTab==="approvals"} tabIndex={activeTab==="approvals"?0:-1} id="org-tab-approvals" aria-controls="org-panel-approvals"
       className={"org-tab"+(activeTab==="approvals"?" active":"")} onClick={()=>setActiveTab("approvals")}>审批策略</RareButton>}
      <RareButton type="button" role="tab" aria-selected={activeTab==="roles"} tabIndex={activeTab==="roles"?0:-1} id="org-tab-roles" aria-controls="org-panel-roles"
       className={"org-tab"+(activeTab==="roles"?" active":"")}
       onClick={()=>setActiveTab("roles")}>管理角色</RareButton>
     </RareTabs>

     {/* 当前部门范围标识 */}
     {activeTab!=="permissions"&&activeTab!=="roles"&&activeTab!=="approvals"&&<div className="org-scope-badge">
      <span className="org-scope-dot" aria-hidden="true"/>
      <span>范围：{scopeLabel}</span>
      {selectedDepartment!==""&&<RareButton type="button" className="org-scope-reset"
       title="清除部门筛选，显示全体" onClick={()=>setSelectedDepartment("")}>✕</RareButton>}
     </div>}
    </div>

    {activeTab==="permissions"&&<div className="rare-tab-panel" role="tabpanel" id="org-panel-permissions" aria-labelledby="org-tab-permissions"><PermissionsPanel users={users} groups={groups}
     usersState={usersState} groupsState={groupsState}
     onRetryUsers={()=>setUsersToken(token=>token+1)}
     onRetryGroups={()=>setGroupsToken(token=>token+1)} onDirtyChange={setHasUnsavedChanges} requestNavigation={requestNavigation}/></div>}
    {activeTab==="approvals"&&<div className="rare-tab-panel" role="tabpanel" id="org-panel-approvals" aria-labelledby="org-tab-approvals">
     <ApprovalPoliciesPanel users={users} usersState={usersState} onRetryUsers={()=>setUsersToken(token=>token+1)} onDirtyChange={setHasUnsavedChanges} requestNavigation={requestNavigation}/></div>}
    {activeTab==="roles"&&<div className="rare-tab-panel" role="tabpanel" id="org-panel-roles" aria-labelledby="org-tab-roles"><RoleBindingsPanel users={users} onDirtyChange={setHasUnsavedChanges}/></div>}

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
      <RareButton type="button" className="primary org-add-member" onClick={()=>{setNotice(null);setCreateFormOpen(true);}}><IconPlus/>新增成员</RareButton>
     </div>

     {notice&&notice.tone==="error"&&usersState==="failed"&&<RareNotice tone="danger">{notice.text}</RareNotice>}

     {/* 成员数据表格 */}
     <div className="org-table-container">
      <RareDataTable className="org-members-table" aria-label="成员列表" aria-busy={usersState==="loading"?true:undefined}>
       <thead>
        <tr>
         <th scope="col">姓名</th>
         <th className="org-member-optional" scope="col">账号</th>
         <th className="org-member-optional" scope="col">部门</th>
         <th scope="col">状态</th>
         <th scope="col">操作</th>
        </tr>
       </thead>
       <tbody>
        {filteredMembers.slice(0,memberLimit).map(user=><tr key={user.id}>
         <td>
          <div className="org-user-cell">
           <span className="org-avatar" aria-hidden="true">{user.displayName.slice(0,1)}</span>
           <span className="org-user-name">{user.displayName}</span>
           <span className="org-member-mobile-meta" title={loginOf(user)}>{loginOf(user)||"—"} · {departmentLabel(user.departmentId)}</span>
          </div>
         </td>
         <td className="org-member-optional">
          <code className="org-user-login">{loginOf(user)||"—"}</code>
         </td>
         <td className="org-member-optional" title={user.departmentId&&!deptById.has(user.departmentId)?user.departmentId:undefined}>
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
         <td className="org-member-actions"><RareRowActions>
          <RareButton type="button" onClick={()=>{setNotice(null);setResetTarget(user);}}>重置密码</RareButton>
          {user.id===currentUserId
           ?<RareButton type="button" disabled title="不能对当前登录账号执行禁用">禁用</RareButton>
           :<RareButton type="button" tone={user.disabled===true?"neutral":"danger"} className={user.disabled===true?"org-btn-enable":"danger"}
             onClick={()=>{setNotice(null);setStateTarget(user);}}>{user.disabled===true?"启用":"禁用"}</RareButton>}
         </RareRowActions></td>
        </tr>)}
        {filteredMembers.length===0&&<tr><td colSpan={5} className="empty">{memberTableEmpty}</td></tr>}
       </tbody>
      </RareDataTable>
     </div>
     {filteredMembers.length>memberLimit&&<div className="org-list-more">
      <span className="hint">已显示 {memberLimit} / {filteredMembers.length} 位成员</span>
      <RareButton type="button" onClick={()=>setMemberLimit(limit=>limit+MEMBER_DISPLAY_STEP)}>
       显示更多成员
      </RareButton>
     </div>}


    </div>}
    {createFormOpen&&<Dialog open title="新增成员" className="org-create-user-dialog" initialFocus="#org-new-login" onClose={()=>setCreateFormOpen(false)}>
     <div className="org-create-user-card">
      <div className="org-create-user-head">
       <div className="org-create-user-title">
        <IconPlus/>
        <span>快速添加新成员</span>
       </div>
       <span className="hint">初始密码至少 16 位</span>
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
       <div className="dialog-actions org-create-form-actions"><RareButton type="button" onClick={()=>setCreateFormOpen(false)}>取消</RareButton>
        <RareButton className="primary" tone="primary" type="submit" disabled={!canCreateUser}>核对并创建</RareButton></div>
      </form>
     </div>
    </Dialog>}

    {/* Tab 2: 工作组管理（Master-Detail 双栏结构） */}
    {activeTab==="groups"&&<div className="org-groups-stage" role="tabpanel" id="org-panel-groups" aria-labelledby="org-tab-groups">
     {/* 左侧：工作组卡片列表 */}
     <div className="org-group-list-col">
      <div className="org-card-header">
       <h4 className="org-card-title">
        <IconGroup/>
        <span>工作组列表</span>
        <RareBadge className="org-count-pill" tone="neutral">{filteredGroups.length}</RareBadge>
       </h4>
      </div>

      <div className="org-search-box">
       <IconSearch/>
       <RareInput className="org-search" type="search" placeholder="搜索工作组..."
        value={groupQuery} onChange={e=>setGroupQuery(e.target.value)}/>
      </div>

       {groupsState==="loading"&&<p className="hint org-inline-message">正在读取工作组…</p>}
       {groupsState==="failed"&&<div className="org-inline-message">
       <RareNotice tone="danger">读取工作组列表失败。</RareNotice>
       <RareButton type="button" className="secondary-action" onClick={()=>setGroupsToken(t=>t+1)}>重试</RareButton>
      </div>}

       {groupsReady&&groups.length===0&&<p className="empty org-list-empty">暂无工作组，可使用顶部按钮创建。</p>}

      {groupsReady&&groups.length>0&&<ul className="org-group-cards-list">
       {filteredGroups.slice(0,groupLimit).map(group=>{
        const isSelected=group.id===selectedGroup;
        return <li key={group.id}>
         <RareButton type="button" className={"org-group-card"+(isSelected?" active":"")}
          aria-pressed={isSelected} onClick={()=>setSelectedGroup(group.id)}>
           <div className="org-group-card-header">
            <span className="org-group-name" title={group.name}>{group.name}</span>
            <RareBadge className="org-dept-pill" tone="neutral">{group.departmentId?departmentLabel(group.departmentId):"公共工作组"}</RareBadge>
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
        ?<div className="empty org-group-empty">请从左侧选择一个工作组以查看并配置成员。</div>
       :<>
        <div className="org-group-banner">
         <div className="org-group-banner-info">
          <h4 className="org-group-detail-title">{selectedGroupRow.name}</h4>
           <RareBadge className="org-dept-pill" tone="neutral">{selectedGroupRow.departmentId?departmentLabel(selectedGroupRow.departmentId):"公共工作组"}</RareBadge>
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
          {groupMembers.slice(0,groupMemberLimit).map(member=><WorkgroupMemberRow key={member.id}
           user={member} kind="member" onAction={()=>{setNotice(null);setRemoveTarget(member);}}/>)}
          {groupMembers.length===0&&<p className="empty org-grid-empty">该工作组暂无成员，可在下方添加成员。</p>}
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
           <div className="org-search-box org-candidate-search">
            <IconSearch/>
            <RareInput className="org-search" type="search" aria-label="搜索可加入的账号" autoComplete="off"
             placeholder="按姓名或账号搜索可加入的账号" value={candidateQuery} onChange={event=>setCandidateQuery(event.target.value)}/>
           </div>

           <div className="org-candidate-grid">
            {candidates.map(user=><WorkgroupMemberRow key={user.id} user={user} kind="candidate"
             department={departmentLabel(user.departmentId)} busy={addBusy!==""}
             onAction={()=>addMember(user)}/>)}
             {candidates.length===0&&<p className="empty org-grid-empty">{candidateEmpty}</p>}
           </div>

           {candidates.length>=CANDIDATE_CAP&&<p className="hint">最多显示 {CANDIDATE_CAP} 个候选账号，继续输入可缩小范围。</p>}
          </>}
        </div>
       </>}
     </div>
    </div>}
   </section>
  </div>

  <Dialog open={discardDialogOpen} title="未保存的修改" className="org-dialog"
   onClose={()=>{pendingNavigation.current=null;setDiscardDialogOpen(false);}}>
   <p>当前编辑尚未保存。离开后将丢弃这些修改。</p>
   <div className="dialog-actions">
    <RareButton type="button" onClick={()=>{pendingNavigation.current=null;setDiscardDialogOpen(false);}}>继续编辑</RareButton>
    <RareButton type="button" className="danger" tone="danger" onClick={()=>{
     const next=pendingNavigation.current;
     pendingNavigation.current=null;setDiscardDialogOpen(false);setHasUnsavedChanges(false);
     next?.();
    }}>放弃修改并离开</RareButton>
   </div>
  </Dialog>
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
   onClose={()=>{setCreateUserOpen(false);if(newUser.login.trim())setCreateFormOpen(true);}} onSubmit={createUser}/>}
  {createDepartmentOpen&&<CreateDepartmentDialog options={departmentOptions} defaultParentId={deptFilter}
   listAvailable={departmentsReady}
   onClose={()=>setCreateDepartmentOpen(false)} onSubmit={createDepartment}/>}
  {createGroupOpen&&<CreateGroupDialog options={departmentOptions} defaultDepartmentId={deptFilter}
   listAvailable={departmentsReady}
   onClose={()=>setCreateGroupOpen(false)} onSubmit={createGroup}/>}
 </div>;
}
