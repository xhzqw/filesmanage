import {useEffect,useState} from "react";
import {RareBadge,RareButton,RareInput,RareSelect} from "../../shared/ui/rare";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {toast} from "../../shared/ui/feedback";
import {Dialog} from "../../shared/ui/Dialog";
import {errorCopy} from "../../shared/errors";
import {fileApi,type FileLifecycle} from "./api";
import {request} from "../../shared/http";
import "./fileLifecycle.css";

export function FileLifecyclePanel({fileId,currentSeq,lifecycle,onUpdated}:{fileId:string;currentSeq:number;lifecycle:FileLifecycle|null;onUpdated:(value:FileLifecycle)=>void}){
 const[dueDate,setDueDate]=useState("");
 const[note,setNote]=useState("");
 const[userQuery,setUserQuery]=useState("");
 const[assignee,setAssignee]=useState("");
 const[users,setUsers]=useState<{id:string;name:string}[]>([]);
 const[userSearchError,setUserSearchError]=useState("");
 const[busy,setBusy]=useState(false);
 const[confirmArchive,setConfirmArchive]=useState(false);
 const[retentionDays,setRetentionDays]=useState(0);
 const[error,setError]=useState("");
 useEffect(()=>{setDueDate(lifecycle?.dueAt?.slice(0,10)??"");setNote(lifecycle?.note??"");setError("");},[fileId,lifecycle?.updatedAt]);
 const isArchived=lifecycle?.state==="archived";
 const released=lifecycle?.state==="released";
 const pending=lifecycle===null;
 const retentionActive=Boolean(lifecycle?.retentionUntil&&new Date(lifecycle.retentionUntil).getTime()>Date.now());
 useEffect(()=>{
  if(!lifecycle?.canManage||lifecycle.state!=="released")return;
  let live=true;
  request<{items:{id:string;name:string}[]}>("/share-recipients?"+new URLSearchParams({kind:"user",q:userQuery,limit:"40"}))
    .then(page=>{if(live){setUsers(page.items);setUserSearchError("");}})
    .catch(()=>{if(live)setUserSearchError("读取负责人失败");});
  return()=>{live=false};
 },[fileId,lifecycle?.canManage,lifecycle?.state,userQuery]);
 useEffect(()=>setAssignee(lifecycle?.responsibleId??lifecycle?.publishedBy??""),[fileId,lifecycle?.responsibleId,lifecycle?.publishedBy]);
 function dueUTC(){return dueDate?new Date(dueDate+"T23:59:59").toISOString():null;}
 async function update(action:"publish"|"archive"|"unarchive"|"set_due"|"assign"){
  if(busy||!lifecycle)return;
  setBusy(true);setError("");
  try{
   const labels={publish:"文档已发布",archive:"文档已归档",unarchive:"文档已解除归档",set_due:"到期日期已更新",assign:"负责人已更新"};
   const value=await toast.track(()=>fileApi.setLifecycle(fileId,{action,expectedVersionSeq:currentSeq,dueAt:dueUTC(),note:note.trim(),...(action==="archive"?{retentionDays}:{}),...(action==="assign"?{responsibleId:assignee}:{})}),{
    loading:"正在更新文档生命周期…",success:labels[action],error:e=>errorCopy(e,"生命周期更新失败")
   });
   onUpdated(value);setConfirmArchive(false);
  }catch(e){setError(errorCopy(e,"生命周期更新失败，请确认权限或当前版本状态"));}
  finally{setBusy(false);}
 }
 return <section className="file-lifecycle" aria-label="文档生命周期">
  <div className="file-lifecycle-heading">
   <strong>文档生命周期</strong>
   {lifecycle&&<RareBadge tone={isArchived?"warning":released?"success":"neutral"} dot>{isArchived?"已归档":released?"已发布":"未发布"}</RareBadge>}
   {lifecycle?.dueStatus==="soon"&&<RareBadge tone="warning">即将到期</RareBadge>}
   {lifecycle?.dueStatus==="overdue"&&<RareBadge tone="danger">已到期</RareBadge>}
  </div>
  {pending?<p className="hint"><BrandLoadingLabel>正在读取状态…</BrandLoadingLabel></p>:<>
   {lifecycle.state!=="draft"&&<div className="file-lifecycle-summary">
    <span>发布版本 <strong>v{lifecycle.publishedSeq}</strong>{lifecycle.publishedSeq!==currentSeq?" · 当前有未发布修改":""}</span>
    <span>到期日期 <strong>{lifecycle.dueAt?.slice(0,10)??"未设置"}</strong></span>
    {lifecycle.retentionUntil&&<span>保留至 <strong>{lifecycle.retentionUntil.slice(0,10)}</strong></span>}
   </div>}
   {lifecycle.canManage&&<div className="file-lifecycle-form">
    <label>到期日期<RareInput type="date" aria-label="到期日期" value={dueDate} onChange={e=>setDueDate(e.target.value)} disabled={busy||isArchived}/></label>
    {!isArchived&&<label className="file-lifecycle-note">发布说明<RareInput value={note} maxLength={200} onChange={e=>setNote(e.target.value)} disabled={busy} placeholder="可选"/></label>}
    {released&&<label>负责人查找<RareInput aria-label="查找提醒负责人" value={userQuery} onChange={e=>setUserQuery(e.target.value)} placeholder="姓名"/></label>}
    {released&&<label>提醒负责人<RareSelect aria-label="选择提醒负责人" value={assignee} onChange={e=>setAssignee(e.target.value)} disabled={busy}>
     <option value="">请选择</option>
     {assignee&&!users.some(u=>u.id===assignee)&&<option value={assignee}>{assignee}</option>}
     {users.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}
    </RareSelect></label>}
    <div className="file-lifecycle-actions">
     {!isArchived&&<RareButton type="button" className="primary" disabled={busy} onClick={()=>void update("publish")}>发布当前 v{currentSeq}</RareButton>}
     {released&&<RareButton type="button" disabled={busy} onClick={()=>void update("set_due")}>保存到期日</RareButton>}
     {released&&<RareButton type="button" disabled={busy||!assignee} onClick={()=>void update("assign")}>分配负责人</RareButton>}
     {released&&<RareButton type="button" disabled={busy} onClick={()=>setConfirmArchive(true)}>归档</RareButton>}
     {isArchived&&<RareButton type="button" disabled={busy||retentionActive} title={retentionActive?"保留期限内不可解除归档":undefined} onClick={()=>void update("unarchive")}>解除归档</RareButton>}
    </div>
   </div>}
  </>}
  {userSearchError&&<p role="alert" className="notice error">{userSearchError}</p>}
  {error&&<p role="alert" className="notice error">{error}</p>}
  {confirmArchive&&<Dialog open title="确认归档" onClose={()=>{if(!busy)setConfirmArchive(false);}} closeGuard={()=>!busy}>
   <p>归档后将禁止常规编辑、重命名、移动及删除。需要修改时先解除归档。</p>
   <label className="file-lifecycle-retention">保留期限
    <RareSelect aria-label="归档保留期限" value={retentionDays} onChange={e=>setRetentionDays(Number(e.target.value))} disabled={busy}>
     <option value={0}>不设置</option><option value={30}>30 天</option><option value={90}>90 天</option><option value={365}>1 年</option><option value={730}>2 年</option>
    </RareSelect>
   </label>
   {retentionDays>0&&<p>保留期内无法解除归档或删除，且保留期限不可缩短。</p>}
   <div className="dialog-actions"><RareButton disabled={busy} onClick={()=>setConfirmArchive(false)}>取消</RareButton>
    <RareButton className="primary" loading={busy} onClick={()=>void update("archive")}>确认归档</RareButton></div>
  </Dialog>}
 </section>;
}
