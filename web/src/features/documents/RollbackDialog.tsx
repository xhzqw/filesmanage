import {RareButton,RareInput} from "../../shared/ui/rare";
import {toast} from "../../shared/ui/feedback";
import {useEffect,useRef,useState,type FormEvent}from"react";
import {fileApi}from"./api";
import {errorCode,errorCopy}from"../../shared/errors";
import {newIdempotencyKey}from"../../shared/ids";
import type {FileVersion}from"../../entities/file/model";
import {Dialog}from"../../shared/ui/Dialog";
import {MicroHoldToDelete}from"../../shared/ui/rare";

// Version rollback (COMPLEX-WORKFLOWS-v1 §7, WF-12..WF-16). A rollback appends a
// new immutable version, so the dialog takes a reason, acquires the edit lock
// against the live current seq, and sends the CAS + idempotency payload.
// Approval-routed folders answer 202 pending and must never read as committed;
// a 409 CAS conflict refreshes the history and forces a fresh confirmation.
export function RollbackDialog({fileId,currentSeq,version,onClose,onCommitted,onPending,onConflict,onRefresh}:{
 fileId:string;
 currentSeq:number;
 version:FileVersion;
 onClose:()=>void;
 onCommitted:(newSeq:number)=>void;
 onPending:()=>void;
 onConflict:()=>void;
 onRefresh:()=>void;
}){
 const[reason,setReason]=useState("");
 const[busy,setBusy]=useState(false);
 const[message,setMessage]=useState("");
 const[unknown,setUnknown]=useState(false);
 const lock=useRef("");

 useEffect(()=>()=>{
  // A failed rollback can leave our own lock behind; release it on close. A
  // committed rollback already released it server-side, so a 404 is expected
  // and ignored.
  if(lock.current)void fileApi.releaseLock(fileId,lock.current).catch(()=>undefined);
 },[fileId]);

 // The reason field keeps the native form submit (Enter); the hold-to-confirm
 // control is the deliberate pointer path and arrives without a form event.
 async function submit(event?:FormEvent<HTMLFormElement>){
  event?.preventDefault();
  if(busy||reason.trim()==="")return;
  setBusy(true);setMessage("");setUnknown(false);
  try{
   let lockToken="";
   try{
    lockToken=(await fileApi.acquireLock(fileId,currentSeq)).lockToken;
   }catch(error){
    // Approval-routed folders never hand out locks: the rollback itself routes
    // to a pending request, so it proceeds without a token.
    if(errorCode(error)!=="E_APPROVAL_PENDING")throw error;
   }
   lock.current=lockToken;
   const result=await fileApi.rollback(fileId,version.versionSeq,currentSeq,lockToken,reason.trim(),newIdempotencyKey());
   lock.current="";
   if(result.status==="pending"){toast.info("回滚已提交审批，当前文件版本未改变");onPending();return;}
   toast.success("已回滚并生成新的文件版本");
   onCommitted(result.versionSeq??0);
  }catch(error){
   const code=errorCode(error);
   if(code==="E_VERSION_CONFLICT"){toast.warning("版本已变化，请刷新后重新确认回滚");onConflict();return;}
   if(code==="E_APPROVAL_PENDING"){setMessage("该文件已有待处理的审批，请等待处理完成后再试");return;}
   if(code==="E_LOCKED"){
    let hint="文件被其他编辑锁定";
    try{
     const status=await fileApi.lockStatus(fileId);
     if(status.locked&&status.ownerName)hint=`文件被其他编辑锁定（持有者 ${status.ownerName}）`;
    }catch{/* keep the generic copy */}
    setMessage(hint);
    return;
   }
   if(code==="E_NETWORK"){
    // The request outcome is unknown: never claim success or failure.
    setUnknown(true);
    setMessage("网络中断，无法确认回滚是否已提交，请刷新查看状态。");
    toast.warning("回滚结果未确认，请刷新版本记录核对");
    return;
   }
   setMessage(errorCopy(error,"回滚失败"));
  }finally{
   setBusy(false);
  }
 }

 return <Dialog open title={`回滚到 v${version.versionSeq}`} onClose={onClose} closeGuard={()=>!busy} className="dialog rollback-dialog">
  <form onSubmit={submit}>
   <p>来源版本 v{version.versionSeq}（{version.createdBy} · {version.createdAt.replace("T"," ").slice(0,16)}） · 当前版本 v{currentSeq}</p>
   <p className="hint">回滚将生成新版本，不删除历史；审批目录的回滚先经审批人通过后生效。</p>
   <label htmlFor="rollback-reason">回滚原因（必填）</label>
   <RareInput id="rollback-reason" value={reason} onChange={e=>setReason(e.target.value)} disabled={busy} required/>
   {message&&<p role="alert" className="notice error">{message}</p>}
   <div className="dialog-actions">
    {unknown&&<RareButton type="button" className="secondary-action" onClick={onRefresh} disabled={busy}>刷新查看状态</RareButton>}
    <RareButton type="button" className="secondary-action" onClick={onClose} disabled={busy}>取消</RareButton>
    {/* 长按确认是刻意的指针路径；表单 onSubmit 仍让回车直接提交 */}
    <MicroHoldToDelete label="确认回滚" tone="brand" disabled={busy||reason.trim()===""} onConfirm={()=>submit()}/>
   </div>
  </form>
 </Dialog>;
}
