import {useEffect,useState} from "react";
import {RareBadge,RareNotice,RareButton} from "../../shared/ui/rare";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {errorCopy} from "../../shared/errors";
import {cdwApi,type CDWQMSFormalLineage} from "./api";

const stage:Record<string,string>={
 pending:"新审批进行中",approved:"新审批已批准",rejected:"审批已拒绝",
 conflicted:"原审批已终止",cancelled:"审批已取消",
};
const cause:Record<string,string>={
 pointer:"受控制度换版",release_status:"制度发行状态变更",
 authority_revoked:"专项签批资格撤销",legacy_quarantined:"历史异常核验隔离",
};

// Reused by the existing formal approval detail and QMS review workspace.
// Read-only evidence; no button can retroactively resume or approve an old flow.
export function CDWFormalLineagePanel({approvalId,onClose}:{
 approvalId:string;onClose?:()=>void;
}){
 const [chain,setChain]=useState<CDWQMSFormalLineage|null>(null);
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState("");
 const [exporting,setExporting]=useState(false);
 const [revision,setRevision]=useState(0);
 useEffect(()=>{
  let live=true;setLoading(true);setError("");setChain(null);
  cdwApi.qmsFormalLineage(approvalId)
   .then(result=>{if(live)setChain(result);})
   .catch(e=>{if(live)setError(errorCopy(e,"审批血缘记录读取失败"));})
   .finally(()=>{if(live)setLoading(false);});
  return()=>{live=false;};
 },[approvalId,revision]);
 async function exportAudit(segmented=false){
  if(exporting)return;
  setExporting(true);setError("");
  try{
   const res=await fetch("/api/workbench/qms-formal-lineage/"+encodeURIComponent(approvalId)+
    (segmented?"/audit-segmented":"/audit"),{
    method:"GET",credentials:"same-origin",cache:"no-store"});
   if(!res.ok)throw new Error("审计导出被服务端拒绝（HTTP "+res.status+"）；请检查文控权限与完整血缘");
   const blob=await res.blob();
   const href=URL.createObjectURL(blob);
   const a=document.createElement("a");a.href=href;
   a.download=segmented?"CDW-QMS-segmented-audit.json":"CDW-QMS-formal-audit.json";
   document.body.appendChild(a);a.click();a.remove();
   window.setTimeout(()=>URL.revokeObjectURL(href),1000);
  }catch(e){setError(errorCopy(e,"审计导出失败"));}
  finally{setExporting(false);}
 }
 const nodes=chain?.nodes??[];
 const interrupted=nodes.filter(n=>n.state==="conflicted").length;
 const restarted=nodes.filter(n=>Boolean(n.previousApprovalId)).length;
 const unread=nodes.reduce((sum,n)=>sum+n.noticeTotal-n.noticeRead,0);
 const current=nodes[nodes.length-1];
 return <section className="cdw-section" aria-label="正式审批血缘与责任闭环">
  <div className="cdw-section-head">
   <h3>受控审批追溯</h3>
   <div className="cdw-review-actions">
    <RareButton type="button" tone="ghost" onClick={()=>setRevision(v=>v+1)}>刷新</RareButton>
    {chain&&<RareButton type="button" tone="neutral" disabled={exporting||chain.truncated}
     onClick={()=>void exportAudit()}>{exporting?"审计包生成中…":"审计导出"}</RareButton>}
    {chain&&<RareButton type="button" tone="neutral" disabled={exporting}
     onClick={()=>void exportAudit(true)}>{exporting?"生成中…":"分段完整导出"}</RareButton>}
    {onClose&&<RareButton type="button" tone="ghost" onClick={onClose}>收起</RareButton>}
   </div>
  </div>
  {loading&&<BrandLoadingLabel showContext>核对审批血缘</BrandLoadingLabel>}
  {error&&<RareNotice tone="danger">{error}</RareNotice>}
  {chain&&<>
   <p className="cdw-section-note">每笔审批独立冻结、独立签批；只有满足权限和受控制度的新版审批才能成为旧审批的继承节点。通知确认不等于文件批准。</p>
   <div className="cdw-detail-facts" aria-label="审批技术闭环统计">
    <div><span>已中断审批</span><strong>{interrupted}</strong></div>
    <div><span>重新发起次数</span><strong>{restarted}</strong></div>
    <div><span>仍未确认通知</span><strong>{unread}</strong></div>
    <div><span>最新审批状态</span><strong>{current?stage[current.state]??current.state:"无"}</strong></div>
   </div>
   <p className="cdw-section-note">这是当前审批链的技术闭环统计，并非全公司合规率。导出仅对当前有权文控开放，包含每次签署授权快照与逐人通知事实。</p>
   <div className="cdw-formal-timeline">
    {chain.nodes.map((n,i)=><div className="cdw-formal-step" key={n.approvalId}>
     <span className="cdw-formal-step-number">{i+1}</span>
     <span className="cdw-branch-text">
      <strong>{n.fileName||"正式受控文件"} · {stage[n.state]??n.state}</strong>
      <small>{new Date(n.requestedAt).toLocaleString("zh-CN")} · 通过 {n.approvedCount}/{n.stepCount} 节点
       {n.rejectedCount>0?" · 拒绝 "+n.rejectedCount:""}
       {n.pendingCount>0?" · 待签 "+n.pendingCount:""}</small>
      {n.previousApprovalId&&<small>承接原审批：{n.previousApprovalId}</small>}
      {n.interruptionReason&&<small>中断依据：{cause[n.interruptionReason]??n.interruptionReason}</small>}
      <small>冻结文件 SHA-256：<code title={n.sha256}>{n.sha256.slice(0,14)}…{n.sha256.slice(-10)}</code></small>
      <small>制度发行版本：{n.policyReleaseId||"不适用专用制度"}</small>
      {n.noticeTotal>0&&<small>中断通知确认：{n.noticeRead}/{n.noticeTotal} 人
       {n.noticeRead<n.noticeTotal?" · 尚有人未确认":" · 已全部确认"}</small>}
      {n.state==="approved"&&n.candidateId&&<small>已批准候选版本：{n.candidateId}（尚不代表受控发行生效）</small>}
     </span>
     <RareBadge tone={n.state==="approved"?"success":n.state==="pending"?"warning":"neutral"}>
      {stage[n.state]??n.state}
     </RareBadge>
    </div>)}
   </div>
   {chain.truncated&&<RareNotice tone="warning">当前仅展示有限节点。可申请最多512节点的分段完整审计包；若链路更长，服务端仍将拒绝并提示需要扩展审计工具。</RareNotice>}
   {chain.nodes[chain.nodes.length-1]?.state==="conflicted"&&
    <RareNotice tone="warning">当前审批链以冲突终止结束。须从新的受控交付稿重新发起，不允许继续原审批。</RareNotice>}
  </>}
 </section>;
}
