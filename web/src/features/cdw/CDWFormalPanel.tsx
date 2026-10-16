import {useEffect,useRef,useState} from "react";
import {RareBadge,RareButton,RareNotice,RareTextarea} from "../../shared/ui/rare";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {cdwApi,type CDWFormalApproval,type CDWFormalDetail} from "./api";
import {newIdempotencyKey} from "../../shared/ids";
import {errorCopy} from "../../shared/errors";
import {ApiError} from "../../shared/http";
import {toast} from "../../shared/ui/feedback";
import {CDWFormalLineagePanel} from "./CDWFormalLineagePanel";

const stateCopy:Record<string,string>={waiting:"待前置审批",ready:"待决定",approved:"已批准",rejected:"已拒绝",skipped:"已终止"};
export function CDWFormalPanel({approval,onDecided}:{approval:CDWFormalApproval;onDecided:()=>void}){
 const [detail,setDetail]=useState<CDWFormalDetail|null>(null);
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState("");
 const [mode,setMode]=useState<"approve"|"reject"|null>(null);
 const [reason,setReason]=useState("");
 const [busy,setBusy]=useState(false);
 const key=useRef("");
 const last=useRef("");
 useEffect(()=>{
  let live=true;setDetail(null);setLoading(true);setError("");setMode(null);
  void cdwApi.formalDetail(approval.id).then(result=>{if(live)setDetail(result);})
   .catch(e=>{if(live)setError(errorCopy(e,"无法加载正式审批证据"));})
   .finally(()=>{if(live)setLoading(false)});
  return()=>{live=false};
 },[approval.id,approval.revision]);
 async function submit(){
  if(!mode||busy||(mode==="reject"&&!reason.trim()))return;
  const decisionKey=[approval.id,approval.revision,mode,reason.trim()].join("|");
  if(last.current!==decisionKey){last.current=decisionKey;key.current=newIdempotencyKey();}
  setBusy(true);
  try{
   await toast.track(()=>cdwApi.formalDecide(approval.id,approval.revision,mode,reason.trim(),key.current),{
    loading:"正在写入正式审批决定…",
    success:mode==="approve"?"正式审批决定已记录":"已拒绝当前冻结候选版本",
    error:e=>errorCopy(e,"正式审批提交失败")
   });
   last.current="";key.current="";onDecided();
  }catch(e){if(!(e instanceof ApiError&&e.httpStatus===0)){last.current="";key.current="";}}
  finally{setBusy(false);}
 }
 return <div className="cdw-detail-inner cdw-formal-pane">
  <div className="cdw-detail-header">
   <div><small>正式文件审批 · 独立于任务交付验收</small><h2>{approval.fileName??"冻结审批候选文件"}</h2></div>
   <RareBadge tone="warning">待正式批准</RareBadge>
  </div>
  <div className="cdw-detail-facts">
   <div><span>当前状态</span><strong>审批中（尚未生效）</strong></div>
   <div><span>审批轮次</span><strong>实例修订 {approval.revision}</strong></div>
   <div><span>版本来源</span><strong>已持久化冻结交付</strong></div>
  </div>
  <section className="cdw-section">
   <div className="cdw-section-head"><h3>审批对象 · 不可变内容</h3>
    <a className="cdw-text-link" href={"/api/workbench/formal-approvals/"+encodeURIComponent(approval.id)+"/content"}
      download="CDW-formal-candidate.docx">核对冻结稿 ↗</a>
   </div>
   <p className="cdw-section-note">请对照本次正式提交的冻结 DOCX 内容作决定；普通文件预览中的“最新版本”不作为正式审批依据。</p>
   <div className="cdw-review-digest"><small>候选内容 SHA-256</small><code title={approval.sha256}>{approval.sha256}</code></div>
  </section>
  {loading&&<div className="cdw-message"><BrandLoadingLabel showContext>读取审批时间线</BrandLoadingLabel></div>}
  {error&&<RareNotice tone="danger">{error} <RareButton type="button" onClick={onDecided}>重试</RareButton></RareNotice>}
  {detail&&<section className="cdw-section">
   <h3>审批节点与证据</h3>
   <div className="cdw-formal-timeline" aria-label="正式审批时间线">
    {detail.steps.map((step,index)=>{
     const decided=detail.decisions.find(d=>d.stepId===step.id);
     return <div className="cdw-formal-step" key={step.id}>
      <span className="cdw-formal-step-number">{index+1}</span>
      <span className="cdw-branch-text">
       <strong>{step.nodeKey} <small>· 第 {step.sequence} 级</small></strong>
       <small>{decided?new Date(decided.decidedAt).toLocaleString("zh-CN"):"待审批"} · {stateCopy[step.state]??step.state}</small>
       {decided?.reason&&<span className="cdw-formal-reason">{decided.reason}</span>}
      </span>
      <RareBadge tone={step.state==="approved"?"success":step.state==="ready"?"warning":"neutral"}>{stateCopy[step.state]??step.state}</RareBadge>
     </div>;
    })}
   </div>
  </section>}
  {detail&&<CDWFormalLineagePanel approvalId={approval.id}/>}
  <section className="cdw-section">
   <h3>当前节点决定</h3>
   <p className="cdw-section-note">系统在服务端再次检查您的正式审批角色、节点状态及乐观锁。批准后仅生成已批准候选版本，不会直接发行或生效。</p>
   <div className="cdw-review-actions">
    <RareButton type="button" tone={mode==="approve"?"primary":"neutral"} disabled={busy} onClick={()=>{setMode("approve");setReason("");}}>批准候选稿</RareButton>
    <RareButton type="button" tone={mode==="reject"?"primary":"neutral"} disabled={busy} onClick={()=>setMode("reject")}>拒绝审批</RareButton>
   </div>
   {mode&&<div className="cdw-review-form">
    <label>{mode==="reject"?"拒绝原因（必填）":"批准意见（可选）"}
     <RareTextarea value={reason} rows={4} maxLength={3000} onChange={e=>setReason(e.target.value)}
      placeholder={mode==="reject"?"说明拒绝的具体原因与修订要求":"补充审核依据与批准意见"}/>
    </label>
    <div className="cdw-review-actions">
     <RareButton type="button" tone="primary" loading={busy} disabled={busy||(mode==="reject"&&!reason.trim())}
      onClick={()=>void submit()}>{mode==="reject"?"确认拒绝":"确认批准"}</RareButton>
     <RareButton type="button" tone="ghost" disabled={busy} onClick={()=>setMode(null)}>取消</RareButton>
    </div>
   </div>}
  </section>
 </div>;
}
