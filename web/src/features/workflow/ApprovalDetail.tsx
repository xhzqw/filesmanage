import {RareBadge,RareButton} from "../../shared/ui/rare";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import type {Approval} from "./api";
import type {ApprovalEvent} from "./activityApi";

const stateLabels:Record<string,string>={pending:"待审批",approved:"已通过",rejected:"已拒绝",cancelled:"已撤回",conflicted:"冲突失效"};
const stateTones={pending:"warning",approved:"success",rejected:"danger",cancelled:"neutral",conflicted:"danger"} as const;
const eventLabels:Record<string,string>={submitted:"提交申请",advanced:"本级通过",approved:"最终通过",rejected:"拒绝",cancelled:"撤回",conflicted:"版本冲突"};
const dateTime=(value?:string)=>value?new Date(value).toLocaleString("zh-CN"):"—";
const fileSize=(size:number)=>size>=1048576?`${(size/1048576).toFixed(1)} MB`:size>=1024?`${(size/1024).toFixed(1)} KB`:`${size} B`;

type Decision="approve"|"reject"|"cancel";
export function ApprovalDetail({approval,events,historyLoading,historyError,onDecision,onReview,busy,canCancel,canReview}:{
 approval:Approval|null;
 events:ApprovalEvent[];
 historyLoading:boolean;
 historyError:string;
 onDecision:(approval:Approval,action:Decision)=>void;
 onReview:(approval:Approval)=>void;
 busy:boolean;
 canCancel:boolean;
 canReview:boolean;
}){
 if(!approval)return <div className="approval-detail-empty">选择左侧申请查看详情</div>;
 const isRollback=approval.action==="rollback";
 const history=events.filter(item=>item.approvalId===approval.id);
 return <div className="approval-detail-content" key={approval.id}>
  <div className="approval-detail-header">
   <div className="approval-detail-title" title={approval.fileName}>{approval.fileName}</div>
   <RareBadge tone={stateTones[approval.state]} dot>{stateLabels[approval.state]??approval.state}</RareBadge>
  </div>
  <div className="approval-detail-links">
   <a href={"/preview/"+encodeURIComponent(approval.fileId)}>查看已发布文件 ↗</a>
   {approval.state==="pending"&&<><RareButton type="button" className="approval-review-launch" onClick={()=>onReview(approval)}>核对待审内容</RareButton><a href={"/api/approvals/"+encodeURIComponent(approval.id)+"/draft"}>下载待审稿 ↓</a></>}
  </div>
  <div className="approval-detail-section">
   <h4>申请信息</h4>
   <dl className="approval-detail-facts">
    <div><dt>申请类型</dt><dd>{isRollback?"版本回滚":"内容修改"}</dd></div>
    <div><dt>申请人</dt><dd>{approval.requesterName||"—"}</dd></div>
    <div><dt>申请时间</dt><dd>{dateTime(approval.createdAt)}</dd></div>
    <div><dt>版本变更</dt><dd>v{approval.baseSeq} {isRollback?`→ v${approval.rollbackTargetSeq??"?"}`:"→ 待发布"}</dd></div>
    <div><dt>待审文件大小</dt><dd>{fileSize(approval.payloadSize)}</dd></div>
    {approval.decidedAt&&<div><dt>完成时间</dt><dd>{dateTime(approval.decidedAt)}</dd></div>}
   </dl>
  </div>
  <div className="approval-detail-section">
   <h4>申请原因</h4>
   <p className="approval-detail-reason">{approval.reason?.trim()||"申请人未填写说明"}</p>
   {approval.decisionComment&&<><h4 className="approval-detail-subtitle">审批意见</h4>
    <p className="approval-detail-reason">{approval.decisionComment}</p></>}
  </div>
  <div className="approval-detail-section">
   <h4>审批流程 <span>{Math.min(approval.stepIndex+1,approval.stepTotal)}/{approval.stepTotal} 级</span></h4>
   <ol className="approval-steps">
    {Array.from({length:approval.stepTotal},(_,index)=><li key={index}
     className={index<approval.stepIndex?"complete":index===approval.stepIndex?"current":""}>
     <span className="approval-step-mark">{index<approval.stepIndex?"✓":index+1}</span>
     <span>第 {index+1} 级{index===approval.stepIndex?` · ${approval.approverName||"待确认"}`:""}</span>
     <span className="approval-step-status">{index<approval.stepIndex?"已完成":index===approval.stepIndex?stateLabels[approval.state]:"未开始"}</span>
    </li>)}
   </ol>
  </div>
  <div className="approval-detail-section">
   <h4>流转记录</h4>
   {historyLoading&&<p className="approval-history-muted" role="status"><BrandLoadingLabel>正在读取记录…</BrandLoadingLabel></p>}
   {historyError&&<p className="approval-error" role="alert">{historyError}</p>}
   {!historyLoading&&!historyError&&history.length===0&&<p className="approval-history-muted">暂无记录</p>}
   {!historyLoading&&!historyError&&history.map(event=><div className="approval-event" key={event.id}>
    <div className="approval-event-content">
     <strong>{eventLabels[event.kind]??event.kind}</strong> · {event.actorName||event.actorId}
     <div className="approval-event-time">{dateTime(event.createdAt)} · 第 {event.stepIndex+1} 级</div>
     {event.comment&&<div className="approval-event-comment">{event.comment}</div>}
    </div>
   </div>)}
  </div>
  {approval.state==="pending"&&<div className="approval-detail-actions">
   {canReview&&<>
    <RareButton className="primary" type="button" disabled={busy} onClick={()=>onDecision(approval,"approve")}>通过</RareButton>
    <RareButton type="button" disabled={busy} onClick={()=>onDecision(approval,"reject")}>拒绝</RareButton>
   </>}
   {canCancel&&<RareButton type="button" disabled={busy} onClick={()=>onDecision(approval,"cancel")}>撤回申请</RareButton>}
  </div>}
 </div>;
}
