import {useEffect,useMemo,useState} from "react";
import {RareButton,RareNotice,RareTextarea,RareInput,RareSelect} from "../../shared/ui/rare";
import {toast} from "../../shared/ui/feedback";
import {errorCopy} from "../../shared/errors";
import {newIdempotencyKey} from "../../shared/ids";
import {cdwApi,type CDWQMSSpecialAuthority,type CDWQMSSpecialAlert,type CDWQMSSpecialPolicyImpact,type CDWQMSFormalInterruption,type CDWQMSLegacyAnomaly,type CDWQMSFormalNotice} from "./api";
import {CDWFormalLineagePanel} from "./CDWFormalLineagePanel";
import {CDWQMSPortfolioPanel} from "./CDWQMSPortfolioPanel";

type Scope={fileId:string;kind:"dhf"|"dmr";templateVersionId:string;policyReleaseId:string;
 nodes:Array<{nodeKey:string;label:string}>};

// Shared control: proposer in the existing formal initiation detail; independent
// document controller in the existing QMS review workspace.
export function CDWQMSSpecialAuthorityPanel({actorId,scope,onChange}:{
 actorId:string;scope?:Scope;onChange?:()=>void;
}){
 const [items,setItems]=useState<CDWQMSSpecialAuthority[]>([]);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [reason,setReason]=useState("");
 const [selectedId,setSelectedId]=useState("");
 const [statement,setStatement]=useState("");
 const [action,setAction]=useState<"verify"|"return"|"reject">("verify");
 const [nodeRefs,setNodeRefs]=useState<Record<string,{clauseRef:string;basisSummary:string}>>({});
 const [alerts,setAlerts]=useState<CDWQMSSpecialAlert[]>([]);
 const [impacts,setImpacts]=useState<CDWQMSSpecialPolicyImpact[]>([]);
 const [interruptions,setInterruptions]=useState<CDWQMSFormalInterruption[]>([]);
 const [lineageID,setLineageID]=useState("");
 const [legacy,setLegacy]=useState<CDWQMSLegacyAnomaly[]>([]);
 const [notices,setNotices]=useState<CDWQMSFormalNotice[]>([]);
 const [noticeLedger,setNoticeLedger]=useState<CDWQMSFormalNotice[]>([]);
 const [followupID,setFollowupID]=useState("");
 const [followupReason,setFollowupReason]=useState("");
 const [holdId,setHoldId]=useState("");
 const [holdReason,setHoldReason]=useState("");
 const [impactReason,setImpactReason]=useState("");
 const [impactDisposition,setImpactDisposition]=useState<"reapproval_required"|"no_effect_on_existing_records">("reapproval_required");
 const [impactSelected,setImpactSelected]=useState("");
 const [refresh,setRefresh]=useState(0);
 useEffect(()=>{
  let live=true;
  cdwApi.qmsSpecialList().then(page=>{if(live)setItems(page.items??[]);})
   .catch(e=>{if(live)setError(errorCopy(e,"专项签批依据列表加载失败"));});
  return()=>{live=false;};
 },[refresh,actorId]);
 useEffect(()=>{
  let live=true;
  cdwApi.qmsSpecialAlerts().then(page=>{if(live)setAlerts(page.items??[]);})
   .catch(e=>{if(live)setError(errorCopy(e,"专项审批通知加载失败"));});
  return()=>{live=false;};
 },[refresh,actorId]);
 useEffect(()=>{
  let live=true;
  cdwApi.qmsSpecialImpacts().then(page=>{if(live)setImpacts(page.items??[]);})
   .catch(e=>{if(live)setError(errorCopy(e,"制度变更影响评估加载失败"));});
  return()=>{live=false;};
 },[refresh,actorId]);
 useEffect(()=>{
  let live=true;
 cdwApi.qmsFormalInterruptions().then(page=>{if(live)setInterruptions(page.items??[]);})
   .catch(e=>{if(live)setError(errorCopy(e,"中途失效的正式审批记录加载失败"));});
  return()=>{live=false;};
 },[refresh,actorId]);
 useEffect(()=>{
  let live=true;
  Promise.all([cdwApi.qmsLegacyAnomalies(),cdwApi.qmsFormalNotices(),cdwApi.qmsFormalNoticeLedger()])
   .then(([pending,messages,ledger])=>{if(live){
    setLegacy(pending.items??[]);setNotices(messages.items??[]);setNoticeLedger(ledger.items??[]);
   }})
   .catch(e=>{if(live)setError(errorCopy(e,"历史异常审批与中断通知加载失败"));});
  return()=>{live=false;};
 },[refresh,actorId]);
 const shown=useMemo(()=>scope?
  items.filter(a=>a.fileId===scope.fileId&&a.templateVersionId===scope.templateVersionId):
  items.filter(a=>a.proposedBy!==actorId&&(a.status==="pending"||a.status==="verified")),
 [items,scope,actorId]);
 const active=shown.find(a=>a.id===selectedId)??shown[0];
 const verified=shown.some(a=>a.status==="verified"&&a.policyReleaseId===scope?.policyReleaseId);
 const canPropose=scope&&!shown.some(a=>a.status==="pending"||a.status==="verified");
 const claims=scope?.nodes.map(node=>({nodeKey:node.nodeKey,
  clauseRef:nodeRefs[node.nodeKey]?.clauseRef?.trim()||"",
  basisSummary:nodeRefs[node.nodeKey]?.basisSummary?.trim()||""}))||[];
 const completeClaims=claims.length>0&&new Set(claims.map(c=>c.nodeKey)).size===claims.length&&
  claims.every(c=>c.clauseRef.length>=2&&Array.from(c.basisSummary).length>=8);
 async function propose(){
  if(!scope||Array.from(reason.trim()).length<16||!completeClaims||busy)return;
  setBusy(true);setError("");
  try{
   await toast.track(()=>cdwApi.qmsSpecialPropose({fileId:scope.fileId,kind:scope.kind,
    templateVersionId:scope.templateVersionId,policyReleaseId:scope.policyReleaseId,
    reason:reason.trim(),nodeClaims:claims},newIdempotencyKey()),{
    loading:"正在登记专项签批依据…",success:"专项依据已登记，等待独立文控核验",
    error:e=>errorCopy(e,"专项签批依据登记失败")});
   setReason("");setNodeRefs({});setRefresh(v=>v+1);onChange?.();
  }catch(e){setError(errorCopy(e,"专项签批依据登记失败"));}
  finally{setBusy(false);}
 }
 async function review(){
  if(!active||active.proposedBy===actorId||Array.from(statement.trim()).length<16||busy)return;
  const selectedAction=active.status==="verified"?"revoke":action;
  setBusy(true);setError("");
  try{
   await toast.track(()=>cdwApi.qmsSpecialReview(active.id,selectedAction,statement.trim(),newIdempotencyKey()),{
    loading:selectedAction==="revoke"?"正在撤销专项依据…":"正在提交独立核验结论…",
    success:selectedAction==="revoke"?"专项签批依据已撤销":selectedAction==="return"?"已退回补充材料":selectedAction==="reject"?"已驳回依据":"已记录专项依据独立核验",
    error:e=>errorCopy(e,"无法完成专项文控处理")});
   setStatement("");setSelectedId("");setRefresh(v=>v+1);onChange?.();
  }catch(e){setError(errorCopy(e,"无法完成专项文控处理"));}
  finally{setBusy(false);}
 }
 async function acknowledge(id:string){
  try{
   await toast.track(()=>cdwApi.qmsSpecialAlertRead(id,newIdempotencyKey()),{
    loading:"正在确认通知…",success:"已知悉专项审批通知",
    error:e=>errorCopy(e,"确认通知失败")});
   setRefresh(v=>v+1);
  }catch(e){setError(errorCopy(e,"确认通知失败"));}
 }
 async function readInterruption(id:string){
  try{
   await toast.track(()=>cdwApi.qmsFormalNoticeRead(id,newIdempotencyKey()),{
    loading:"正在确认中断通知…",success:"已记录本人阅读确认",
    error:e=>errorCopy(e,"中断通知确认失败")});
   setRefresh(v=>v+1);
  }catch(e){setError(errorCopy(e,"中断通知确认失败"));}
 }
 async function followup(id:string){
  if(busy||Array.from(followupReason.trim()).length<16)return;
  setBusy(true);setError("");
  try{
   await toast.track(()=>cdwApi.qmsFormalFollowup(id,followupReason.trim(),newIdempotencyKey()),{
    loading:"正在登记人工督办…",success:"已登记人工督办，等待收件人确认",
    error:e=>errorCopy(e,"人工督办登记失败")});
   setFollowupID("");setFollowupReason("");setRefresh(v=>v+1);onChange?.();
  }catch(e){setError(errorCopy(e,"人工督办登记失败"));}
  finally{setBusy(false);}
 }
 async function quarantine(id:string){
  if(busy||Array.from(holdReason.trim()).length<16)return;
  setBusy(true);setError("");
  try{
   await toast.track(()=>cdwApi.qmsLegacyHold(id,holdReason.trim(),newIdempotencyKey()),{
    loading:"正在隔离异常审批…",success:"历史待审实例已隔离，原签署记录保留",
    error:e=>errorCopy(e,"历史审批隔离失败")});
   setHoldId("");setHoldReason("");setRefresh(v=>v+1);onChange?.();
  }catch(e){setError(errorCopy(e,"历史审批隔离失败"));}
  finally{setBusy(false);}
 }
 async function assessImpact(id:string){
  if(busy||Array.from(impactReason.trim()).length<16)return;
  setBusy(true);setError("");
  try{
   await toast.track(()=>cdwApi.qmsSpecialAssessImpact(
    id,impactDisposition,impactReason.trim(),newIdempotencyKey()),{
    loading:"正在记录制度变更影响评估…",success:"影响评估已留痕；新制度签批资格仍须重新核验",
    error:e=>errorCopy(e,"制度影响评估失败")});
   setImpactSelected("");setImpactReason("");setRefresh(v=>v+1);onChange?.();
  }catch(e){setError(errorCopy(e,"制度影响评估失败"));}
  finally{setBusy(false);}
 }
 return <section className="cdw-section" aria-label="DHF DMR 专项签批依据">
  <div className="cdw-section-head"><h3>{scope?"专用签批规定核验":"DHF / DMR 专项签批依据待办"}</h3>
   <RareButton type="button" tone="ghost" disabled={busy} onClick={()=>setRefresh(v=>v+1)}>刷新</RareButton>
  </div>
  {scope?<p className="cdw-section-note">
   {scope.kind==="dhf"?"设计历史文档（DHF）":"器械主文档（DMR）"}必须依据公司正式发布的专属签批规定；
   仅绑定通用质量程序、岗位任命或管理员提交都不能解锁。
  </p>:<p className="cdw-section-note">
   核对原始专属规定、适用文件、精确受控发行版本和模板节点后才能独立确认。提报人不能自审。
  </p>}
  {error&&<RareNotice tone="danger">{error}</RareNotice>}
  {!scope&&<CDWQMSPortfolioPanel/>}
  {!scope&&notices.some(n=>!n.readAt)&&<div className="cdw-review-digest" aria-label="审批中断通知">
   <small>需要本人确认的审批中断通知</small>
   {notices.filter(n=>!n.readAt).map(n=><div key={n.id} className="cdw-review-digest">
    <p className="cdw-section-note">原审批 {n.approvalInstanceId}：
     {n.eventKind==="legacy_quarantined"?"历史签批资格异常，经文控核验后已隔离":"制度变更后进行中的审批已经终止"}。
     历史签字保留，必须按现行制度重新审批。</p>
    {n.followupAt&&<p className="cdw-section-note">文控人工督办：{n.followupReason}（{new Date(n.followupAt).toLocaleString("zh-CN")}）</p>}
    <RareButton type="button" tone="neutral" onClick={()=>void readInterruption(n.id)}>已知悉</RareButton>
   </div>)}
  </div>}
  {!scope&&noticeLedger.some(n=>!n.readAt)&&<div className="cdw-review-digest" aria-label="逐人通知督办">
   <small>逐人通知闭环 · 文控核实</small>
   <p className="cdw-section-note">仅显示当前权限范围内最多100条记录；未确认不自动代表逾期违规，每条未读通知只可人工督办一次。</p>
   {noticeLedger.filter(n=>!n.readAt).map(n=><div className="cdw-review-digest" key={n.id}>
    <p className="cdw-section-note">原审批 {n.approvalInstanceId} · 收件人 {n.recipientId}</p>
    {n.followupAt?<p className="cdw-section-note">已督办：{n.followupReason} · {new Date(n.followupAt).toLocaleString("zh-CN")}</p>:
     <RareButton type="button" tone="neutral" disabled={busy}
      onClick={()=>{setFollowupID(followupID===n.id?"":n.id);setFollowupReason("");}}>
      {followupID===n.id?"取消督办":"人工督办"}
     </RareButton>}
    {followupID===n.id&&!n.followupAt&&<>
     <label>督办依据与处理要求
      <RareTextarea rows={3} value={followupReason} onChange={e=>setFollowupReason(e.target.value)}
       placeholder="请说明待确认事项和提醒依据（至少16字）"/>
     </label>
     <RareButton type="button" tone="primary" loading={busy}
      disabled={busy||Array.from(followupReason.trim()).length<16}
      onClick={()=>void followup(n.id)}>记录督办</RareButton>
    </>}
   </div>)}
  </div>}
  {!scope&&legacy.length>0&&<div className="cdw-review-digest" aria-label="历史待审资格异常">
   <small>历史待审审批异常（仅核实后可隔离）</small>
   {legacy.map(item=><div className="cdw-review-digest" key={item.approvalInstanceId}>
    <strong>{item.fileName}</strong>
    <p className="cdw-section-note">旧审批 {item.approvalInstanceId} · 已签署 {item.completedDecisions} 节点 · 当前专用审批资格不满足</p>
    <RareButton type="button" tone="neutral" disabled={busy}
     onClick={()=>{setHoldId(holdId===item.approvalInstanceId?"":item.approvalInstanceId);setHoldReason("");}}>
     {holdId===item.approvalInstanceId?"取消":"文控核实并隔离"}
    </RareButton>
    {holdId===item.approvalInstanceId&&<>
     <label>核实依据
      <RareTextarea rows={3} aria-label="历史待审异常隔离依据"
       value={holdReason} onChange={e=>setHoldReason(e.target.value)}
       placeholder="核对适用制度及签批资格，说明不能继续的原因（至少16字）"/>
     </label>
     <RareButton type="button" loading={busy} disabled={busy||Array.from(holdReason.trim()).length<16}
      onClick={()=>void quarantine(item.approvalInstanceId)}>确认受控隔离</RareButton>
    </>}
   </div>)}
  </div>}
  {!scope&&interruptions.length>0&&<div className="cdw-review-digest" aria-label="制度变更中断的正式审批">
   <small>因制度变更或授权撤销而终止的审批</small>
   <RareNotice tone="warning">这些审批已正式转为冲突终态，既有签署历史保留，不能继续原审批；须依据新版有效制度和授权重新发起。</RareNotice>
   {interruptions.map(item=><div className="cdw-review-digest" key={item.id}>
    <strong>{item.subjectName}</strong>
    <p className="cdw-section-note">原因：{item.cause==="authority_revoked"?"专项审批依据被撤销":
     item.cause==="pointer"?"制度有效版本已变更":"制度发行状态已变更"}
     {" · "}已签署 {item.completedDecisions} 节点；原待签 {item.interruptedNodes.length} 节点</p>
    <p className="cdw-section-note">原制度版本：{item.oldPolicyReleaseId}</p>
    <p className="cdw-section-note">原审批：{item.approvalInstanceId}</p>
    <RareButton type="button" tone="neutral" onClick={()=>setLineageID(item.approvalInstanceId===lineageID?"":item.approvalInstanceId)}>
     {lineageID===item.approvalInstanceId?"收起完整血缘":"查看审批责任链"}
    </RareButton>
   </div>)}
  </div>}
  {!scope&&lineageID&&<CDWFormalLineagePanel approvalId={lineageID} onClose={()=>setLineageID("")}/>}
  {!scope&&impacts.some(i=>i.state==="open")&&<div className="cdw-review-digest" aria-label="制度变更影响评估">
   <small>待处理的制度变更影响评估</small>
   {impacts.filter(i=>i.state==="open").map(impact=><div key={impact.id} className="cdw-review-digest">
    <p className="cdw-section-note">{impact.subjectName} · 适用制度已换版或失效，原专项授权不再适用新审批。</p>
    <RareButton type="button" tone="neutral" onClick={()=>{
     setImpactSelected(impactSelected===impact.id?"":impact.id);setImpactReason("");
    }}>{impactSelected===impact.id?"取消评估":"填写影响评估"}</RareButton>
    {impactSelected===impact.id&&<>
     <label>处理结论
      <RareSelect aria-label="制度变更影响结论" value={impactDisposition}
       onChange={e=>setImpactDisposition(e.target.value as typeof impactDisposition)}>
       <option value="reapproval_required">需要基于新版制度重新批准</option>
       <option value="no_effect_on_existing_records">仅确认已完成历史记录不受影响</option>
      </RareSelect>
     </label>
     <label>影响范围与判断依据
      <RareTextarea aria-label="制度变更影响评估说明" rows={3} value={impactReason}
       onChange={e=>setImpactReason(e.target.value)}
       placeholder="记录受影响节点、审批实例、已有文件和下一步要求（至少16字）"/>
     </label>
     <RareButton type="button" loading={busy}
      disabled={busy||Array.from(impactReason.trim()).length<16}
      onClick={()=>void assessImpact(impact.id)}>提交受控影响评估</RareButton>
    </>}
   </div>)}
  </div>}
  {alerts.filter(a=>!a.readAt).length>0&&<div className="cdw-review-digest" aria-label="专项签批通知">
   <small>专项签批状态通知</small>
   {alerts.filter(a=>!a.readAt).map(a=><div className="cdw-review-digest" key={a.id}>
    <p className="cdw-section-note">{a.kind.toUpperCase()} 专项依据
     {a.eventKind==="revoked"?"已撤销，相关节点不得继续按原授权审批":
      a.eventKind==="returned"?"已退回补充材料，需要重新提交":"已被驳回，需要新的合法依据"}。</p>
    <RareButton type="button" tone="neutral" onClick={()=>void acknowledge(a.id)}>已知悉</RareButton>
   </div>)}
  </div>}
  {scope&&<div className="cdw-review-digest">
   <small>{verified?"已通过独立核验":"尚未满足专项解锁前置条件"}</small>
   <p className="cdw-section-note">仅核对已生效的专用制度（例如《产品设计历史文档管理规定》或《产品器械主文档管理规定》），并由不同人员签署核验。</p>
   {canPropose&&<>
    <label>专项签批依据及适用范围
     <RareTextarea aria-label="专项签批依据说明" rows={3} value={reason} disabled={busy}
      onChange={e=>setReason(e.target.value)}
      placeholder="注明专属制度中的签批权限、适用对象和具体条款（至少 16 字）"/>
    </label>
    <div className="cdw-review-digest" aria-label="审批节点条款对应">
     <small>每一签批节点须提供专用制度条款（不得共享一个笼统结论）</small>
     {scope.nodes.map(node=><div className="cdw-review-digest" key={node.nodeKey}>
      <small>{node.label}</small>
      <label>制度条款编号
       <RareInput aria-label={node.label+"制度条款"} disabled={busy}
        value={nodeRefs[node.nodeKey]?.clauseRef||""} placeholder="例如 §4.2.3"
        onChange={e=>setNodeRefs(v=>({...v,[node.nodeKey]:{
         clauseRef:e.target.value,basisSummary:v[node.nodeKey]?.basisSummary||""}}))}/>
      </label>
      <label>本岗位与条款的适用性说明
       <RareTextarea aria-label={node.label+"条款适用性"} disabled={busy} rows={2}
        value={nodeRefs[node.nodeKey]?.basisSummary||""}
        onChange={e=>setNodeRefs(v=>({...v,[node.nodeKey]:{
         clauseRef:v[node.nodeKey]?.clauseRef||"",basisSummary:e.target.value}}))}
        placeholder="说明条款如何规定本节点的批准资格和适用范围"/>
      </label>
     </div>)}
    </div>
    <RareButton type="button" loading={busy} disabled={busy||Array.from(reason.trim()).length<16||!completeClaims}
     onClick={()=>void propose()}>{shown.length?"重新登记新版专用规定":"登记专项规定供文控复核"}</RareButton>
   </>}
  </div>}
  {shown.length===0&&!scope&&<p className="cdw-section-note">暂无您有权核验的专项签批依据。</p>}
  {shown.map(item=><RareButton type="button" key={item.id}
   className={"cdw-task-row"+(active?.id===item.id?" is-selected":"")}
   onClick={()=>{setSelectedId(item.id);setStatement("");setAction("verify");}}>
   <span className="cdw-task-copy"><strong>{item.fileName}</strong>
    <small>{item.kind.toUpperCase()} · {item.status==="pending"?"待独立核验":
     item.status==="verified"?"已核验，可撤销":item.status==="returned"?"已退回":
     item.status==="rejected"?"已驳回":"已撤销"}</small>
   </span>
  </RareButton>)}
  {active&&<div className="cdw-review-digest">
   <small>制度：{active.policyName}</small>
   <a className="cdw-text-link" href={cdwApi.qmsSpecialEvidenceUrl(active.id)}>
    下载并核对精确受控发行物 ↗
   </a>
   <RareNotice tone="info">该下载绑定专用制度真实发行 ID 与 SHA-256，不读取普通最新文件。已换版或失效的发行物不会自动回退到最新版本。</RareNotice>
   <p className="cdw-section-note">{active.reason}</p>
   <p className="cdw-section-note">版本绑定：{active.policyReleaseId} · 审批模板：{active.templateVersionId}</p>
   <div className="cdw-review-digest">
    <small>逐节点条款核对记录</small>
    {active.nodeClaims.map(node=><p className="cdw-section-note" key={node.nodeKey}>
     {node.nodeKey.replaceAll("_"," ")} · {node.clauseRef} · {node.basisSummary}
    </p>)}
   </div>
   {active.reviewReason&&<RareNotice tone="warning">{active.status==="returned"?"退回":"驳回"}依据：{active.reviewReason}</RareNotice>}
   {!scope&&<><label>{active.status==="verified"?"撤销理由":"独立核验结论"}
    <RareTextarea aria-label="专用制度独立核验结论" rows={3} value={statement}
     disabled={busy} onChange={e=>setStatement(e.target.value)}
     placeholder="记录制度原件、适用范围、节点签批资格和有效发行版本的核查结论（至少 16 字）"/>
   </label>
   {active.status==="pending"&&<label>核验处理
    <RareSelect aria-label="专项核验处理方式" disabled={busy} value={action}
     onChange={e=>setAction(e.target.value as "verify"|"return"|"reject")}>
     <option value="verify">核验通过（全部条款适用）</option>
     <option value="return">退回补证（可重新提报）</option>
     <option value="reject">驳回依据（不可沿用）</option>
    </RareSelect>
   </label>}
   <RareButton type="button" tone="primary" loading={busy}
    disabled={busy||Array.from(statement.trim()).length<16}
    onClick={()=>void review()}>{active.status==="verified"?"确认撤销专项签批依据":
     action==="return"?"确认退回并通知提报人":action==="reject"?"确认驳回并通知提报人":"确认独立核验专项签批依据"}</RareButton></>}
  </div>}
 </section>;
}
