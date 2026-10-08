import {useEffect,useState} from "react";
import {workflowApi} from "./api";
import type {Approval} from "./api";
import {errorCopy} from "../../shared/errors";
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
 },[message]);

 async function act(id:string,action:"approve"|"reject"|"cancel",comment:string){
  setMessage("");
  try{
   if(action==="approve")await workflowApi.approve(id,comment);
   if(action==="reject")await workflowApi.reject(id,comment);
   if(action==="cancel")await workflowApi.cancel(id);
   setMessage(action==="approve"?"已通过并生成新版本":action==="reject"?"已拒绝，当前版本不变":"已撤回申请");
  }catch(error){
   setMessage(errorCopy(error,"操作失败"));
  }
 }

 if(status!=="ready")return <p className="empty">{status==="loading"?"正在加载审批…":"获取审批列表失败"}</p>;

 return <div className="work-body">
  <div className="toolbar"><span className="toolbar-hint">待我审批 {inbox.length} · 我发起的 {mine.length}</span></div>
  {message&&<p role="status" className="notice">{message}</p>}
  <section className="table">
   <h3>待我审批</h3>
   <table>
    <thead><tr><th>文件</th><th>申请人</th><th>类型</th><th>基准版本</th><th>申请时间</th><th>操作</th></tr></thead>
    <tbody>
     {inbox.length===0&&<tr><td colSpan={6} className="empty">没有待处理的审批。</td></tr>}
     {inbox.map(a=><tr key={a.id}>
      <td><a href={"/preview/"+a.fileId}>{a.fileName}</a></td>
      <td>{a.requesterName}</td>
      <td>{ACTION_LABELS[a.action]??a.action}{a.rollbackTargetSeq?` → v${a.rollbackTargetSeq}`:""}</td>
      <td>v{a.baseSeq}</td>
      <td>{a.createdAt.replace("T"," ").slice(0,16)}</td>
      <td className="row-actions">
       <button type="button" className="primary" onClick={()=>act(a.id,"approve","同意")}>通过</button>
       <button type="button" className="danger" onClick={()=>act(a.id,"reject","内容需修改")}>拒绝</button>
      </td>
     </tr>)}
    </tbody>
   </table>
  </section>
  <section className="table">
   <h3>我发起的</h3>
   <table>
    <thead><tr><th>文件</th><th>类型</th><th>状态</th><th>审批人</th><th>意见</th><th>操作</th></tr></thead>
    <tbody>
     {mine.length===0&&<tr><td colSpan={6} className="empty">没有发起过审批。</td></tr>}
     {mine.map(a=><tr key={a.id}>
      <td><a href={"/preview/"+a.fileId}>{a.fileName}</a></td>
      <td>{ACTION_LABELS[a.action]??a.action}</td>
      <td>{STATE_LABELS[a.state]??a.state}</td>
      <td>{a.approverName}</td>
      <td>{a.decisionComment||"—"}</td>
      <td>{a.state==="pending"&&<button type="button" onClick={()=>act(a.id,"cancel","")}>撤回</button>}</td>
     </tr>)}
    </tbody>
   </table>
  </section>
  <p className="hint">审批通过后才生成新版本；待审期间预览与下载仍返回已签入内容。用户 {currentUser.displayName}。</p>
 </div>;
}
