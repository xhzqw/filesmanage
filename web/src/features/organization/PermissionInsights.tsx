import {RareButton,RareSelect} from "../../shared/ui/rare";
import {useEffect,useMemo,useRef,useState} from "react";
import type {User} from "../../entities/user/model";
import {errorCopy} from "../../shared/errors";
import {permissionsApi,type PermissionExplanation,type PermissionAuditPage} from "./permissionsApi";

const ACTIONS:Record<string,string>={
 list:"查看列表",preview:"预览",upload:"上传/新建",download:"下载",modify:"修改",
 delete:"删除",rename:"重命名",move:"移动",print:"打印",
};
const SOURCES:Record<string,string>={
 direct_acl:"用户直接授权",inherited_acl:"祖先目录授权",
 workgroup_acl:"工作组授权",folder_share:"目录共享",admin_override:"系统管理员覆盖",
};
const EVENTS:Record<string,string>={
 "acl.create":"新增目录授权","acl.revoke":"撤销目录授权",
 "workgroup.member_add":"加入工作组","workgroup.member_remove":"移出工作组",
 "user.create":"创建账号","user.disable":"禁用账号","user.enable":"启用账号",
 "user.password_reset":"重置登录密码",
 "share.create":"新增共享","share.revoke":"撤销共享",
};
const DETAIL_KEYS=new Set(["grantId","subjectKind","subjectId","actions","userId","groupId","disabled","recipientId","reason"]);
const AUDIT_FIELDS=new Set(["grantId","shareId","folderId","resourceKind","resourceId","subjectKind",
 "subjectId","recipientKind","recipientId","actions","scopeOnly","includeDescendants",
 "expiresAt","revoked","disabled","member","isAdmin","departmentId","mustChangePassword","sessionsRevoked"]);
const auditState=(raw:unknown)=>{
 if(raw===null)return "无";
 if(!raw||typeof raw!=="object"||Array.isArray(raw))return "—";
 return Object.entries(raw).filter(([k])=>AUDIT_FIELDS.has(k))
  .map(([k,v])=>k+"："+(v===null?"无":Array.isArray(v)?v.join("、"):String(v))).join("；")||"—";
};
const auditDetails=(details:Record<string,unknown>)=>{
 if("before" in details||"after" in details){
  const prefix=details.userId?"用户 "+String(details.userId)+" · ":"";
  return prefix+auditState(details.before)+" → "+auditState(details.after);
 }
 return Object.entries(details).filter(([key])=>DETAIL_KEYS.has(key))
  .map(([key,value])=>key+"："+(Array.isArray(value)?value.join("、"):String(value))).join(" · ")||"—";
};
const labelActions=(actions:string[])=>actions.map(a=>ACTIONS[a]??a).join("、");

// The service returns authoritative allowed actions and the applied sources
// from the same resolver. No client-side grant union is performed here.
export function PermissionInsights({folderId,users,usersState,refreshToken}:{
 folderId:string;users:User[];usersState:"loading"|"ready"|"failed";refreshToken:number;
}){
 const [subjectId,setSubjectId]=useState("");
 const [result,setResult]=useState<PermissionExplanation|null>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [generation,setGeneration]=useState(0);
 const activeUser=users.some(user=>user.id===subjectId)?subjectId:"";
 useEffect(()=>{setSubjectId("");setResult(null);setError("");},[folderId]);
 useEffect(()=>{
  if(!folderId||!activeUser){setResult(null);return;}
  let live=true;
  setBusy(true);setResult(null);setError("");
  permissionsApi.explain(activeUser,folderId).then(value=>{
   if(live){setResult(value);setBusy(false);}
  }).catch(e=>{if(live){setError(errorCopy(e,"无法读取有效权限"));setBusy(false);}});
  return()=>{live=false;};
 },[folderId,activeUser,generation,refreshToken]);
 return <section className="perm-insight perm-card" aria-label="有效权限解释">
  <div className="perm-section-title">有效权限 <span className="perm-subtle">只读</span></div>
  <div className="perm-insight-picker">
   <label>检查用户<RareSelect aria-label="检查用户的有效权限" value={activeUser} disabled={usersState!=="ready"} onChange={e=>setSubjectId(e.target.value)}>
    <option value="">请选择用户</option>
    {users.map(u=><option key={u.id} value={u.id}>{u.displayName}{u.login?"（"+u.login+"）":""}{u.disabled?" · 已禁用":""}</option>)}
   </RareSelect></label>
   <RareButton type="button" className="secondary-action" disabled={!activeUser||busy} onClick={()=>setGeneration(n=>n+1)}>重新计算</RareButton>
  </div>
  {!activeUser&&usersState==="ready"&&<div className="perm-insight-empty">选择用户后显示有效权限。</div>}
  {usersState==="failed"&&<p role="alert" className="hint">用户列表读取失败，请先在授权表单处重试。</p>}
  {busy&&<p role="status" className="hint">正在计算有效权限…</p>}
  {error&&<p role="alert" className="notice error">{error}</p>}
  {result&&result.folderId===folderId&&result.subjectId===activeUser&&<>
   {result.subjectDisabled&&<p className="notice">该账号已禁用，没有可使用的文件权限。</p>}
   <div className="perm-effective"><strong>当前有效动作</strong>
    {result.effectiveActions.length===0?<span>无（默认拒绝）</span>
     :result.effectiveActions.map(a=><span key={a} className="perm-action-token">{ACTIONS[a]??a}</span>)}
   </div>
   <div className="perm-source-list">
    <strong>生效来源（{result.sources.length}）</strong>
    {result.sources.map((source,i)=><div className="perm-source-row" key={(source.grantId??source.kind)+i}>
     <span>{SOURCES[source.kind]??source.kind}</span>
     <div><strong>{labelActions(source.actions)}</strong>
      <small>资源：{source.resourceId}
       {source.subjectKind==="group"?" · 工作组 "+source.subjectId:""}
       {source.depth>0?" · 继承 "+source.depth+" 层":""}
       {source.expiresAt?" · 到期 "+new Date(source.expiresAt).toLocaleString("zh-CN"):""}
      </small></div>
    </div>)}
    {result.sources.length===0&&<p className="hint">没有正在生效的授权来源。</p>}
   </div>
  </>}
 </section>;
}

export function PermissionAudit({users}:{users:User[]}){
 const [page,setPage]=useState<PermissionAuditPage>({items:[],nextCursor:""});
 const [busy,setBusy]=useState(true);
 const [moreBusy,setMoreBusy]=useState(false);
 const [error,setError]=useState("");
 const [version,setVersion]=useState(0);
 const queryGeneration=useRef(0);
 const names=useMemo(()=>new Map(users.map(u=>[u.id,u.displayName])),[users]);
 useEffect(()=>{
  let live=true;
  const generation=++queryGeneration.current;
  setBusy(true);setError("");
  permissionsApi.audit().then(data=>{
   if(live&&generation===queryGeneration.current){setPage(data);setBusy(false);}
  }).catch(e=>{
   if(live&&generation===queryGeneration.current){setError(errorCopy(e,"读取权限审计失败"));setBusy(false);}
  });
  return()=>{live=false;};
 },[version]);
 async function more(){
  if(!page.nextCursor||moreBusy)return;
  const generation=queryGeneration.current;
  setMoreBusy(true);setError("");
  try{const data=await permissionsApi.audit(page.nextCursor);
   if(generation===queryGeneration.current){
    setPage(old=>({...data,items:[...old.items,...data.items]}));
   }
  }catch(e){if(generation===queryGeneration.current)setError(errorCopy(e,"加载更多审计记录失败"));}
  finally{setMoreBusy(false);}
 }
 return <section className="perm-audit" aria-label="权限审计">
  <div className="perm-audit-header"><div><strong>权限变更审计</strong>
   <p className="hint">仅管理员可见，按事件顺序倒序显示授权、分享、工作组及账号启停操作。</p></div>
   <RareButton type="button" className="secondary-action" disabled={busy} onClick={()=>{
    queryGeneration.current++;setVersion(v=>v+1);
   }}>刷新</RareButton></div>
  {busy&&<p role="status" className="hint">正在读取审计记录…</p>}
  {error&&<p role="alert" className="notice error">{error}</p>}
  {!busy&&<div className="perm-audit-scroll">
   <table className="perm-table"><thead><tr><th>时间</th><th>变更</th><th>操作人</th><th>资源</th><th>变更前 → 变更后</th><th>结果</th><th>请求追踪</th></tr></thead>
    <tbody>{page.items.map(item=><tr key={item.id}>
     <td>{item.createdAt?new Date(item.createdAt).toLocaleString("zh-CN"):"—"}</td>
     <td>{EVENTS[item.eventType]??item.eventType}</td>
     <td>{names.get(item.actorId)??item.actorId}</td>
     <td>{item.targetKind} · {item.targetId}</td>
     <td className="perm-audit-detail">{auditDetails(item.details??{})}</td>
     <td>{item.outcome==="success"?"成功":item.outcome==="denied"?"拒绝":item.outcome}</td>
     <td><code title={item.requestId}>{item.requestId||"—"}</code></td>
    </tr>)}</tbody>
   </table>
   {page.items.length===0&&<p className="empty">暂无权限变更审计记录。</p>}
   {page.nextCursor&&<RareButton className="perm-more" type="button" disabled={moreBusy} onClick={()=>void more()}>
    {moreBusy?"正在加载…":"加载更多"}</RareButton>}
  </div>}
 </section>;
}
