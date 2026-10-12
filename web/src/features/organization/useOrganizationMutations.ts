import {useRef,useState,type Dispatch,type SetStateAction} from "react";
import type {User} from "../../entities/user/model";
import {organizationApi,type Workgroup} from "./api";
import {errorCode,errorCopy} from "../../shared/errors";
import type {DialogResult} from "./OrganizationDialogs";

type Notice={tone:"info"|"error";text:string};
type NewUser={login:string;displayName:string;password:string;departmentId:string};
type RefreshResult="ok"|"failed"|"stale";

/** UI-side, single-flight mutation coordinator. A network failure never silently retries
 * an unsafe write; reconciliation reads the server without throwing away cached rows. */
export function useOrganizationMutations({
 newUser,setNewUser,resetTarget,stateTarget,removeTarget,selectedGroup,selectedGroupRow,
 setNotice,setCandidateQuery,setGroupMembers,reloadUsers,reloadDepartments,reloadGroups,reloadMembers
}:{
 newUser:NewUser;setNewUser:Dispatch<SetStateAction<NewUser>>;
 resetTarget:User|null;stateTarget:User|null;removeTarget:User|null;
 selectedGroup:string;selectedGroupRow:Workgroup|null;
 setNotice:Dispatch<SetStateAction<Notice|null>>;
 setCandidateQuery:Dispatch<SetStateAction<string>>;
 setGroupMembers:Dispatch<SetStateAction<User[]>>;
 reloadUsers:()=>Promise<RefreshResult>;
 reloadDepartments:()=>Promise<RefreshResult>;
 reloadGroups:()=>Promise<RefreshResult>;
 reloadMembers:(groupId:string)=>Promise<RefreshResult>;
}){
 const[selectedGroupBusy,setAddBusy]=useState("");
 const selectedGroupRef=useRef(selectedGroup);
 selectedGroupRef.current=selectedGroup;
 const locks=useRef(new Map<string,Promise<unknown>>());
 function singleFlight<T>(key:string,mutation:()=>Promise<T>):Promise<T>{
  const pending=locks.current.get(key) as Promise<T>|undefined;
  if(pending)return pending;
  const request=Promise.resolve().then(mutation).finally(()=>{locks.current.delete(key);});
  locks.current.set(key,request);
  return request;
 }
function loginOf(user:User):string{return user.login??"";}

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

 async function refreshUsers(failure:string):Promise<void>{
  if(await reloadUsers()==="failed")setNotice({tone:"error",text:failure});
 }

 async function refreshDepartments(failure:string):Promise<void>{
  if(await reloadDepartments()==="failed")setNotice({tone:"error",text:failure});
 }

 async function refreshGroups(failure:string):Promise<void>{
  if(await reloadGroups()==="failed")setNotice({tone:"error",text:failure});
 }

 async function refreshMembers(failure:string,groupId=selectedGroup):Promise<boolean>{
  const result=await reloadMembers(groupId);
  if(result==="failed")setNotice({tone:"error",text:failure});
  return result==="ok";
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
    await refreshMembers("移除成员的结果未确认，工作组成员刷新失败，请重试。",group.id);
   return{error:mutationCopy(error,"移除成员失败")};
  }
  if(selectedGroupRef.current===group.id){
   setGroupMembers(prev=>prev.filter(member=>member.id!==target.id));
   const refreshed=await refreshMembers(`已移除 ${target.displayName}，但成员列表刷新失败，请点击重试。`,group.id);
   if(refreshed&&selectedGroupRef.current===group.id)
    setNotice({tone:"info",text:`已把 ${target.displayName} 从工作组 ${group.name} 移除。`});
  }
  return{ok:`已把 ${target.displayName} 从工作组 ${group.name} 移除；其直接授权不受影响，最终生效权限由服务端判定。`};
 }

 async function addMember(user:User){
  const group=selectedGroupRow;
  if(!group)return;
  if(selectedGroupRef.current===group.id){setNotice(null);setAddBusy(user.id);}
  try{
   await organizationApi.addMember(group.id,user.id);
  }catch(error){
   const code=errorCode(error);
   if(code==="E_NETWORK"||code==="E_NOT_FOUND"||code==="E_INTERNAL"||code==="E_NAME_CONFLICT")
    await refreshMembers("添加成员未成功，工作组成员刷新失败，请重试。",group.id);
   if(selectedGroupRef.current===group.id)
    setNotice({tone:"error",text:code==="E_INTERNAL"||code==="E_NAME_CONFLICT"
    ?"服务端未接受该成员变更；已重新读取成员列表，请确认该账号是否已在工作组中。"
    :mutationCopy(error,"添加成员失败")});
   if(selectedGroupRef.current===group.id)setAddBusy("");
   return;
  }
  if(selectedGroupRef.current===group.id)setAddBusy("");
  const refreshed=await refreshMembers(`已把 ${user.displayName} 加入工作组 ${group.name}，但成员列表刷新失败，请点击重试。`,group.id);
  if(refreshed&&selectedGroupRef.current===group.id)
   setNotice({tone:"info",text:`已把 ${user.displayName} 加入工作组 ${group.name}。`});
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

 return {
  addBusy:selectedGroupBusy,
  createUser:()=>singleFlight("createUser",createUser),
  resetPassword:(password:string)=>singleFlight("password:"+(resetTarget?.id??""),()=>resetPassword(password)),
  applyDisabled:()=>singleFlight("state:"+(stateTarget?.id??""),applyDisabled),
  removeMember:()=>singleFlight("removeMember:"+(selectedGroupRow?.id??"")+":"+(removeTarget?.id??""),removeMember),
  addMember:(user:User)=>singleFlight("addMember:"+(selectedGroupRow?.id??"")+":"+user.id,()=>addMember(user)),
  createDepartment:(name:string,parentId:string)=>singleFlight("createDepartment",()=>createDepartment(name,parentId)),
  createGroup:(name:string,departmentId:string)=>singleFlight("createGroup",()=>createGroup(name,departmentId)),
 };
}
