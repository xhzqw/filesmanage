import {useEffect,useMemo,useRef,useState,type FormEvent,type KeyboardEvent,type ReactNode} from "react";
import {organizationApi,type Department,type Workgroup} from "./api";
import {errorCode,errorCopy} from "../../shared/errors";
import {Dialog} from "../../shared/ui/Dialog";
import type {User} from "../../entities/user/model";
import "./organization.css";

type LoadState="loading"|"ready"|"failed";
type Tone="info"|"error";
type Notice={text:string;tone:Tone};
// 对话框只报告服务端确认过的结果：ok 是服务端受理后的真实文案，error 让对话框保持打开可重试
// （DESKTOP-INTERACTION-v1 §4.1 第 4 条）。
type DialogResult={ok:string}|{error:string};
type DeptRow={department:Department;depth:number};

// 与目录树一致的深度上限：异常数据（父子成环）下渲染与键盘行走一起停住
const MAX_DEPTH=32;
// 添加成员候选一次最多渲染 50 行，长账号列表不整表 mount（DESKTOP-INTERACTION-v1 §5 同一取舍）
const CANDIDATE_CAP=50;
const DEPT_HIT_CAP=30;
// 服务端 GET /users、/departments、/groups 的单次上限（ListUsers/ListDepartments/ListWorkgroups LIMIT 1000）
const LIST_CAP=1000;

function loginOf(user:User):string{return user.login??"";}

function matchesQuery(user:User,needle:string):boolean{
 return user.displayName.toLowerCase().includes(needle)||loginOf(user).toLowerCase().includes(needle);
}

// 可见祖先路径（不含自身）：祖先不在可见集合时绝不臆造（DESKTOP-INTERACTION-v1 §5）
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

// 组织写入的统一错误文案。E_NETWORK 说明结果未知（调用方随即重读服务端状态），
// 其余分支只描述服务端已确认的拒绝，绝不把失败说成成功（DESKTOP-INTERACTION-v1 §8）。
function mutationCopy(error:unknown,fallback:string):string{
 const code=errorCode(error);
 if(code==="E_NETWORK")return "网络中断，无法确认操作是否已提交；请以列表最新状态为准。";
 if(code==="E_PASSWORD_POLICY")return "服务端密码策略拒绝了该密码：请使用 16–128 个字符的新初始密码。";
 if(code==="E_FORBIDDEN")return "没有执行该操作的权限（服务端拒绝）。";
 if(code==="E_NOT_FOUND")return "服务端已找不到该记录（账号可能已删除或状态已变化），列表已重新读取。";
 if(code==="E_BAD")return "服务端拒绝了本次请求（参数无效或不允许该状态变更）。";
 if(code==="E_NAME_CONFLICT")return "名称已存在，请更换。";
 return errorCopy(error,fallback);
}

// 组织工作台（COMPLEX-WORKFLOWS-v1 §9 组织行、UX-ACCEPTANCE WF-32）：部门树 + 工作组/成员详情
// + 可搜索选择；重置密码、禁用/启用、移除成员等危险管理操作一律走真实模态 Dialog 确认。
// 前端能力提示（isAdmin、按钮可用性）不是授权证据，每个写入都由服务端重新判定。
export function OrganizationPanel({isAdmin,currentUserId}:{isAdmin:boolean;currentUserId:string}){
 const[users,setUsers]=useState<User[]>([]);
 const[departments,setDepartments]=useState<Department[]>([]);
 const[groups,setGroups]=useState<Workgroup[]>([]);
 // 三个数据源各自成败：一个失败不掩盖其他面板的真实数据，也不用空表冒充“没有数据”
 const[usersState,setUsersState]=useState<LoadState>("loading");
 const[departmentsState,setDepartmentsState]=useState<LoadState>("loading");
 const[groupsState,setGroupsState]=useState<LoadState>("loading");
 const[usersToken,setUsersToken]=useState(0);
 const[departmentsToken,setDepartmentsToken]=useState(0);
 const[groupsToken,setGroupsToken]=useState(0);
 const[notice,setNotice]=useState<Notice|null>(null);
 const[selectedDepartment,setSelectedDepartment]=useState("");
 const[deptQuery,setDeptQuery]=useState("");
 const[expanded,setExpanded]=useState<Set<string>>(()=>new Set<string>());
 const[focusedId,setFocusedId]=useState<string|null>(null);
 const[memberQuery,setMemberQuery]=useState("");
 const[selectedGroup,setSelectedGroup]=useState("");
 const[groupMembers,setGroupMembers]=useState<User[]>([]);
 const[membersState,setMembersState]=useState<LoadState>("loading");
 const[membersToken,setMembersToken]=useState(0);
 const[candidateQuery,setCandidateQuery]=useState("");
 const[addBusy,setAddBusy]=useState("");
 const[newUser,setNewUser]=useState({login:"",displayName:"",password:"",departmentId:""});
 const[resetTarget,setResetTarget]=useState<User|null>(null);
 const[stateTarget,setStateTarget]=useState<User|null>(null);
 const[removeTarget,setRemoveTarget]=useState<User|null>(null);
 const[createUserOpen,setCreateUserOpen]=useState(false);
 const[createDepartmentOpen,setCreateDepartmentOpen]=useState(false);
 const[createGroupOpen,setCreateGroupOpen]=useState(false);
 const rootsExpanded=useRef(false);

 // 非管理员不发组织请求：这些端点在服务端是 admin-only，前端提示不构成授权依据
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

 // 首次拿到部门数据时展开顶层部门，之后尊重用户的折叠状态
 useEffect(()=>{
  if(departments.length===0||rootsExpanded.current)return;
  rootsExpanded.current=true;
  const ids=new Set(departments.map(department=>department.id));
  setExpanded(new Set(departments.filter(d=>d.parentId===null||!ids.has(d.parentId)).map(d=>d.id)));
 },[departments]);

 // 默认选中第一个工作组，与改造前的面板行为一致
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

 const deptById=useMemo(()=>new Map(departments.map(department=>[department.id,department])),[departments]);
 // parentId→children 索引只建一次：渲染与计数都不在子数组上反复 filter（DESKTOP-INTERACTION-v1 §5）
 const deptIndex=useMemo(()=>{
  const ids=new Set(departments.map(department=>department.id));
  const childrenOf=new Map<string,Department[]>();
  for(const department of departments){
   const key=department.parentId!==null&&ids.has(department.parentId)?department.parentId:"";
   const list=childrenOf.get(key);
   if(list)list.push(department);else childrenOf.set(key,[department]);
  }
  return childrenOf;
 },[departments]);
 const departmentLabel=(id:string|undefined):string=>departmentLabelOf(deptById,id);
 const departmentOptions=useMemo(
  ()=>departments.map(department=>({id:department.id,label:fullPathOf(deptById,department.id)})),
  [departments,deptById]);

 // 选中部门的整棵子树（由 parentId 索引一次展开）：成员筛选按“本部门及其全部子部门”
 const selectedDeptIds=useMemo(()=>{
  if(selectedDepartment==="")return null;
  const out=new Set<string>();
  const walk=(id:string)=>{
   if(out.has(id))return;
   out.add(id);
   for(const child of deptIndex.get(id)??[])walk(child.id);
  };
  walk(selectedDepartment);
  return out;
 },[selectedDepartment,deptIndex]);

 // 行内人数 = 本部门及全部子部门人数，与选择后的筛选范围一致；visiting 防成环数据无限递归
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
  for(const department of departments)sum(department.id);
  return totals;
 },[users,departments,deptIndex]);

 // 可见行（展平）：键盘只在这份列表上行走；seen 让渲染与行走的可见集合保持一致
 const rows=useMemo(()=>{
  const out:DeptRow[]=[];
  const seen=new Set<string>();
  const walk=(parentId:string,depth:number)=>{
   if(depth>MAX_DEPTH)return;
   for(const department of deptIndex.get(parentId)??[]){
    if(seen.has(department.id))continue;
    seen.add(department.id);
    out.push({department,depth});
    if(expanded.has(department.id))walk(department.id,depth+1);
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

 // 部门数据不可用时不做筛选：成员列表退回全部账号，并在面板里明确说明原因
 const deptFilter=departmentsState==="ready"?selectedDepartment:"";
 const activeDeptIds=deptFilter!==""?selectedDeptIds:null;
 const needle=memberQuery.trim().toLowerCase();
 const filteredMembers=useMemo(
  ()=>users.filter(user=>{
   if(activeDeptIds&&!activeDeptIds.has(user.departmentId??""))return false;
   if(needle==="")return true;
   return matchesQuery(user,needle);
  }),
  [users,activeDeptIds,needle]);

 const deptHits=useMemo(()=>{
  const keyword=deptQuery.trim().toLowerCase();
  if(keyword==="")return{items:[] as Department[],truncated:false};
  const matched=departments.filter(department=>department.name.toLowerCase().includes(keyword));
  return{items:matched.slice(0,DEPT_HIT_CAP),truncated:matched.length>DEPT_HIT_CAP};
 },[departments,deptQuery]);

 const selectedGroupRow=groups.find(group=>group.id===selectedGroup)??null;
 const candidates=useMemo(()=>{
  const keyword=candidateQuery.trim().toLowerCase();
  const current=new Set(groupMembers.map(member=>member.id));
  // 已禁用账号不进入新成员候选（与授权对话框同一取舍）；成员列表里仍显示并标注
  return users
   .filter(user=>user.disabled!==true&&!current.has(user.id)&&(keyword===""||matchesQuery(user,keyword)))
   .slice(0,CANDIDATE_CAP);
 },[users,groupMembers,candidateQuery]);

 const canCreateUser=
  newUser.login.trim()!==""&&newUser.displayName.trim()!==""&&newUser.password.length>=16;

 // 变更成功后重新读取服务端列表；刷新失败单独反馈，不否定已提交的写入（DESKTOP-INTERACTION-v1 §8）。
 // 刷新失败时清掉旧列表：面板只剩显式错误态与重试，不把可能过期的管理数据当成当前事实。
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

 // 返回是否刷新成功：调用方据此决定“已提交”的成功文案是否还能覆盖失败文案（§8 分别反馈）
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

 // 键盘漫游（DESKTOP-INTERACTION-v1 §5）：方向键在可见节点间移动，Right 展开/进入首个子项，
 // Left 折叠/回到父项，Enter/空格激活部门即筛选成员；名称按钮只选择，chevron 只展开/折叠。
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

 // 搜索结果选择：展开可见祖先链再筛选该部门，祖先不臆造
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
  setNotice({tone:"info",text:`已创建账号 ${login}（${displayName}），首次登录必须修改初始密码。`});
  await refreshUsers(`已创建账号 ${login}，但用户列表刷新失败，请点击列表中的重试。`);
  return{ok:`已创建账号 ${login}（${displayName}），首次登录必须修改初始密码。`};
 }

 async function resetPassword(password:string):Promise<DialogResult>{
  const target=resetTarget;
  if(!target)return{error:"目标账号已变化，请重新打开对话框。"};
  try{
   await organizationApi.resetPassword(target.id,password);
  }catch(error){
   const code=errorCode(error);
   // 结果未知或记录已变：重读用户列表，用“待改密”标记让最终状态可核对
   if(code==="E_NETWORK"||code==="E_NOT_FOUND")
    await refreshUsers(`重置 ${loginOf(target)} 密码的结果未确认，用户列表刷新失败，请重试。`);
   return{error:mutationCopy(error,"重置密码失败")};
  }
  setNotice({tone:"info",text:`已重置 ${loginOf(target)} 的初始密码；其全部会话已失效，下次登录必须修改密码。`});
  await refreshUsers(`已重置 ${loginOf(target)} 的密码，但用户列表刷新失败，请点击列表中的重试。`);
  return{ok:`已重置 ${loginOf(target)} 的初始密码；服务端已失效其全部登录会话，下次登录必须修改密码。`};
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
   // 成员关系已存在时服务端当前实现会落到 E_INTERNAL；这类失败也重读成员列表，
   // 让界面显示服务端事实而不是猜测
   if(code==="E_NETWORK"||code==="E_NOT_FOUND"||code==="E_INTERNAL"||code==="E_NAME_CONFLICT")
    await refreshMembers("添加成员未成功，工作组成员刷新失败，请重试。");
   setNotice({tone:"error",text:code==="E_INTERNAL"||code==="E_NAME_CONFLICT"
    ?"服务端未接受该成员变更；已重新读取成员列表，请确认该账号是否已在工作组中。"
    :mutationCopy(error,"添加成员失败")});
   setAddBusy("");
   return;
  }
  setAddBusy("");
  // 刷新失败时 refreshMembers 已写好“已提交但刷新失败”的错误文案，成功文案不再覆盖它
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
  return <p role="status" className="notice">组织管理仅系统管理员可用：当前账号没有用户、部门与工作组的管理权限。</p>;

 const usersReady=usersState==="ready";
 const departmentsReady=departmentsState==="ready";
 const groupsReady=groupsState==="ready";
 const memberEmpty=users.length===0
  ?"还没有账号。"
  :needle!==""
   ?"没有匹配的成员（按姓名或账号搜索）。"
   :deptFilter!==""
    ?"该部门（含子部门）暂无成员。"
    :"没有成员。";
 const scopeText=departmentsState==="failed"
  ?"范围：全部账号（部门数据不可用，暂不能按部门筛选）"
  :deptFilter===""
   ?"范围：全部账号"
   :"范围："+departmentLabel(deptFilter)+"（含全部子部门）";
 const candidateEmpty=!usersReady
  ?"账号列表不可用，无法选择成员。"
  :candidateQuery.trim()!==""
   ?"没有匹配的可加入账号。"
   :"所有可用账号都已在该工作组中。";
 // 加载中/失败时表格仍渲染：表格行自己说明真实状态，不冒充“没有数据”
 const memberTableEmpty=usersState==="loading"
  ?"正在读取用户…"
  :usersState==="failed"
   ?"用户列表读取失败，请先用上方的重试按钮。"
   :memberEmpty;

 // 树内渲染与 rows 使用同一 seen 规则，异常环数据下两者的可见集合保持一致
 const rendered=new Set<string>();
 function renderDeptNodes(parentId:string,depth:number):ReactNode{
  if(depth>MAX_DEPTH)return null;
  return (deptIndex.get(parentId)??[]).map(department=>{
   if(rendered.has(department.id))return null;
   rendered.add(department.id);
   const isOpen=expanded.has(department.id);
   const hasChildren=(deptIndex.get(department.id)??[]).length>0;
   const count=deptCounts.get(department.id)??0;
   return <li key={department.id} data-dept-id={department.id} role="treeitem"
    aria-expanded={hasChildren?isOpen:undefined}
    aria-selected={selectedDepartment===department.id}
    tabIndex={focusedId===department.id||(focusedId===null&&rows[0]?.department.id===department.id)?0:-1}
    onFocus={event=>{if(event.target===event.currentTarget)setFocusedId(department.id);}}>
    <div className={"tree-row "+(selectedDepartment===department.id?"on":"")} style={{paddingLeft:String(depth*16)+"px"}}>
     {hasChildren
      ?<button type="button" aria-label={(isOpen?"折叠":"展开")+" "+department.name} tabIndex={-1}
        onClick={()=>toggle(department.id)}>{isOpen?"▾":"▸"}</button>
      :<span className="tree-chevron-spacer" aria-hidden="true"/>}
     <button type="button" className="org-node-label" tabIndex={-1}
      title={fullPathOf(deptById,department.id)+"｜含子部门 "+String(count)+" 人"}
      onClick={()=>setSelectedDepartment(department.id)}>
      {department.name}<span className="org-node-count">（{count}）</span>
     </button>
    </div>
    {isOpen&&<ul role="group">{renderDeptNodes(department.id,depth+1)}</ul>}
   </li>;
  });
 }

 return <div className="work-body">
  <div className="toolbar">
   <span className="toolbar-hint">账号 {users.length} · 部门 {departments.length} · 工作组 {groups.length}</span>
   <button type="button" onClick={()=>{setNotice(null);setCreateDepartmentOpen(true);}}>新建部门</button>
   <button type="button" className="primary" onClick={()=>{setNotice(null);setCreateGroupOpen(true);}}>创建工作组</button>
  </div>
  {notice&&<p role={notice.tone==="error"?"alert":"status"} className={"notice"+(notice.tone==="error"?" error":"")}>{notice.text}</p>}
  <div className="org-columns org-workbench">
   <section className="table org-dept-pane">
    <h3>部门</h3>
    {departmentsState==="loading"&&<p className="hint">正在读取部门…</p>}
    {departmentsState==="failed"&&<>
     <p role="alert" className="notice error">读取部门失败（GET /api/departments），部门树与按部门筛选不可用。</p>
     <button type="button" className="secondary-action" onClick={()=>setDepartmentsToken(token=>token+1)}>重试</button>
    </>}
    {departmentsReady&&<>
     <ul className="group-list">
      <li><button type="button" className={selectedDepartment===""?"on":""} aria-pressed={selectedDepartment===""}
       onClick={()=>setSelectedDepartment("")}>全部用户（{users.length}）</button></li>
     </ul>
     <label className="hint" htmlFor="org-dept-search">查找部门</label>
     <input id="org-dept-search" className="org-search" type="search" autoComplete="off"
      value={deptQuery} onChange={event=>setDeptQuery(event.target.value)} placeholder="按部门名称查找"/>
     {deptQuery.trim()!==""&&<div className="org-hits-panel">
      {deptHits.items.length===0
       ?<p className="hint">没有匹配的部门。</p>
       :<ul className="org-hits">
        {deptHits.items.map(department=><li key={department.id}>
         <button type="button" aria-label={"选择部门 "+fullPathOf(deptById,department.id)}
          onClick={()=>revealDepartment(department.id)}>
          <span className="org-hit-name">{department.name}</span>
          <span className="hint">{ancestorPathOf(deptById,department.id)||"顶层部门"}</span>
         </button>
        </li>)}
       </ul>}
      {deptHits.truncated&&<p className="hint">结果较多，仅显示前 {deptHits.items.length} 个，请细化关键词。</p>}
     </div>}
     <ul className="tree" role="tree" aria-label="部门树" onKeyDown={onTreeKeyDown}>
      {departments.length===0&&<li role="none" className="hint">还没有部门；可用工具栏的“新建部门”创建。</li>}
      {renderDeptNodes("",0)}
     </ul>
     <p className="hint">单击部门名筛选其成员，chevron 只展开/折叠；括号内人数含全部子部门。未分配部门的账号只在“全部用户”中出现。</p>
    </>}
   </section>

   <section className="table org-member-pane">
    <h3>成员（{filteredMembers.length}{filteredMembers.length!==users.length?` / ${users.length}`:""}）</h3>
    {usersState==="loading"&&<p className="hint">正在读取用户…</p>}
    {usersState==="failed"&&<>
     <p role="alert" className="notice error">读取用户失败（GET /api/users），成员列表与按部门筛选不可用。</p>
     <button type="button" className="secondary-action" onClick={()=>setUsersToken(token=>token+1)}>重试</button>
    </>}
    {usersReady&&departmentsState==="failed"&&<p role="alert" className="notice error">部门数据不可用，成员列表暂不能按部门筛选。</p>}
    {usersReady&&<>
     <input className="org-search" type="search" aria-label="搜索成员" autoComplete="off"
      placeholder="按姓名或账号搜索成员" value={memberQuery} onChange={event=>setMemberQuery(event.target.value)}/>
     <p className="hint org-scope">{scopeText}{memberQuery.trim()!==""?`；关键词“${memberQuery.trim()}”`:""}</p>
    </>}
    <table aria-label="成员列表" aria-busy={usersState==="loading"?true:undefined}>
     <thead><tr><th scope="col">姓名</th><th scope="col">账号</th><th scope="col">部门</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead>
     <tbody>
      {filteredMembers.map(user=><tr key={user.id}>
       <td>{user.displayName}</td>
       <td>{loginOf(user)||"—"}</td>
       <td title={user.departmentId&&!deptById.has(user.departmentId)?user.departmentId:undefined}>{departmentLabel(user.departmentId)}</td>
       <td><span className="org-badges">
        {user.isAdmin&&<span className="org-badge org-badge-admin">系统管理员</span>}
        {user.disabled===true&&<span className="org-badge org-badge-disabled"
         title="账号已禁用：无法登录，现有会话已失效；其工作组与授权记录仍保留。">已禁用</span>}
        {user.mustChangePassword&&<span className="org-badge org-badge-warning"
         title="该账号下次登录必须修改密码（初始密码或刚被重置）。">待改密</span>}
        {user.disabled!==true&&!user.mustChangePassword&&<span className="org-badge">正常</span>}
       </span></td>
       <td className="row-actions">
        <button type="button" onClick={()=>{setNotice(null);setResetTarget(user);}}>重置密码</button>
        {user.id===currentUserId
         ?<button type="button" disabled title="不能对当前登录账号执行禁用">禁用</button>
         :<button type="button" className={user.disabled===true?"":"danger"}
           onClick={()=>{setNotice(null);setStateTarget(user);}}>{user.disabled===true?"启用":"禁用"}</button>}
       </td>
      </tr>)}
      {filteredMembers.length===0&&<tr><td colSpan={5} className="empty">{memberTableEmpty}</td></tr>}
     </tbody>
    </table>
    {usersReady&&users.length>=LIST_CAP&&<p className="hint">服务端单次最多返回 {LIST_CAP} 个账号，列表可能未显示全部。</p>}
    <form className="inline-form org-form" onSubmit={submitCreateUser}>
     <input aria-label="新账号" placeholder="新账号" value={newUser.login}
      onChange={event=>setNewUser(prev=>({...prev,login:event.target.value}))}/>
     <input aria-label="姓名" placeholder="姓名" value={newUser.displayName}
      onChange={event=>setNewUser(prev=>({...prev,displayName:event.target.value}))}/>
     <input aria-label="初始密码" placeholder="初始密码（≥16 位）" type="password" autoComplete="new-password" value={newUser.password}
      onChange={event=>setNewUser(prev=>({...prev,password:event.target.value}))}/>
     <select className="org-select" aria-label="部门" value={newUser.departmentId}
      onChange={event=>setNewUser(prev=>({...prev,departmentId:event.target.value}))}>
      <option value="">未分配部门</option>
      {departmentOptions.map(option=><option key={option.id} value={option.id}>{option.label}</option>)}
     </select>
     <button className="primary" type="submit" disabled={!canCreateUser}>创建用户</button>
    </form>
    <p className="hint">点“创建用户”会先在对话框中确认账号、姓名与部门；新账号为普通账号（本面板不提供管理员角色授予），首次登录必须修改初始密码。</p>
   </section>

   <section className="table org-group-pane">
    <h3>工作组（{groups.length}）</h3>
    {groupsState==="loading"&&<p className="hint">正在读取工作组…</p>}
    {groupsState==="failed"&&<>
     <p role="alert" className="notice error">读取工作组失败（GET /api/groups），工作组与成员不可用。</p>
     <button type="button" className="secondary-action" onClick={()=>setGroupsToken(token=>token+1)}>重试</button>
    </>}
    {groupsReady&&groups.length===0&&<p className="hint">还没有工作组；可用工具栏的“创建工作组”新建。</p>}
    {groupsReady&&groups.length>0&&<>
     <ul className="group-list">
      {groups.map(group=><li key={group.id}>
       <button type="button" className={group.id===selectedGroup?"on":""} aria-pressed={group.id===selectedGroup}
        onClick={()=>setSelectedGroup(group.id)}>
        {group.name}{group.departmentId&&<span className="hint">（{departmentLabel(group.departmentId)}）</span>}
       </button>
      </li>)}
     </ul>
     {selectedGroupRow===null
      ?<p className="hint">选择一个工作组查看成员。</p>
      :<>
       <h3>成员 — {selectedGroupRow.name}</h3>
       {membersState==="loading"&&<p className="hint">正在读取工作组成员…</p>}
       {membersState==="failed"&&<>
        <p role="alert" className="notice error">读取工作组成员失败（GET /api/groups/:id/members）。</p>
        <button type="button" className="secondary-action" onClick={()=>setMembersToken(token=>token+1)}>重试</button>
       </>}
       {membersState==="ready"&&<>
        <ul className="member-list">
         {groupMembers.map(member=><li key={member.id}>
          <span className="org-member-name">{member.displayName}（{loginOf(member)}）
           {member.disabled===true&&<span className="org-badge org-badge-disabled" title="账号已禁用：无法登录，但成员关系仍保留。">已禁用</span>}
          </span>
          <button type="button" className="danger" onClick={()=>{setNotice(null);setRemoveTarget(member);}}>移除</button>
         </li>)}
         {groupMembers.length===0&&<li className="empty">该工作组暂无成员。</li>}
        </ul>
        <h3>添加成员</h3>
        {!usersReady
         ?<p className="hint">{usersState==="loading"?"正在读取可选择的账号…":"账号列表不可用，无法选择新成员。"}</p>
         :<>
          <input className="org-search" type="search" aria-label="搜索可加入的账号" autoComplete="off"
           placeholder="按姓名或账号搜索可加入的账号" value={candidateQuery} onChange={event=>setCandidateQuery(event.target.value)}/>
          <p className="hint">数据源：GET /api/users；已禁用账号不出现在候选列表。</p>
          <ul className="member-list">
           {candidates.map(user=><li key={user.id}>
            <span className="org-member-name">{user.displayName}（{loginOf(user)}）</span>
            <button type="button" onClick={()=>addMember(user)} disabled={addBusy!==""}>
             {addBusy===user.id?"加入中…":"加入"}
            </button>
           </li>)}
           {candidates.length===0&&<li className="empty">{candidateEmpty}</li>}
          </ul>
          {candidates.length>=CANDIDATE_CAP&&<p className="hint">最多显示 {CANDIDATE_CAP} 个候选账号，继续输入可缩小范围。</p>}
         </>}
       </>}
      </>}
    </>}
   </section>
  </div>

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

// 重置密码：替换原先的 window.prompt（COMPLEX-WORKFLOWS-v1 §9 组织行）。
// 客户端只校验长度与空值，密码策略由服务端判定；busy 期间禁止重复提交与关闭，结果与错误都在对话框内报告。
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
   // 成功后立即丢掉对话框里的明文密码，只保留服务端确认过的结果文案
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
     <button type="button" className="secondary-action" onClick={()=>setConfirmDiscard(false)} disabled={busy}>继续编辑</button>
     <button type="button" className="danger" onClick={onClose} disabled={busy}>放弃并关闭</button>
    </div>
   </>
   :result
    ?<>
     <p role={result.tone==="error"?"alert":"status"} className={"notice"+(result.tone==="error"?" error":"")}>{result.text}</p>
     <div className="dialog-actions"><button type="button" className="primary" onClick={onClose} autoFocus>关闭</button></div>
    </>
    :<form onSubmit={submit}>
     <p>账号：{loginOf(target)||"—"}</p>
     <p>部门：{department}</p>
     {target.disabled===true&&<p className="hint">该账号当前已禁用：重置密码不会启用账号。</p>}
     <p className="hint">提交后服务端立即失效该账号的全部登录会话，并要求其下次登录修改密码。</p>
     <label htmlFor="org-reset-password">新初始密码</label>
     <input id="org-reset-password" type="password" autoComplete="new-password" value={password}
      onChange={event=>setPassword(event.target.value)} disabled={busy}/>
     <p className="hint">至少 16 个字符（客户端只校验长度，密码策略以服务端判定为准）。</p>
     <div className="dialog-actions">
      <button type="button" className="secondary-action" onClick={requestClose} disabled={busy}>取消</button>
      <button type="submit" className="primary" disabled={busy||password.length<16}>{busy?"重置中…":"确认重置密码"}</button>
     </div>
    </form>}
 </Dialog>;
}

// 禁用/启用确认：说明账号、当前状态与影响，busy 互斥，成功后列表刷新（WF-32“禁用确认可理解”）
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
    <p role={result.tone==="error"?"alert":"status"} className={"notice"+(result.tone==="error"?" error":"")}>{result.text}</p>
    <div className="dialog-actions"><button type="button" className="primary" onClick={onClose} autoFocus>关闭</button></div>
   </>
   :<form onSubmit={event=>{event.preventDefault();run();}}>
    <p>账号：{loginOf(target)||"—"}（{target.displayName}）</p>
    <p>部门：{department}</p>
    <p>当前状态：{target.disabled===true?"已禁用":target.mustChangePassword?"待改密":"正常"}</p>
    <p>{disabling
     ?"影响：禁用后该账号立即无法登录，现有登录会话立即失效；其工作组与授权记录保留，启用后恢复。该操作写入审计日志。"
     :"影响：启用后该账号可再次登录，并恢复原有的工作组与授权（最终生效权限由服务端判定）。"}</p>
    <div className="dialog-actions">
     <button type="button" className="secondary-action" onClick={onClose} disabled={busy}>取消</button>
     <button type="submit" className={disabling?"danger":"primary"} disabled={busy}>
      {busy?(disabling?"禁用中…":"启用中…"):(disabling?"确认禁用":"确认启用")}
     </button>
    </div>
   </form>}
 </Dialog>;
}

// 移除工作组成员：破坏性操作，确认对话框说明影响面后提交
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
    <p role={result.tone==="error"?"alert":"status"} className={"notice"+(result.tone==="error"?" error":"")}>{result.text}</p>
    <div className="dialog-actions"><button type="button" className="primary" onClick={onClose} autoFocus>关闭</button></div>
   </>
   :<form onSubmit={event=>{event.preventDefault();run();}}>
    <p>工作组：{groupName||"—"}</p>
    <p>成员：{member.displayName}（{loginOf(member)||"—"}）</p>
    <p>部门：{department}</p>
    <p>影响：移除后该账号不再通过本工作组获得授权；直接授予该账号的权限不受影响，最终生效权限由服务端判定。之后可以重新加入。</p>
    <div className="dialog-actions">
     <button type="button" className="secondary-action" onClick={onClose} disabled={busy}>取消</button>
     <button type="submit" className="danger" disabled={busy}>{busy?"移除中…":"确认移除"}</button>
    </div>
   </form>}
 </Dialog>;
}

// 创建账号确认：凭据相关动作先在对话框里确认账号、姓名与部门，密码不回显
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
    <p role={result.tone==="error"?"alert":"status"} className={"notice"+(result.tone==="error"?" error":"")}>{result.text}</p>
    <div className="dialog-actions"><button type="button" className="primary" onClick={onClose} autoFocus>关闭</button></div>
   </>
   :<form onSubmit={event=>{event.preventDefault();run();}}>
    <p>账号：{draft.login}</p>
    <p>姓名：{draft.displayName}</p>
    <p>部门：{department}</p>
    <p className="hint">初始密码按表单输入提交，不会在界面回显；该账号为普通账号，首次登录必须修改初始密码。</p>
    <p className="hint">取消不会清空表单内容，可以修改后再提交。</p>
    <div className="dialog-actions">
     <button type="button" className="secondary-action" onClick={onClose} disabled={busy}>返回修改</button>
     <button type="submit" className="primary" disabled={busy}>{busy?"创建中…":"确认创建"}</button>
    </div>
   </form>}
 </Dialog>;
}

// 创建部门：上级部门可选（默认当前筛选的部门），不创建成员或工作组
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
    <p role={result.tone==="error"?"alert":"status"} className={"notice"+(result.tone==="error"?" error":"")}>{result.text}</p>
    <div className="dialog-actions"><button type="button" className="primary" onClick={onClose} autoFocus>关闭</button></div>
   </>
   :<form onSubmit={run}>
    <label htmlFor="org-new-department">部门名称</label>
    <input id="org-new-department" value={name} maxLength={80} disabled={busy}
     onChange={event=>setName(event.target.value)}/>
    <label htmlFor="org-new-department-parent">上级部门</label>
    <select id="org-new-department-parent" className="org-select" value={parentId} disabled={busy}
     onChange={event=>setParentId(event.target.value)}>
     <option value="">（顶层部门）</option>
     {options.map(option=><option key={option.id} value={option.id}>{option.label}</option>)}
    </select>
    <p className="hint">{listAvailable
     ?"默认挂在部门树当前筛选的部门下（未选择时为顶层部门），可更改。"
     :"部门列表不可用，只能创建顶层部门。"}名称最多 80 个字符；成员与工作组需要另行指派。</p>
    <div className="dialog-actions">
     <button type="button" className="secondary-action" onClick={onClose} disabled={busy}>取消</button>
     <button type="submit" className="primary" disabled={busy||name.trim()===""}>{busy?"创建中…":"创建部门"}</button>
    </div>
   </form>}
 </Dialog>;
}

// 创建工作组：部门归属可选（默认当前筛选的部门）；成员在创建后另行维护
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
    <p role={result.tone==="error"?"alert":"status"} className={"notice"+(result.tone==="error"?" error":"")}>{result.text}</p>
    <div className="dialog-actions"><button type="button" className="primary" onClick={onClose} autoFocus>关闭</button></div>
   </>
   :<form onSubmit={run}>
    <label htmlFor="org-new-group">工作组名称</label>
    <input id="org-new-group" value={name} maxLength={80} disabled={busy}
     onChange={event=>setName(event.target.value)}/>
    <label htmlFor="org-new-group-department">所属部门</label>
    <select id="org-new-group-department" className="org-select" value={departmentId} disabled={busy}
     onChange={event=>setDepartmentId(event.target.value)}>
     <option value="">（不指定部门）</option>
     {options.map(option=><option key={option.id} value={option.id}>{option.label}</option>)}
    </select>
    <p className="hint">{listAvailable
     ?"默认使用部门树当前筛选的部门（未选择时留空），可更改。"
     :"部门列表不可用，只能创建不指定部门的工作组。"}名称最多 80 个字符；成员在创建后于“添加成员”中维护。</p>
    <div className="dialog-actions">
     <button type="button" className="secondary-action" onClick={onClose} disabled={busy}>取消</button>
     <button type="submit" className="primary" disabled={busy||name.trim()===""}>{busy?"创建中…":"创建工作组"}</button>
    </div>
   </form>}
 </Dialog>;
}
