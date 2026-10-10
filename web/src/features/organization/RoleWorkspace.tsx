import {RareButton,RareInput,RareSelect} from "../../shared/ui/rare";
import {useEffect,useState,type FormEvent} from "react";
import type {User} from "../../entities/user/model";
import {request} from "../../shared/http";
import {errorCopy} from "../../shared/errors";
import {permissionsApi,type DirectGrant,type ResourceFolder} from "./permissionsApi";
import {PermissionAudit} from "./PermissionInsights";

export type ManagementRole={
 id:string;userId:string;role:"auditor"|"permission_admin";
 scopeKind:"global"|"folder";scopeId:string;allowedActions:string[];
 expiresAt?:string;grantedBy:string;createdAt:string;revokedAt?:string;
};
const ACTIONS:[string,string][]=[
 ["list","浏览"],["preview","预览"],["download","下载"],["upload","上传"],
 ["modify","修改"],["rename","重命名"],["move","移动"],["delete","删除"],["print","打印"],
];
const roleName=(value:string)=>value==="auditor"?"只读审计员":"目录权限管理员";
const actionName=(a:string)=>ACTIONS.find(([key])=>key===a)?.[1]??a;
const roleAPI={
 mine:()=>request<ManagementRole[]>("/roles/me"),
 list:()=>request<ManagementRole[]>("/roles/bindings"),
 create:(body:{userId:string;role:string;scopeId:string;allowedActions:string[];expiresAt?:string})=>
  request<ManagementRole>("/roles/bindings",{method:"POST",body:JSON.stringify(body)}),
 revoke:(id:string)=>request<{revoked:string}>("/roles/bindings/"+encodeURIComponent(id),{method:"DELETE"}),
};

export function RoleBindingsPanel({users}:{users:User[]}){
 const[items,setItems]=useState<ManagementRole[]>([]);
 const[load,setLoad]=useState(0);
 const[error,setError]=useState("");
 const[busy,setBusy]=useState(false);
 const[userId,setUserId]=useState("");
 const[role,setRole]=useState<ManagementRole["role"]>("auditor");
 const[scopeId,setScopeId]=useState("");
 const[folderQuery,setFolderQuery]=useState("");
 const[folderOptions,setFolderOptions]=useState<ResourceFolder[]>([]);
 const[folderLoad,setFolderLoad]=useState<"loading"|"ready"|"failed">("loading");
 const[actions,setActions]=useState<string[]>(["list"]);
 const[expires,setExpires]=useState("");
 const[review,setReview]=useState(false);
 const[confirmRevoke,setConfirmRevoke]=useState("");
 useEffect(()=>{let live=true;roleAPI.list().then(v=>{if(live)setItems(v);})
  .catch(e=>{if(live)setError(errorCopy(e,"读取管理角色失败"));});return()=>{live=false};},[load]);
 useEffect(()=>{
  if(role!=="permission_admin")return;
  let live=true;
  setFolderLoad("loading");
  const timer=window.setTimeout(()=>{
   const query=folderQuery.trim();
   const search=query?permissionsApi.search(query):permissionsApi.children("");
   search.then(page=>{if(live){setFolderOptions(page.items);setFolderLoad("ready");}})
    .catch(()=>{if(live){setFolderOptions([]);setFolderLoad("failed");}});
  },folderQuery?250:0);
  return()=>{live=false;window.clearTimeout(timer);};
 },[folderQuery,role,load]);
 const userName=(id:string)=>users.find(u=>u.id===id)?.displayName??id;
 const valid=Boolean(userId)&& (role==="auditor"||Boolean(scopeId.trim())&&actions.length>0);
 async function create(e:FormEvent){
  e.preventDefault();if(!valid||busy)return;
  if(!review){setReview(true);return;}
  setBusy(true);setError("");
  try{
   await roleAPI.create({userId,role,scopeId:role==="auditor"?"":scopeId.trim(),
    allowedActions:role==="auditor"?[]:actions,
    ...(expires?{expiresAt:new Date(expires).toISOString()}:{})});
   setLoad(n=>n+1);setUserId("");setScopeId("");setFolderQuery("");setReview(false);
  }catch(e){setError(errorCopy(e,"分配角色失败"));}
  finally{setBusy(false);}
 }
 async function revoke(id:string){
  if(busy)return;setBusy(true);setError("");
  try{await roleAPI.revoke(id);setConfirmRevoke("");setLoad(v=>v+1);}
  catch(e){setError(errorCopy(e,"撤销角色失败"));}
  finally{setBusy(false);}
 }
 return <section className="perm-detail" aria-label="管理角色绑定" style={{padding:16}}>
  <div className="perm-section-title">管理角色委派 <span className="perm-subtle">仅系统管理员可调整</span></div>
  <p className="perm-hint">审计员只读权限审计，不获得文件访问权。目录权限管理员只在指定目录管理指定动作的直接 ACL，不能向自己授权，不能授予子树继承。</p>
  {error&&<p role="alert" className="notice error">{error}</p>}
  <div className="perm-grants-scroller"><table className="perm-table">
   <thead><tr><th>账号</th><th>角色</th><th>目录范围</th><th>可管理动作</th><th>有效期</th><th>操作</th></tr></thead>
   <tbody>{items.map(b=><tr key={b.id}>
    <td>{userName(b.userId)}</td><td>{roleName(b.role)}</td>
    <td>{b.scopeId||"全局审计"}</td>
    <td>{b.allowedActions.map(actionName).join("、")||"只读"}</td>
    <td>{b.expiresAt?new Date(b.expiresAt).toLocaleString():"不过期"}</td>
    <td>{confirmRevoke===b.id
     ?<><RareButton className="danger" type="button" disabled={busy} onClick={()=>void revoke(b.id)}>确认撤销</RareButton>
        <RareButton type="button" onClick={()=>setConfirmRevoke("")}>取消</RareButton></>
     :<RareButton className="danger" type="button" onClick={()=>setConfirmRevoke(b.id)}>撤销</RareButton>}</td>
   </tr>)}</tbody>
  </table>{items.length===0&&<p className="empty">暂无委派角色。</p>}</div>
  <div className="perm-section-title">新增角色委派</div>
  <form className="perm-form" onSubmit={create} onChange={()=>setReview(false)}>
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
    <div className="perm-action-grid">{ACTIONS.map(([key,name])=><label key={key}>
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
 </section>;
}

export function DelegatedRolesWorkspace(){
 const[roles,setRoles]=useState<ManagementRole[]>([]);
 const[busy,setBusy]=useState(true);
 const[error,setError]=useState("");
 const[folder,setFolder]=useState("");
 const[grants,setGrants]=useState<DirectGrant[]>([]);
 const[subject,setSubject]=useState("");
 const[action,setAction]=useState("list");
 const[expiry,setExpiry]=useState("");
 const[refresh,setRefresh]=useState(0);
 const[confirm,setConfirm]=useState("");
 const[revokeTarget,setRevokeTarget]=useState("");
 useEffect(()=>{let live=true;roleAPI.mine().then(r=>{if(live){setRoles(r);setBusy(false);}})
  .catch(e=>{if(live){setBusy(false);setError(errorCopy(e,"读取管理职责失败"));}});
  return()=>{live=false};},[refresh]);
 const permissionRoles=roles.filter(r=>r.role==="permission_admin");
 const canAudit=roles.some(r=>r.role==="auditor");
 const chosen=permissionRoles.find(r=>r.scopeId===folder);
 const effectiveAction=chosen?.allowedActions.includes(action)?action:(chosen?.allowedActions[0]??"");
 useEffect(()=>{if(!folder&&permissionRoles[0])setFolder(permissionRoles[0].scopeId);},[folder,permissionRoles]);
 useEffect(()=>{if(!chosen)return;let live=true;permissionsApi.grants(folder)
  .then(v=>{if(live)setGrants(v)}).catch(e=>{if(live)setError(errorCopy(e,"读取直接 ACL 失败"));});
  return()=>{live=false};},[folder,refresh,chosen?.id]);
 async function create(e:FormEvent){
  e.preventDefault();if(!chosen||!subject)return;
  if(!confirm){setConfirm("yes");return;}
  try{await permissionsApi.create(folder,{subjectKind:"user",subjectId:subject,actions:[effectiveAction],scopeOnly:true,
   ...(expiry?{expiresAt:new Date(expiry).toISOString()}:{})});
   setConfirm("");setSubject("");setRefresh(v=>v+1);
  }catch(e){setError(errorCopy(e,"授权失败"));}
 }
 async function revoke(id:string){
  if(revokeTarget!==id){setRevokeTarget(id);return;}
  try{await permissionsApi.revoke(id);setRevokeTarget("");setRefresh(v=>v+1);}
  catch(e){setError(errorCopy(e,"撤销直接 ACL 失败"));}
 }
 return <div className="work-body">
  {busy&&<p role="status">正在读取委派职责…</p>}
  {error&&<p role="alert" className="notice error">{error}</p>}
  {!busy&&roles.length===0&&<p className="notice">没有有效管理角色；部门、用户和工作组管理仍需系统管理员权限。</p>}
  {canAudit&&<PermissionAudit users={[]}/>}
  {permissionRoles.length>0&&<section className="perm-detail" style={{padding:16}}>
   <div className="perm-section-title">委派目录 ACL 管理</div>
   <p className="perm-hint">只能维护所选目录的直接授权。角色自身不赋予浏览或下载文件的权限。</p>
   <label>管理目录<RareSelect value={folder} onChange={e=>setFolder(e.target.value)}>
    {permissionRoles.map(r=><option key={r.id} value={r.scopeId}>{r.scopeId}</option>)}
   </RareSelect></label>
   {chosen&&<><p>可授权动作：{chosen.allowedActions.map(actionName).join("、")}</p>
    <table className="perm-table"><thead><tr><th>主体 ID</th><th>动作</th><th>范围</th><th>到期</th><th>操作</th></tr></thead>
     <tbody>{grants.map(g=><tr key={g.id}><td>{g.subjectId}</td><td>{g.actions.map(actionName).join("、")}</td>
      <td>{g.scopeOnly?"仅本目录":"包含子目录"}</td><td>{g.expiresAt||"不过期"}</td>
      <td>{g.scopeOnly&&g.actions.every(a=>chosen.allowedActions.includes(a))&&
        (!chosen.expiresAt||Boolean(g.expiresAt&&new Date(g.expiresAt)<=new Date(chosen.expiresAt)))&&
        <RareButton className="danger" type="button" onClick={()=>void revoke(g.id)}>
         {revokeTarget===g.id?"确认撤销":"撤销"}
        </RareButton>}</td>
     </tr>)}</tbody>
    </table>
    <form className="perm-form" onSubmit={create} onChange={()=>setConfirm("")}>
     <p className="perm-hint">请输入已知的目标账号 ID。不得填写自己的 ID；所有范围检查以服务端为准。</p>
     <div className="perm-form-row">
      <label>目标用户 ID<RareInput required value={subject} onChange={e=>setSubject(e.target.value)}/></label>
      <label>动作<RareSelect value={effectiveAction}
       onChange={e=>setAction(e.target.value)}>{chosen.allowedActions.map(a=><option value={a} key={a}>{actionName(a)}</option>)}</RareSelect></label>
      <label>授权到期时间{chosen.expiresAt?"（必填且不能晚于委派到期）":"（可选）"}
       <RareInput type="datetime-local" required={Boolean(chosen.expiresAt)} value={expiry} onChange={e=>setExpiry(e.target.value)}/></label>
     </div>
     {confirm&&<p className="perm-review">确认向 {subject} 授予 {actionName(effectiveAction)}，仅当前目录。</p>}
     <RareButton type="button" className="secondary-action" onClick={()=>setRefresh(v=>v+1)}>刷新</RareButton>
     <RareButton className="primary" type="submit" disabled={!subject}>{confirm?"确认授权":"预览授权"}</RareButton>
    </form>
   </>}
  </section>}
 </div>;
}
