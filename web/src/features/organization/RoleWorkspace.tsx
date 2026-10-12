import {RareBadge,RareButton,RareDataTable,RareInput,RareNotice,RareRowActions,RareSelect} from "../../shared/ui/rare";
import {observeWorkspaceChange} from "../../shared/resourceSync";
import {useEffect,useRef,useState,type FormEvent} from "react";
import type {User} from "../../entities/user/model";
import {request} from "../../shared/http";
import {errorCode,errorCopy} from "../../shared/errors";
import {permissionsApi,type DirectGrant,type ResourceFolder} from "./permissionsApi";
import {PermissionAudit} from "./PermissionInsights";
import {RoleDelegationEditor} from "./RoleDelegationEditor";

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

export function RoleBindingsPanel({users,onDirtyChange}:{users:User[];onDirtyChange:(dirty:boolean)=>void}){
 const[items,setItems]=useState<ManagementRole[]>([]);
 const[load,setLoad]=useState(0);
 useEffect(()=>observeWorkspaceChange(()=>setLoad(n=>n+1),["permissions"]),[]);
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
 const inFlight=useRef(false);
 const[loadError,setLoadError]=useState("");
 const[loading,setLoading]=useState(true);
 const dirty=userId!==""||role!=="auditor"||scopeId!==""||folderQuery!==""||
  actions.length!==1||actions[0]!=="list"||expires!==""||review;
 useEffect(()=>onDirtyChange(dirty),[dirty,onDirtyChange]);
 useEffect(()=>()=>onDirtyChange(false),[onDirtyChange]);
 useEffect(()=>{
  let live=true;
  setLoading(true);setLoadError("");
  roleAPI.list().then(v=>{if(live){setItems(v);setLoading(false);}})
   .catch(e=>{if(live){setLoadError(errorCopy(e,"读取管理角色失败"));setLoading(false);}});
  return()=>{live=false};
 },[load]);
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
  e.preventDefault();if(!valid||inFlight.current)return;
  if(!review){setReview(true);return;}
  inFlight.current=true;setBusy(true);setError("");
  try{
   await roleAPI.create({userId,role,scopeId:role==="auditor"?"":scopeId.trim(),
    allowedActions:role==="auditor"?[]:actions,
    ...(expires?{expiresAt:new Date(expires).toISOString()}:{})});
   setLoad(n=>n+1);setUserId("");setRole("auditor");setActions(["list"]);setExpires("");setScopeId("");setFolderQuery("");setReview(false);
  }catch(e){setError(errorCopy(e,"分配角色失败"));}
  finally{setBusy(false);}
 }
 async function revoke(id:string){
  if(inFlight.current)return;inFlight.current=true;setBusy(true);setError("");
  try{await roleAPI.revoke(id);setConfirmRevoke("");setLoad(v=>v+1);}
  catch(e){setError(errorCopy(e,"撤销角色失败"));setLoad(v=>v+1);}
  finally{inFlight.current=false;setBusy(false);}
 }
 return <section className="perm-detail org-role-workbench" aria-label="管理角色绑定">
  <div className="perm-section-title">管理角色 <span className="perm-subtle">仅系统管理员可调整</span></div>
  <details className="org-role-explanation"><summary>角色权限说明</summary><p>审计员只读权限审计，不获得文件访问权。目录权限管理员只在指定目录管理指定动作的直接 ACL，不能向自己授权，不能授予子树继承。</p></details>
   {error&&<RareNotice tone="danger">{error}</RareNotice>}
   {loadError&&<RareNotice tone="danger">{loadError} <RareButton type="button" className="secondary-action" onClick={()=>setLoad(n=>n+1)}>重试读取</RareButton></RareNotice>}
   {loading&&items.length===0&&<p className="hint" role="status">正在读取委派角色…</p>}
  <div className="org-role-layout"><section className="org-role-list" aria-label="已有角色委派">
  <div className="perm-section-title">已委派 <span className="perm-count">{items.length}</span></div>
  <div className="perm-grants-scroller org-role-scroll"><RareDataTable className="perm-table org-role-table">
   <thead><tr><th>账号</th><th>角色</th><th className="org-role-optional">目录范围</th><th className="org-role-optional">可管理动作</th><th className="org-role-optional">有效期</th><th>操作</th></tr></thead>
   <tbody>{items.map(b=><tr key={b.id}>
    <td className="org-role-user" title={userName(b.userId)}>{userName(b.userId)}<small className="org-role-mobile-meta">{b.scopeId||"全局审计"} · {b.allowedActions.map(actionName).join("、")||"只读"}</small></td>
    <td><RareBadge tone={b.role==="auditor"?"neutral":"info"}>{roleName(b.role)}</RareBadge></td>
    <td className="org-role-optional" title={b.scopeId||"全局审计"}>{b.scopeId||"全局审计"}</td>
    <td className="org-role-optional">{b.allowedActions.map(actionName).join("、")||"只读"}</td>
    <td className="org-role-optional rare-data-date">{b.expiresAt?new Date(b.expiresAt).toLocaleString():"不过期"}</td>
    <td className="org-role-actions"><RareRowActions>{confirmRevoke===b.id
     ?<><RareButton className="danger" type="button" disabled={busy} onClick={()=>void revoke(b.id)}>确认撤销</RareButton>
        <RareButton type="button" onClick={()=>setConfirmRevoke("")}>取消</RareButton></>
     :<RareButton className="danger" type="button" onClick={()=>setConfirmRevoke(b.id)}>撤销</RareButton>}</RareRowActions></td>
   </tr>)}</tbody>
  </RareDataTable>{!loading&&!loadError&&items.length===0&&<p className="empty">暂无委派角色。</p>}</div></section>
  <RoleDelegationEditor users={users} userId={userId} setUserId={setUserId}
   role={role} setRole={setRole} scopeId={scopeId} setScopeId={setScopeId}
   folderQuery={folderQuery} setFolderQuery={setFolderQuery}
   folderLoad={folderLoad} folderOptions={folderOptions}
   actions={actions} setActions={setActions} expires={expires} setExpires={setExpires}
   review={review} setReview={setReview} busy={busy} valid={valid}
   userName={userName} roleName={roleName} actionName={actionName} actionChoices={ACTIONS} onSubmit={create}/>
</div>
 </section>;
}

export function DelegatedRolesWorkspace(){
 const[roles,setRoles]=useState<ManagementRole[]>([]);
 const[busy,setBusy]=useState(true);
 const[error,setError]=useState("");
 const[folder,setFolder]=useState("");
 const[grants,setGrants]=useState<DirectGrant[]>([]);
 const[grantsFolder,setGrantsFolder]=useState("");
 const[subject,setSubject]=useState("");
 const[action,setAction]=useState("list");
 const[expiry,setExpiry]=useState("");
 const[refresh,setRefresh]=useState(0);
 const[confirm,setConfirm]=useState("");
 const mutationBusy=useRef(false);
 const[isMutating,setIsMutating]=useState(false);
 useEffect(()=>observeWorkspaceChange(()=>{
  setConfirm("");setRevokeTarget("");setRefresh(n=>n+1);
 },["permissions"]),[]);
 const[revokeTarget,setRevokeTarget]=useState("");
 useEffect(()=>{let live=true;roleAPI.mine().then(r=>{if(live){setRoles(r);setBusy(false);}})
  .catch(e=>{if(live){setBusy(false);setError(errorCopy(e,"读取管理职责失败"));}});
  return()=>{live=false};},[refresh]);
 const permissionRoles=roles.filter(r=>r.role==="permission_admin");
 const canAudit=roles.some(r=>r.role==="auditor");
 const chosen=permissionRoles.find(r=>r.scopeId===folder);
 const effectiveAction=chosen?.allowedActions.includes(action)?action:(chosen?.allowedActions[0]??"");
 useEffect(()=>{if(!folder&&permissionRoles[0])setFolder(permissionRoles[0].scopeId);},[folder,permissionRoles]);
 useEffect(()=>{
  // Do not display a previous folder's ACL while the new folder is being read.
  setGrantsFolder("");
  if(!chosen)return;
  let live=true;
  permissionsApi.grants(folder)
   .then(v=>{if(live){setGrants(v);setGrantsFolder(folder);}})
   .catch(e=>{if(live)setError(errorCopy(e,"读取直接 ACL 失败"));});
  return()=>{live=false};
 },[folder,refresh,chosen?.id]);
 const reviewSignature=JSON.stringify([chosen?.id??"",folder,subject.trim(),effectiveAction,expiry]);
 async function create(e:FormEvent){
  e.preventDefault();if(!chosen||!subject.trim()||!effectiveAction||mutationBusy.current)return;
  if(confirm!==reviewSignature){setConfirm(reviewSignature);return;}
  mutationBusy.current=true;setIsMutating(true);setError("");
  const targetFolder=folder;
  try{
   await permissionsApi.create(targetFolder,{subjectKind:"user",subjectId:subject.trim(),actions:[effectiveAction],scopeOnly:true,
    ...(expiry?{expiresAt:new Date(expiry).toISOString()}:{})});
   setConfirm("");setSubject("");setRefresh(v=>v+1);
  }catch(e){
   setConfirm("");
   setError(errorCopy(e,"授权失败")+(errorCode(e)==="E_NETWORK"?" 结果可能已提交，请先核对授权列表，勿直接重复操作。":""));
   setRefresh(v=>v+1);
  }finally{mutationBusy.current=false;setIsMutating(false);}
 }
 async function revoke(id:string){
  if(mutationBusy.current)return;
  if(revokeTarget!==id){setRevokeTarget(id);return;}
  mutationBusy.current=true;setIsMutating(true);setError("");
  try{await permissionsApi.revoke(id);setRevokeTarget("");setRefresh(v=>v+1);}
  catch(e){
   setRevokeTarget("");
   setError(errorCopy(e,"撤销直接 ACL 失败")+(errorCode(e)==="E_NETWORK"?" 结果未确认，请先核对记录。":""));
   setRefresh(v=>v+1);
  }finally{mutationBusy.current=false;setIsMutating(false);}
 }
 return <div className="work-body">
  {busy&&<p role="status" className="hint">正在读取委派职责…</p>}
   {error&&<RareNotice tone="danger">{error}</RareNotice>}
   {!busy&&roles.length===0&&<RareNotice tone="info">没有有效管理角色；部门、用户和工作组管理需要系统管理员权限。</RareNotice>}
  {canAudit&&<PermissionAudit users={[]}/>}
  {permissionRoles.length>0&&<section className="perm-detail org-delegated-workspace">
   <div className="perm-section-title">委派目录 ACL 管理</div>
   <p className="perm-hint">只能维护所选目录的直接授权。角色自身不赋予浏览或下载文件的权限。</p>
   <label>管理目录<RareSelect value={folder} onChange={e=>{
    setFolder(e.target.value);setConfirm("");setRevokeTarget("");setSubject("");setExpiry("");
   }}>
    {permissionRoles.map(r=><option key={r.id} value={r.scopeId}>{r.scopeId}</option>)}
   </RareSelect></label>
   {chosen&&<><p>可授权动作：{chosen.allowedActions.map(actionName).join("、")}</p>
     <RareDataTable className="perm-table"><thead><tr><th>主体 ID</th><th>动作</th><th>范围</th><th>到期</th><th>操作</th></tr></thead>
     <tbody>{(grantsFolder===folder?grants:[]).map(g=><tr key={g.id}><td>{g.subjectId}</td><td>{g.actions.map(actionName).join("、")}</td>
      <td>{g.scopeOnly?"仅本目录":"包含子目录"}</td><td>{g.expiresAt||"不过期"}</td>
      <td>{g.scopeOnly&&g.actions.every(a=>chosen.allowedActions.includes(a))&&
        (!chosen.expiresAt||Boolean(g.expiresAt&&new Date(g.expiresAt)<=new Date(chosen.expiresAt)))&&
        <RareButton className="danger" type="button" disabled={isMutating} onClick={()=>void revoke(g.id)}>
         {revokeTarget===g.id?"确认撤销":"撤销"}
        </RareButton>}</td>
     </tr>)}</tbody>
     </RareDataTable>
    <form className="perm-form" onSubmit={create} onChange={()=>setConfirm("")}>
     <p className="perm-hint">请输入已知的目标账号 ID。不得填写自己的 ID；所有范围检查以服务端为准。</p>
     <div className="perm-form-row">
      <label>目标用户 ID<RareInput required value={subject} onChange={e=>setSubject(e.target.value)}/></label>
      <label>动作<RareSelect value={effectiveAction}
       onChange={e=>setAction(e.target.value)}>{chosen.allowedActions.map(a=><option value={a} key={a}>{actionName(a)}</option>)}</RareSelect></label>
      <label>授权到期时间{chosen.expiresAt?"（必填且不能晚于委派到期）":"（可选）"}
       <RareInput type="datetime-local" required={Boolean(chosen.expiresAt)} value={expiry} onChange={e=>setExpiry(e.target.value)}/></label>
     </div>
     {confirm===reviewSignature&&<p className="perm-review">确认向 {subject} 授予 {actionName(effectiveAction)}，仅当前目录。</p>}
     <RareButton type="button" className="secondary-action" onClick={()=>setRefresh(v=>v+1)}>刷新</RareButton>
     <RareButton className="primary" type="submit" disabled={!subject||!effectiveAction||isMutating}>{isMutating?"提交中…":confirm===reviewSignature?"确认授权":"预览授权"}</RareButton>
    </form>
   </>}
  </section>}
 </div>;
}
