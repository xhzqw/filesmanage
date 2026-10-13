import {RareButton,RareInput,RareSelect} from "../../shared/ui/rare";
import type {Dispatch,FormEvent,SetStateAction} from "react";
import type {User} from "../../entities/user/model";
import type {ResourceFolder} from "./permissionsApi";
import type {ManagementRole} from "./RoleWorkspace";
import {PermissionActionPicker} from "./PermissionActionPicker";

/** Controlled role editor. Server mutation and confirmation lifecycle belong to the owner. */
export function RoleDelegationEditor({users,userId,setUserId,role,setRole,scopeId,setScopeId,
 folderQuery,setFolderQuery,folderLoad,folderOptions,actions,setActions,expires,setExpires,
 review,setReview,busy,valid,userName,roleName,actionName,actionChoices,onSubmit}:{
 users:User[];
 userId:string;setUserId:Dispatch<SetStateAction<string>>;
 role:ManagementRole["role"];setRole:Dispatch<SetStateAction<ManagementRole["role"]>>;
 scopeId:string;setScopeId:Dispatch<SetStateAction<string>>;
 folderQuery:string;setFolderQuery:Dispatch<SetStateAction<string>>;
 folderLoad:"loading"|"ready"|"failed";folderOptions:ResourceFolder[];
 actions:string[];setActions:Dispatch<SetStateAction<string[]>>;
 expires:string;setExpires:Dispatch<SetStateAction<string>>;
 review:boolean;setReview:Dispatch<SetStateAction<boolean>>;
 busy:boolean;valid:boolean;userName:(id:string)=>string;
 roleName:(role:string)=>string;actionName:(action:string)=>string;
 actionChoices:[string,string][];onSubmit:(event:FormEvent<HTMLFormElement>)=>void;
}){
 return <>
  <section className="org-role-editor" aria-label="角色委派设置">
  <form className="perm-form" onSubmit={onSubmit} onChange={()=>setReview(false)}>
   <div className="perm-form-row">
    <label>选择成员<RareSelect required searchable value={userId} aria-label="选择接受管理职责的成员" onChange={e=>{setUserId(e.target.value);setReview(false);}}>
     <option value="">选择成员</option>{users.filter(u=>!u.isAdmin&&!u.disabled).map(u=>
      <option key={u.id} value={u.id}>{u.displayName}（{u.login}）</option>)}
    </RareSelect></label>
    <label>委派职责<RareSelect aria-label="选择管理职责" value={role} onChange={e=>{setRole(e.target.value as ManagementRole["role"]);setReview(false);}}>
     <option value="auditor">只读审计员</option><option value="permission_admin">目录权限管理员</option>
    </RareSelect></label>
   </div>
   <p className="org-role-context" role="status">{role==="auditor"
    ?"仅查看权限变更记录，不会获得文件查看或下载权限。"
    :"只能管理指定目录的直接授权，不可给自己授权，也不能授权子目录继承。"}</p>
   <div className="perm-form-row">
    {role==="permission_admin"&&<>
     <label>搜索目录<RareInput type="search" value={folderQuery} placeholder="按名称查找可管理的目录"
      onChange={e=>{setFolderQuery(e.target.value);setReview(false);}}/></label>
     <label>管理范围<RareSelect required searchable value={scopeId} disabled={folderLoad!=="ready"}
      onChange={e=>{setScopeId(e.target.value);setReview(false);}}>
      <option value="">{folderLoad==="loading"?"正在读取目录…":folderLoad==="failed"?"目录加载失败":"请选择目录"}</option>
      {scopeId&&!folderOptions.some(f=>f.id===scopeId)&&<option value={scopeId}>{scopeId}（已选目录）</option>}
      {folderOptions.map(f=><option key={f.id} value={f.id}>{f.path||f.name}</option>)}
     </RareSelect></label>
     {folderLoad==="failed"&&<span className="perm-hint" role="alert">目录读取失败，请修改搜索词后重试。</span>}
    </>}
    <label>过期时间（可选）<RareInput type="datetime-local" value={expires} onChange={e=>setExpires(e.target.value)}/></label>
   </div>
   {role==="permission_admin"&&<PermissionActionPicker options={actionChoices} value={actions}
    label="允许管理的 ACL 动作" preset="all" disabled={busy} toolbarClassName="org-role-action-tools"
    onChange={next=>{setActions(next);setReview(false);}}/>}
   {review&&<div className="perm-review org-role-review" role="status">
    <strong>确认委派内容</strong>
    <span>{userName(userId)} · {roleName(role)}</span>
    <span>{role==="auditor"?"查看全局权限审计记录":`管理目录：${folderOptions.find(folder=>folder.id===scopeId)?.path||scopeId}`}</span>
    {role==="permission_admin"&&<span>允许管理：{actions.map(actionName).join("、")}</span>}
    <span>有效期：{expires?new Date(expires).toLocaleString():"长期有效"}</span>
    <small>委派不附带文件读取权限。</small>
   </div>}
   <div className="perm-form-actions">
    <RareButton type="submit" tone="primary" className="primary" loading={busy} disabled={!valid}>{review?"确认委派":"核对委派"}</RareButton>
   </div>
  </form>
  </section>
 </>;
}
