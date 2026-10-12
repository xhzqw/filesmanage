import {RareButton,RareInput,RareSelect} from "../../shared/ui/rare";
import type {Dispatch,FormEvent,SetStateAction} from "react";
import type {User} from "../../entities/user/model";
import type {ResourceFolder} from "./permissionsApi";
import type {ManagementRole} from "./RoleWorkspace";

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
  <section className="org-role-editor" aria-label="新增角色委派"><div className="perm-section-title">新增委派</div>
  <form className="perm-form" onSubmit={onSubmit} onChange={()=>setReview(false)}>
   <div className="perm-form-row">
    <label>委派给账号<RareSelect required value={userId} onChange={e=>{setUserId(e.target.value);setReview(false);}}>
     <option value="">请选择</option>{users.filter(u=>!u.isAdmin&&!u.disabled).map(u=>
      <option key={u.id} value={u.id}>{u.displayName}（{u.login}）</option>)}
    </RareSelect></label>
    <label>管理角色<RareSelect value={role} onChange={e=>{setRole(e.target.value as ManagementRole["role"]);setReview(false);}}>
     <option value="auditor">只读审计员</option><option value="permission_admin">目录权限管理员</option>
    </RareSelect></label>
    {role==="permission_admin"&&<>
     <label>查找授权目录<RareInput type="search" value={folderQuery} placeholder="按目录名称搜索"
      onChange={e=>{setFolderQuery(e.target.value);setReview(false);}}/></label>
     <label>授权目录<RareSelect required value={scopeId} disabled={folderLoad!=="ready"}
      onChange={e=>{setScopeId(e.target.value);setReview(false);}}>
      <option value="">{folderLoad==="loading"?"正在读取目录…":folderLoad==="failed"?"目录加载失败":"请选择目录"}</option>
      {scopeId&&!folderOptions.some(f=>f.id===scopeId)&&<option value={scopeId}>{scopeId}（已选目录）</option>}
      {folderOptions.map(f=><option key={f.id} value={f.id}>{f.path||f.name}</option>)}
     </RareSelect></label>
     {folderLoad==="failed"&&<span className="perm-hint" role="alert">目录读取失败，请修改搜索词后重试。</span>}
    </>}
    <label>过期时间（可选）<RareInput type="datetime-local" value={expires} onChange={e=>setExpires(e.target.value)}/></label>
   </div>
   {role==="permission_admin"&&<fieldset><legend>允许管理的 ACL 动作</legend>
    <div className="org-role-action-tools" role="group" aria-label="快速选择权限动作">
     <span role="status">已选 {actions.length} / {actionChoices.length}</span>
     <RareButton type="button" tone="ghost" onClick={()=>{setActions(actionChoices.map(([key])=>key));setReview(false);}}
      disabled={busy||actions.length===actionChoices.length}>全部选择</RareButton>
     <RareButton type="button" tone="ghost" onClick={()=>{setActions([]);setReview(false);}}
      disabled={busy||actions.length===0}>清空</RareButton>
    </div>
    <div className="perm-action-grid">{actionChoices.map(([key,name])=><label key={key}>
     <RareInput type="checkbox" checked={actions.includes(key)}
      onChange={e=>setActions(old=>e.target.checked?[...old,key]:old.filter(x=>x!==key))}/>{name}
    </label>)}</div>
   </fieldset>}
   {review&&<p className="perm-review">请确认：委派 {roleName(role)} 给 {userName(userId)}；
    范围 {role==="auditor"?"全局审计":scopeId}；动作 {actions.map(actionName).join("、")}。
    委派不附带文件读取权限。</p>}
   <div className="perm-form-actions">
    <RareButton type="submit" className="primary" disabled={!valid||busy}>{busy?"提交中…":review?"确认委派":"预览委派"}</RareButton>
   </div>
  </form>
  </section>
 </>;
}
