import {RareButton,RareInput} from "../../shared/ui/rare";
import {useEffect,useState} from "react";
import {workflowApi} from "./api";
import type {Approval} from "./api";
import {errorCode,errorCopy} from "../../shared/errors";
import type {User} from "../../entities/user/model";

const STATE_LABELS:Record<string,string>={
 pending:"待审批",
 approved:"已通过",
 rejected:"已拒绝",
 cancelled:"已撤回",
 conflicted:"冲突失效",
};

const ACTION_LABELS:Record<string,string>={
 edit:"内容修改",
 rollback:"版本回滚",
};

export function ApprovalInbox({currentUser}:{currentUser:User}){
 const[inbox,setInbox]=useState<Approval[]>([]);
 const[mine,setMine]=useState<Approval[]>([]);
 const[status,setStatus]=useState("loading");
 const[message,setMessage]=useState("");
 const[drafts,setDrafts]=useState<Record<string,string>>({});
 const[busyId,setBusyId]=useState("");
 const[reloadToken,setReloadToken]=useState(0);

 useEffect(()=>{
  let valid=true;
  setStatus("loading");
  Promise.all([workflowApi.approvals("inbox"),workflowApi.approvals("mine")])
   .then(([pending,requested])=>{
    if(!valid)return;
    setInbox(pending);setMine(requested);setStatus("ready");
   })
   .catch(()=>{if(valid)setStatus("failed");});
  return()=>{valid=false;};
 },[reloadToken]);

 // Per-decision comment (WF-31): the comment ships with the decision, one
 // in-flight decision blocks every row so a second click cannot double-submit,
 // a 409 state change reloads the list instead of trusting a stale outcome,
 // and a non-committed result never reads as 已通过/已拒绝.
 async function act(id:string,action:"approve"|"reject"|"cancel"){
  if(busyId!=="")return;
  setMessage("");setBusyId(id);
  try{
   if(action==="approve"){
    const result=await workflowApi.approve(id,drafts[id]??"");
    setMessage(result.status==="committed"?"已通过并生成新版本":"审批已受理，尚未生成新版本");
   }else if(action==="reject"){
    await workflowApi.reject(id,drafts[id]??"");
    setMessage("已拒绝，当前版本不变");
   }else{
    await workflowApi.cancel(id);
    setMessage("已撤回申请");
   }
   setReloadToken(token=>token+1);
  }catch(error){
   const code=errorCode(error);
   if(code==="E_VERSION_CONFLICT"||code==="E_APPROVAL_PENDING"){
    setMessage("审批状态已变化，请刷新");
    setReloadToken(token=>token+1);
   }else{
    setMessage(errorCopy(error,"操作失败"));
   }
  }finally{
   setBusyId("");
  }
 }

 if(status!=="ready")return <p className="empty">{status==="loading"?"正在加载审批…":"获取审批列表失败"}</p>;

 return <div className="work-body">
  <div className="toolbar"><span className="toolbar-hint">待我审批 {inbox.length} · 我发起的 {mine.length}</span></div>
  {message&&<p role="status" className="notice">{message}</p>}
  <section className="table">
   <h3>待我审批</h3>
   <table>
    <thead><tr><th scope="col">文件</th><th scope="col">申请人</th><th scope="col">类型</th><th scope="col">基准版本</th><th scope="col">申请时间</th><th scope="col">操作</th></tr></thead>
    <tbody>
     {inbox.length===0&&<tr><td colSpan={6} className="empty">没有待处理的审批。</td></tr>}
     {inbox.map(a=><tr key={a.id}>
      <td><a href={"/preview/"+a.fileId}>{a.fileName}</a></td>
      <td>{a.requesterName}</td>
      <td>{ACTION_LABELS[a.action]??a.action}{a.rollbackTargetSeq?` → v${a.rollbackTargetSeq}`:""}</td>
      <td>v{a.baseSeq}</td>
      <td>{a.createdAt.replace("T"," ").slice(0,16)}</td>
      <td className="row-actions">
       <RareInput aria-label={`审批意见 — ${a.fileName}`} placeholder="审批意见（可选）" value={drafts[a.id]??""}
        style={{minWidth:"180px"}} disabled={busyId!==""}
        onChange={e=>setDrafts(prev=>({...prev,[a.id]:e.target.value}))}/>
       {busyId===a.id&&<span className="toolbar-hint">处理中…</span>}
       <RareButton type="button" className="primary" disabled={busyId!==""} onClick={()=>act(a.id,"approve")}>通过</RareButton>
       <RareButton type="button" className="danger" disabled={busyId!==""} onClick={()=>act(a.id,"reject")}>拒绝</RareButton>
      </td>
     </tr>)}
    </tbody>
   </table>
  </section>
  <section className="table">
   <h3>我发起的</h3>
   <table>
    <thead><tr><th scope="col">文件</th><th scope="col">类型</th><th scope="col">状态</th><th scope="col">审批人</th><th scope="col">意见</th><th scope="col">操作</th></tr></thead>
    <tbody>
     {mine.length===0&&<tr><td colSpan={6} className="empty">没有发起过审批。</td></tr>}
     {mine.map(a=><tr key={a.id}>
      <td><a href={"/preview/"+a.fileId}>{a.fileName}</a></td>
      <td>{ACTION_LABELS[a.action]??a.action}</td>
      <td>{STATE_LABELS[a.state]??a.state}</td>
      <td>{a.approverName}</td>
      <td>{a.decisionComment||"—"}</td>
      <td>{a.state==="pending"&&<RareButton type="button" disabled={busyId!==""} onClick={()=>act(a.id,"cancel")}>撤回</RareButton>}</td>
     </tr>)}
    </tbody>
   </table>
  </section>
  <p className="hint">审批通过后才生成新版本；待审期间预览与下载仍返回已签入内容。用户 {currentUser.displayName}。</p>
 </div>;
}
