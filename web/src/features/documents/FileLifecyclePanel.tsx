import {useEffect,useState} from "react";
import {RareBadge,RareButton,RareInput} from "../../shared/ui/rare";
import {Dialog} from "../../shared/ui/Dialog";
import {errorCopy} from "../../shared/errors";
import {fileApi,type FileLifecycle} from "./api";
import "./fileLifecycle.css";

export function FileLifecyclePanel({fileId,currentSeq,lifecycle,onUpdated}:{fileId:string;currentSeq:number;lifecycle:FileLifecycle|null;onUpdated:(value:FileLifecycle)=>void}){
 const[dueDate,setDueDate]=useState("");
 const[note,setNote]=useState("");
 const[busy,setBusy]=useState(false);
 const[confirmArchive,setConfirmArchive]=useState(false);
 const[error,setError]=useState("");
 useEffect(()=>{setDueDate(lifecycle?.dueAt?.slice(0,10)??"");setNote(lifecycle?.note??"");setError("");},[fileId,lifecycle?.updatedAt]);
 const isArchived=lifecycle?.state==="archived";
 const released=lifecycle?.state==="released";
 const pending=lifecycle===null;
 function dueUTC(){return dueDate?new Date(dueDate+"T23:59:59").toISOString():null;}
 async function update(action:"publish"|"archive"|"unarchive"|"set_due"){
  if(busy||!lifecycle)return;
  setBusy(true);setError("");
  try{
   const value=await fileApi.setLifecycle(fileId,{action,expectedVersionSeq:currentSeq,dueAt:dueUTC(),note:note.trim()});
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
  {pending?<p className="hint">正在读取状态…</p>:<>
   {lifecycle.state!=="draft"&&<div className="file-lifecycle-summary">
    <span>发布版本 <strong>v{lifecycle.publishedSeq}</strong>{lifecycle.publishedSeq!==currentSeq?" · 当前有未发布修改":""}</span>
    <span>到期日期 <strong>{lifecycle.dueAt?.slice(0,10)??"未设置"}</strong></span>
   </div>}
   {lifecycle.canManage&&<div className="file-lifecycle-form">
    <label>到期日期<RareInput type="date" aria-label="到期日期" value={dueDate} onChange={e=>setDueDate(e.target.value)} disabled={busy||isArchived}/></label>
    {!isArchived&&<label className="file-lifecycle-note">发布说明<RareInput value={note} maxLength={200} onChange={e=>setNote(e.target.value)} disabled={busy} placeholder="可选"/></label>}
    <div className="file-lifecycle-actions">
     {!isArchived&&<RareButton type="button" className="primary" disabled={busy} onClick={()=>void update("publish")}>发布当前 v{currentSeq}</RareButton>}
     {released&&<RareButton type="button" disabled={busy} onClick={()=>void update("set_due")}>保存到期日</RareButton>}
     {released&&<RareButton type="button" disabled={busy} onClick={()=>setConfirmArchive(true)}>归档</RareButton>}
     {isArchived&&<RareButton type="button" disabled={busy} onClick={()=>void update("unarchive")}>解除归档</RareButton>}
    </div>
   </div>}
  </>}
  {error&&<p role="alert" className="notice error">{error}</p>}
  {confirmArchive&&<Dialog open title="确认归档" onClose={()=>{if(!busy)setConfirmArchive(false);}} closeGuard={()=>!busy}>
   <p>归档后将禁止常规编辑、重命名、移动及删除。需要修改时先解除归档。</p>
   <div className="dialog-actions"><RareButton disabled={busy} onClick={()=>setConfirmArchive(false)}>取消</RareButton>
    <RareButton className="primary" disabled={busy} onClick={()=>void update("archive")}>{busy?"归档中…":"确认归档"}</RareButton></div>
  </Dialog>}
 </section>;
}
