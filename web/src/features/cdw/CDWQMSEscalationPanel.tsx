import {useEffect,useState} from "react";
import {cdwApi,type CDWQMSEscalationCase,type CDWQMSEscalationPolicy,
 type CDWQMSFormalNotice,type CDWQMSPortfolioItem} from "./api";
import {RareButton,RareInput,RareTextarea,RareNotice,RareSelect} from "../../shared/ui/rare";
import {newIdempotencyKey} from "../../shared/ids";
import {errorCopy} from "../../shared/errors";
import {toast} from "../../shared/ui/feedback";

export function CDWQMSEscalationPanel({actorId,notices,onChange}:{
 actorId:string;notices:CDWQMSFormalNotice[];onChange?:()=>void;
}){
 const [policies,setPolicies]=useState<CDWQMSEscalationPolicy[]>([]);
 const [cases,setCases]=useState<CDWQMSEscalationCase[]>([]);
 const [files,setFiles]=useState<CDWQMSPortfolioItem[]>([]);
 const [refresh,setRefresh]=useState(0);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [showForm,setShowForm]=useState(false);
 const [fileID,setFileID]=useState("");
 const [sourceID,setSourceID]=useState("");
 const [clause,setClause]=useState("");
 const [delay,setDelay]=useState("1440");
 const [owner,setOwner]=useState("");
 const [reason,setReason]=useState("");
 const [selected,setSelected]=useState("");
 const [selectedReason,setSelectedReason]=useState("");
 useEffect(()=>{
  let live=true;setError("");
  Promise.all([cdwApi.qmsEscalationPolicies(),cdwApi.qmsEscalationCases(),cdwApi.qmsFormalPortfolio()])
   .then(([rules,issues,portfolio])=>{if(live){
    setPolicies(rules.items??[]);setCases(issues.items??[]);setFiles(portfolio.items??[]);
   }})
   .catch(e=>{if(live)setError(errorCopy(e,"受控升级规则加载失败"));});
  return()=>{live=false;};
 },[actorId,refresh]);
 const run=async(task:()=>Promise<unknown>,message:string)=>{
  if(busy)return;setBusy(true);setError("");
  try{
   await toast.track(task,{loading:"正在核验受控升级权限…",success:message,
    error:e=>errorCopy(e,"受控升级操作失败")});
   setSelected("");setSelectedReason("");setRefresh(v=>v+1);onChange?.();
  }catch(e){setError(errorCopy(e,"受控升级操作失败"));}
  finally{setBusy(false);}
 };
 const eligible=notices.filter(n=>!n.readAt&&Boolean(n.followupAt)&&
  policies.some(p=>p.targetFileId===n.fileId&&p.status==="verified")&&
  !cases.some(c=>c.noticeId===n.id));
 return <section className="cdw-section" aria-label="受控通知升级及异常闭环">
  <div className="cdw-section-head">
   <h3>受控通知升级</h3>
   <div className="cdw-review-actions">
    <RareButton type="button" tone="ghost" onClick={()=>setRefresh(v=>v+1)}>刷新</RareButton>
    <RareButton type="button" tone="neutral" onClick={()=>setShowForm(v=>!v)}>
     {showForm?"收起规则登记":"登记升级依据"}
    </RareButton>
   </div>
  </div>
  <p className="cdw-section-note">仅允许引用现行有效制度、经独立文控核验的**站内人工升级**。无默认期限，无自动发送；已读通知、未人工督办通知和失效制度均无法升级。</p>
  {error&&<RareNotice tone="danger">{error}</RareNotice>}
  {showForm&&<div className="cdw-review-digest">
   <label>适用文件
    <RareSelect value={fileID} onChange={e=>setFileID(e.target.value)}>
     <option value="">选择有权文件</option>
     {files.map(f=><option key={f.fileId} value={f.fileId}>{f.fileName}</option>)}
    </RareSelect>
   </label>
   <label>已生效的制度发行 ID
    <RareInput value={sourceID} onChange={e=>setSourceID(e.target.value)} placeholder="需核对受控发行台账"/>
   </label>
   <label>原制度明确条款
    <RareInput value={clause} onChange={e=>setClause(e.target.value)} placeholder="例如 §4.3.2"/>
   </label>
   <label>制度规定的通知时限（分钟）
    <RareInput type="number" min={60} max={525600} value={delay} onChange={e=>setDelay(e.target.value)}/>
   </label>
   <label>指定接手人账号 ID
    <RareInput value={owner} onChange={e=>setOwner(e.target.value)} placeholder="需要具备有效文控任命"/>
   </label>
   <label>制度与任命核验依据
    <RareTextarea rows={3} value={reason} onChange={e=>setReason(e.target.value)} placeholder="不少于16字；填写真实生效条款及授权"/>
   </label>
   <RareButton type="button" tone="primary" disabled={busy||!fileID||!sourceID||!owner||
    clause.trim().length<3||Array.from(reason.trim()).length<16||
    !(Number(delay)>=60&&Number(delay)<=525600)}
    onClick={()=>void run(()=>cdwApi.qmsEscalationPropose({
     targetFileId:fileID,policyReleaseId:sourceID,clauseRef:clause.trim(),
     delayMinutes:Number(delay),ownerId:owner,reason:reason.trim()},newIdempotencyKey()),
     "升级依据已登记，等待另一位有权文控核验")}>提交待核验规则</RareButton>
  </div>}
  {policies.map(p=><div className="cdw-review-digest" key={p.id}>
   <strong>{files.find(f=>f.fileId===p.targetFileId)?.fileName??"受控文件"} · {p.status==="verified"?"已核验":p.status==="revoked"?"已撤销":"待独立核验"}</strong>
   <p className="cdw-section-note">{p.clauseRef} · 原文规定 {p.delayMinutes} 分钟 · 接手人 {p.ownerId}</p>
   {p.status!=="revoked"&&p.proposedBy!==actorId&&p.verifiedBy!==actorId&&
    <RareButton type="button" tone="neutral" disabled={busy}
     onClick={()=>{setSelected(selected===p.id?"":p.id);setSelectedReason("");}}>
     {p.status==="verified"?"独立撤销规则":"独立核验"}
    </RareButton>}
   {selected===p.id&&p.status!=="revoked"&&<div>
    <RareTextarea rows={2} value={selectedReason} onChange={e=>setSelectedReason(e.target.value)}
     placeholder={p.status==="verified"?"说明撤销原因及受控规定变化（至少16字）":"确认制度当前生效、条款、期限与接手任命（至少16字）"}/>
    <RareButton type="button" tone="primary" disabled={busy||Array.from(selectedReason.trim()).length<16}
     onClick={()=>void run(()=>p.status==="verified"?
      cdwApi.qmsEscalationRevoke(p.id,selectedReason.trim(),newIdempotencyKey()):
      cdwApi.qmsEscalationVerify(p.id,selectedReason.trim(),newIdempotencyKey()),
      p.status==="verified"?"旧升级规则已受控撤销":"升级规则已独立核验")}>
      {p.status==="verified"?"确认撤销":"确认规则"}</RareButton>
   </div>}
  </div>)}
  {eligible.length>0&&<div className="cdw-review-digest">
   <strong>已人工督办、尚未确认的通知</strong>
   {eligible.map(n=><div key={n.id}>
    <p className="cdw-section-note">{files.find(f=>f.fileId===n.fileId)?.fileName??"受控文件"} · 收件人 {n.recipientId}</p>
    <RareButton type="button" tone="neutral" disabled={busy}
     onClick={()=>{setSelected(selected===n.id?"":n.id);setSelectedReason("");}}>按生效规则申请升级</RareButton>
    {selected===n.id&&<div>
     <RareTextarea rows={2} value={selectedReason} onChange={e=>setSelectedReason(e.target.value)}
      placeholder="请说明本次升级的事实依据（不少于16字）"/>
     <RareButton type="button" tone="primary" disabled={busy||Array.from(selectedReason.trim()).length<16}
      onClick={()=>void run(()=>cdwApi.qmsEscalationOpen(n.id,
       policies.find(p=>p.targetFileId===n.fileId&&p.status==="verified")!.id,
       selectedReason.trim(),newIdempotencyKey()),"升级已登记，待授权人员处理")}>申请受控升级</RareButton>
    </div>}
   </div>)}
  </div>}
  {cases.filter(c=>!c.resolvedAt).map(c=><div className="cdw-review-digest" key={c.id}>
   <strong>升级事项待关闭 · {files.find(f=>f.fileId===c.targetFileId)?.fileName??"受控文件"}</strong>
   <p className="cdw-section-note">接手人 {c.ownerId} · 发起人 {c.escalatedBy} · {new Date(c.escalatedAt).toLocaleString("zh-CN")}</p>
   {actorId!==c.escalatedBy&&<RareButton type="button" tone="neutral" disabled={busy}
    onClick={()=>{setSelected(selected===c.id?"":c.id);setSelectedReason("");}}>独立登记处理结论</RareButton>}
   {selected===c.id&&actorId!==c.escalatedBy&&<div>
    <RareTextarea rows={2} value={selectedReason} onChange={e=>setSelectedReason(e.target.value)}
     placeholder="填写实际处置证据与独立核验结论（不少于16字）"/>
    <RareButton type="button" tone="primary" disabled={busy||Array.from(selectedReason.trim()).length<16}
     onClick={()=>void run(()=>cdwApi.qmsEscalationResolve(c.id,selectedReason.trim(),newIdempotencyKey()),
      "升级事项已保存独立关闭记录")}>确认结案</RareButton>
   </div>}
  </div>)}
 </section>;
}
