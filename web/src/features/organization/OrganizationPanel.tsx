import {useEffect,useState,type FormEvent} from "react";
import {organizationApi} from "./api";
import {errorCopy} from "../../shared/errors";
import type {User} from "../../entities/user/model";
import type {Department,Workgroup} from "./api";

export function OrganizationPanel(){
 const[users,setUsers]=useState<User[]>([]);
 const[departments,setDepartments]=useState<Department[]>([]);
 const[groups,setGroups]=useState<Workgroup[]>([]);
 const[status,setStatus]=useState("loading");
 const[message,setMessage]=useState("");
 const[selectedGroup,setSelectedGroup]=useState("");
 const[members,setMembers]=useState<User[]>([]);
 const[newUser,setNewUser]=useState({login:"",displayName:"",password:""});
 const[newGroup,setNewGroup]=useState("");

 useEffect(()=>{
  let valid=true;
  Promise.all([organizationApi.users(),organizationApi.departments(),organizationApi.groups()])
   .then(([u,d,g])=>{
    if(!valid)return;
    setUsers(u);setDepartments(d);setGroups(g);
    const first=g[0];
    if(first)setSelectedGroup(first.id);
    setStatus("ready");
   })
   .catch(()=>{if(valid)setStatus("failed");});
  return()=>{valid=false;};
 },[]);

 useEffect(()=>{
  if(!selectedGroup)return;
  let valid=true;
  organizationApi.members(selectedGroup)
   .then(data=>{if(valid)setMembers(data);})
   .catch(()=>{if(valid)setMembers([]);});
  return()=>{valid=false;};
 },[selectedGroup]);

 async function submitUser(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  setMessage("");
  try{
   const created=await organizationApi.createUser(newUser.login,newUser.displayName,newUser.password,"");
   setUsers(prev=>[...prev,created]);
   setNewUser({login:"",displayName:"",password:""});
   setMessage(`已创建 ${created.login}，首次登录必须修改初始密码`);
  }catch(error){
   setMessage(errorCopy(error,"创建用户失败"));
  }
 }

 async function submitGroup(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(newGroup.trim()==="")return;
  setMessage("");
  try{
   const created=await organizationApi.createGroup(newGroup.trim());
   setGroups(prev=>[...prev,created]);
   setSelectedGroup(created.id);
   setNewGroup("");
  }catch(error){
   setMessage(errorCopy(error,"创建工作组失败"));
  }
 }

 async function toggleDisabled(user:User){
  setMessage("");
  try{
   const result=await organizationApi.setDisabled(user.id,user.disabled!==true);
   setUsers(prev=>prev.map(u=>u.id===user.id?{...u,disabled:result.disabled}:u));
  }catch(error){
   setMessage(errorCopy(error,"状态变更失败"));
  }
 }

 async function resetPassword(user:User){
  const password=window.prompt(`为 ${user.login} 设置新初始密码（至少 16 个字符，下次登录强制修改）：`);
  if(!password)return;
  setMessage("");
  try{
   await organizationApi.resetPassword(user.id,password);
   setMessage(`已重置 ${user.login} 的密码，其所有会话已失效`);
  }catch(error){
   setMessage(errorCopy(error,"重置失败"));
  }
 }

 async function addMember(userId:string){
  setMessage("");
  try{
   await organizationApi.addMember(selectedGroup,userId);
   setMembers(await organizationApi.members(selectedGroup));
  }catch(error){
   setMessage(errorCopy(error,"添加成员失败"));
  }
 }

 async function removeMember(userId:string){
  setMessage("");
  try{
   await organizationApi.removeMember(selectedGroup,userId);
   setMembers(prev=>prev.filter(m=>m.id!==userId));
  }catch(error){
   setMessage(errorCopy(error,"移除成员失败"));
  }
 }

 if(status!=="ready")return <p className="empty">{status==="loading"?"正在加载组织数据…":"组织管理仅系统管理员可用"}</p>;

 const departmentName=(id:string|undefined,list:Department[]):string=>{
  if(!id)return "未分配部门";
  return list.find(d=>d.id===id)?.name??id;
 };

 const memberIds=new Set(members.map(m=>m.id));
 return <div className="work-body">
  <div className="toolbar"><span className="toolbar-hint">用户 {users.length} · 部门 {departments.length} · 工作组 {groups.length}</span></div>
  {message&&<p role="status" className="notice">{message}</p>}
  <div className="org-columns">
   <section className="table">
    <h3>用户</h3>
    <table>
     <thead><tr><th>账号</th><th>姓名</th><th>角色</th><th>状态</th><th>操作</th></tr></thead>
     <tbody>
      {users.map(user=><tr key={user.id}>
       <td>{user.login}</td>
       <td>{user.displayName}</td>
       <td>{user.isAdmin?"系统管理员":departmentName(user.departmentId,departments)}</td>
       <td>{user.disabled?"已禁用":user.mustChangePassword?"待改密":"正常"}</td>
       <td className="row-actions">
        <button type="button" onClick={()=>resetPassword(user)}>重置密码</button>
        <button type="button" className={user.disabled?"":"danger"} onClick={()=>toggleDisabled(user)}>{user.disabled?"启用":"禁用"}</button>
       </td>
      </tr>)}
     </tbody>
    </table>
    <form className="inline-form org-form" onSubmit={submitUser}>
     <input aria-label="新账号" placeholder="新账号" value={newUser.login} onChange={e=>setNewUser(p=>({...p,login:e.target.value}))}/>
     <input aria-label="姓名" placeholder="姓名" value={newUser.displayName} onChange={e=>setNewUser(p=>({...p,displayName:e.target.value}))}/>
     <input aria-label="初始密码" placeholder="初始密码（≥16 位）" type="password" value={newUser.password} onChange={e=>setNewUser(p=>({...p,password:e.target.value}))}/>
     <button className="primary" type="submit" disabled={newUser.login===""||newUser.displayName===""||newUser.password.length<16}>创建用户</button>
    </form>
   </section>
   <section className="table">
    <h3>工作组</h3>
    <form className="inline-form org-form" onSubmit={submitGroup}>
     <input aria-label="工作组名称" placeholder="新工作组名称" value={newGroup} onChange={e=>setNewGroup(e.target.value)}/>
     <button className="primary" type="submit" disabled={newGroup.trim()===""}>创建工作组</button>
    </form>
    <ul className="group-list">
     {groups.map(group=><li key={group.id}>
      <button type="button" className={group.id===selectedGroup?"on":""} onClick={()=>setSelectedGroup(group.id)}>{group.name}</button>
     </li>)}
    </ul>
    <h3>成员（{members.length}）</h3>
    <ul className="member-list">
     {members.map(member=><li key={member.id}>
      <span>{member.displayName}（{member.login}）</span>
      <button type="button" className="danger" onClick={()=>removeMember(member.id)}>移除</button>
     </li>)}
     {members.length===0&&<li className="empty">暂无成员</li>}
    </ul>
    <details>
     <summary>添加成员</summary>
     <ul className="member-list">
      {users.filter(u=>!memberIds.has(u.id)).map(user=><li key={user.id}>
       <span>{user.displayName}（{user.login}）</span>
       <button type="button" onClick={()=>addMember(user.id)}>加入</button>
      </li>)}
     </ul>
    </details>
   </section>
  </div>
 </div>;
}
