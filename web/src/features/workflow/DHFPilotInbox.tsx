import {useEffect,useRef,useState} from "react";
import {request} from "../../shared/http";
import {RareButton,RareInput,RareTextarea} from "../../shared/ui/rare";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {errorCopy} from "../../shared/errors";
import {DHFFrozenPagePreview} from "./DHFFrozenPagePreview";
import "./dhfPilotInbox.css";

type DHFTask={
 id:string;projectId:string;stageId:string;submissionId:string;
 reviewKey:string;status:string;gateReady:boolean;assignedAt:string;
};
type TaskResponse={items:DHFTask[];trialOnly:boolean};
type Duty={submissionId:string;projectId:string;stageId:string;taskId:string;reviewKey:string;stepOrdinal:number;reviewerId:string;status:string;earlyIntervention:boolean;interventionReason?:string;outstandingPrior:number;canAuthorizeEarly:boolean};

type FrozenEvidence={requirementId:string;fileId:string;fileName:string;versionSeq:number;sha256:string;sizeBytes:number};
type EvidencePreview={name:string;content:string;textual:boolean;renderer:string;sha256:string;truncated:boolean;fixedVersionVerified:boolean};
const displayStage:Record<string,string>={
 G5:"G5 · 设计开发输出",G6:"G6 · 首次设计开发转移",
};
const specialtyNames:Record<string,string>={
 "__gate__":"阶段总验收",
 "G5-SW":"软件专业复核","G5-MF":"生产工艺复核",
 "G5-HW":"硬件专业复核","G5-STRUCT":"结构专业复核",
 "G5-PKG":"包装专业复核","G5-USE":"可用性复核",
 "G5-QA":"综合资料复核",
};

export function DHFPilotInbox(){
 const [tasks,setTasks]=useState<DHFTask[]>([]);
 const [duties,setDuties]=useState<Duty[]>([]);
 const [dutyError,setDutyError]=useState("");
 const [earlyTarget,setEarlyTarget]=useState<string|null>(null);
 const [earlyReason,setEarlyReason]=useState("");
 const [earlyBusy,setEarlyBusy]=useState(false);
 const [earlyError,setEarlyError]=useState("");
 const earlyIntent=useRef<{taskId:string;reason:string;key:string}|null>(null);
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState("");
 const [refresh,setRefresh]=useState(0);
 const [query,setQuery]=useState("");
 const [selected,setSelected]=useState<string|null>(null);
 const [comment,setComment]=useState("");
 const [busy,setBusy]=useState(false);
 // Reuse the SAME idempotency key when a network failure leaves the result unknown.
 const pendingIntent=useRef<{taskId:string;outcome:string;comment:string;key:string}|null>(null);
 const [feedback,setFeedback]=useState("");
 const [recommendError,setRecommendError]=useState("");
 const [evidence,setEvidence]=useState<FrozenEvidence[]>([]);
 const [evidenceLoading,setEvidenceLoading]=useState(false);
 const [evidenceError,setEvidenceError]=useState("");
 const [preview,setPreview]=useState<{requirementId:string;result:EvidencePreview}|null>(null);
 const [previewError,setPreviewError]=useState("");
 const [previewBusy,setPreviewBusy]=useState(false);
 const [layout,setLayout]=useState<FrozenEvidence|null>(null);
 useEffect(()=>{
  let alive=true;
  setLoading(true);
  setError("");
  request<TaskResponse>("/workbench/dhf/tasks")
   .then(result=>{if(alive)setTasks(result.items??[]);})
   .catch(err=>{if(alive)setError(errorCopy(err,"DHF 审核任务加载失败"));})
   .finally(()=>{if(alive)setLoading(false);});
  return()=>{alive=false};
  let available=true;setDutyError("");
  void request<{items:Duty[]}>("/workbench/dhf/duties")
   .then(result=>{if(available)setDuties(result.items??[]);})
   .catch(err=>{if(available)setDutyError(errorCopy(err,"责任清单读取失败"));});
  return()=>{available=false};
 },[refresh]);
 const visible=tasks.filter(task=>[task.stageId,task.reviewKey,task.projectId,task.submissionId].some(value=>value.toLowerCase().includes(query.trim().toLowerCase())));
 const active=visible.find(task=>task.id===selected)??visible[0];
 const chain=duties.filter(item=>item.submissionId===active?.submissionId)
  .sort((a,b)=>a.stepOrdinal-b.stepOrdinal);
 const currentStep=chain.find(item=>item.taskId===active?.id);
 const allowedByOrder=Boolean(currentStep&&(
  currentStep.outstandingPrior===0||currentStep.earlyIntervention));
 useEffect(()=>{setComment("");setRecommendError("");},[active?.id]);
 useEffect(()=>{
  let valid=true;
  setEvidence([]);setEvidenceError("");setPreview(null);setPreviewError("");setLayout(null);
  if(!active){setEvidenceLoading(false);return}
  setEvidenceLoading(true);
  request<{items:FrozenEvidence[]}>("/workbench/dhf/tasks/"+encodeURIComponent(active.id)+"/evidence")
   .then(result=>{if(valid)setEvidence(result.items??[]);})
   .catch(err=>{if(valid)setEvidenceError(errorCopy(err,"冻结证据加载失败或无文件预览权限"));})
   .finally(()=>{if(valid)setEvidenceLoading(false)});
  return()=>{valid=false};
 },[active?.id]);
 async function showFixedEvidence(requirementId:string){
  if(!active||previewBusy)return;
  setPreview(null);setPreviewError("");setPreviewBusy(true);
  try{
   const result=await request<EvidencePreview>("/workbench/dhf/tasks/"+encodeURIComponent(active.id)+
    "/evidence/"+encodeURIComponent(requirementId)+"/preview");
   if(!result.fixedVersionVerified)throw new Error("没有确认受控文件的固定版本");
   setPreview({requirementId,result});
  }catch(err){setPreviewError(errorCopy(err,"受控版本校验失败或无权限"))}
  finally{setPreviewBusy(false)}
 }
 function openFrozenEvidence(item:FrozenEvidence){
  setLayout(null);setPreview(null);setPreviewError("");
  if(/\.(pdf|docx)$/i.test(item.fileName)){setLayout(item);return;}
  void showFixedEvidence(item.requirementId);
 }
 async function authorizeEarly(taskId:string){
  if(!active||earlyBusy)return;
  const reason=earlyReason.trim();
  if(reason.length<10)return;
  setEarlyBusy(true);setEarlyError("");
  try{
   if(!earlyIntent.current||earlyIntent.current.taskId!==taskId||
      earlyIntent.current.reason!==reason){
    const raw=crypto.getRandomValues(new Uint8Array(16));
    earlyIntent.current={taskId,reason,
     key:Array.from(raw,n=>n.toString(16).padStart(2,"0")).join("")};
   }
   await request("/workbench/dhf/tasks/"+encodeURIComponent(taskId)+"/early-intervention",
    {method:"POST",body:JSON.stringify({reason,idempotencyKey:earlyIntent.current.key})});
   earlyIntent.current=null;
   setEarlyTarget(null);setEarlyReason("");setRefresh(value=>value+1);
  }catch(err){setEarlyError(errorCopy(err,"提前介入记录失败，请核对责任范围"))}
  finally{setEarlyBusy(false)}
 }
 async function recommend(outcome:"recommend_pass"|"recommend_return"){
  if(!active||busy)return;
  setBusy(true);setRecommendError("");setFeedback("");
  try{
   const normalizedComment=comment.trim();
   if(!pendingIntent.current||pendingIntent.current.taskId!==active.id||
      pendingIntent.current.outcome!==outcome||pendingIntent.current.comment!==normalizedComment){
    const bytes=crypto.getRandomValues(new Uint8Array(16));
    pendingIntent.current={taskId:active.id,outcome,comment:normalizedComment,
      key:Array.from(bytes,n=>n.toString(16).padStart(2,"0")).join("")};
   }
   const idempotencyKey=pendingIntent.current.key;
   await request<{taskId:string;decisionId:string;status:string;trialOnly:boolean}>(
    "/workbench/dhf/tasks/"+encodeURIComponent(active.id)+"/recommendation",
    {method:"POST",body:JSON.stringify({outcome,comment,idempotencyKey})});
   pendingIntent.current=null;
   setTasks(items=>items.filter(item=>item.id!==active.id));
   setSelected(null);
   setFeedback("试点复核意见已记录，前序责任不因提前复核而免除。");
   setRefresh(value=>value+1);
  }catch(err){setRecommendError(errorCopy(err,"试点复核意见提交失败，请刷新并核对任务状态。"))}
  finally{setBusy(false)}
 }
 return <div className="dhf-pilot-shell">
  <section className="dhf-pilot-list" aria-label="DHF 阶段审核队列">
   <div className="dhf-pilot-toolbar">
    <strong>研发阶段审核</strong>
    <RareButton type="button" className="dhf-pilot-refresh" onClick={()=>setRefresh(i=>i+1)}>刷新</RareButton>
   </div>
   <div className="dhf-pilot-filter">
    <RareInput type="search" aria-label="筛选 DHF 审核任务" placeholder="搜索项目、阶段或提交" value={query} onChange={e=>setQuery(e.target.value)}/>
   </div>
   {loading?<div className="dhf-pilot-empty"><BrandLoadingLabel>正在加载</BrandLoadingLabel></div>:
    error?<div className="dhf-pilot-empty" role="alert">{error}</div>:
    visible.length===0?<div className="dhf-pilot-empty">暂无指派给我的阶段审核任务</div>:
    <div className="dhf-pilot-scroll">{visible.map(task=><RareButton type="button" key={task.id}
      className={"dhf-pilot-task"+(active?.id===task.id?" is-selected":"")}
      aria-pressed={active?.id===task.id} onClick={()=>setSelected(task.id)}>
      <span className="dhf-pilot-task-title">{specialtyNames[task.reviewKey]??task.reviewKey}</span>
      <span className="dhf-pilot-task-meta">{displayStage[task.stageId]??task.stageId} · {task.projectId}</span>
      <span className="dhf-pilot-task-date">{new Date(task.assignedAt).toLocaleString("zh-CN")}</span>
    </RareButton>)}</div>}
  </section>
  <section className="dhf-pilot-detail" aria-label="阶段审核详情">
   {feedback?<div className="dhf-pilot-feedback" role="status">{feedback}</div>:null}
   {active?<div className="dhf-pilot-content">
     <span className="dhf-pilot-overline">DHF / {active.stageId}</span>
     <h2>{specialtyNames[active.reviewKey]??active.reviewKey}</h2>
     <dl><div><dt>项目</dt><dd>{active.projectId}</dd></div>
       <div><dt>提交批次</dt><dd>{active.submissionId}</dd></div>
       <div><dt>当前状态</dt><dd>待专业核验</dd></div>
       <div><dt>派发时间</dt><dd>{new Date(active.assignedAt).toLocaleString("zh-CN")}</dd></div>
     </dl>
     {active.reviewKey==="__gate__"&&!active.gateReady?<p className="dhf-pilot-gate-wait">该阶段的专业复核尚未全部完成，暂不能提出总 Gate 通过建议。</p>:null}
     <section className="dhf-pilot-duty-chain" aria-label="阶段审核责任顺序">
      <h3>阶段责任链</h3>
      {dutyError?<p role="alert">{dutyError}</p>:
       chain.length===0?<p>责任链未加载，暂不能记录复核。</p>:
       <div className="dhf-pilot-duty-list">{chain.map(step=><div className="dhf-pilot-duty-row" key={step.taskId}>
        <span className="dhf-pilot-duty-order">{step.stepOrdinal}</span>
        <div>
         <strong>{specialtyNames[step.reviewKey]??step.reviewKey}</strong>
         <p>{step.status==="reviewed"?"已记录通过建议":step.status==="returned"?"已退回":"责任待履行"}
           {step.earlyIntervention?" · 允许提前复核，前序责任保留":""}</p>
         {step.earlyIntervention&&step.interventionReason?<p>{step.interventionReason}</p>:null}
        </div>
        {step.canAuthorizeEarly&&active.reviewKey==="__gate__"?
         <RareButton type="button" onClick={()=>{setEarlyTarget(step.taskId);setEarlyReason("");setEarlyError("");}}>
          授权提前介入
         </RareButton>:null}
       </div>)}</div>}
      {earlyTarget&&active.reviewKey==="__gate__"?<div className="dhf-pilot-early-form">
       <RareTextarea aria-label="提前介入理由" rows={3} value={earlyReason}
        onChange={e=>setEarlyReason(e.target.value)}
        placeholder="说明为何允许后续专业先复核，且明确前序责任不免除"/>
       {earlyError?<p role="alert">{earlyError}</p>:null}
       <RareButton type="button" disabled={earlyBusy||earlyReason.trim().length<10}
        onClick={()=>void authorizeEarly(earlyTarget)}>{earlyBusy?"正在记录…":"记录提前介入"}</RareButton>
       <RareButton type="button" disabled={earlyBusy} onClick={()=>setEarlyTarget(null)}>取消</RareButton>
      </div>:null}
      {currentStep&&currentStep.outstandingPrior>0&&!currentStep.earlyIntervention?
       <p className="dhf-pilot-gate-wait">前序责任尚有 {currentStep.outstandingPrior} 项未完成；本步骤须等待前序完成，或由总 Gate 指派责任人明确授权提前介入。</p>:null}
      <p>试点责任顺序不会替代具有身份核验的正式电子签署。</p>
     </section>
     <section className="dhf-pilot-evidence" aria-label="提交时冻结的证据">
      <h3>冻结证据</h3>
      {evidenceLoading?<p>正在核对证据清单…</p>:
       evidenceError?<p role="alert">{evidenceError}</p>:
       evidence.length===0?<p>该提交未绑定可查看的文件证据</p>:
       <div className="dhf-pilot-evidence-list">{evidence.map(item=><div className="dhf-pilot-evidence-item" key={item.requirementId}>
        <strong>{item.fileName}</strong>
        <span>要求 {item.requirementId} · 固定版本 v{item.versionSeq}</span>
        <code title="证据 SHA-256">{item.sha256}</code>
        <RareButton type="button" disabled={previewBusy} onClick={()=>openFrozenEvidence(item)}>
         校验并查看固定版本
        </RareButton>
       </div>)}</div>}
      {previewError?<p role="alert">{previewError}</p>:null}
      {layout&&active?<DHFFrozenPagePreview key={active.id+":"+layout.requirementId}
       taskId={active.id} requirementId={layout.requirementId}
       fileName={layout.fileName} versionSeq={layout.versionSeq}/>:null}
      {preview?<div className="dhf-pilot-evidence-preview" role="region" aria-label="受控证据预览">
       <strong>{preview.result.name} · 内容校验通过</strong>
       {preview.result.textual?<pre>{preview.result.content}</pre>:
         <p>原始字节及摘要已核验；此类型不能用摘要页面代替完整的受控排版预览。</p>}
       {preview.result.truncated?<p>此处仅显示有限长度的文本预览，完整原件仍按固定版本保存。</p>:null}
      </div>:null}
     </section>
     <div className="dhf-pilot-opinion">
      <RareTextarea aria-label="试点复核意见" value={comment} onChange={e=>setComment(e.target.value)}
       placeholder="记录复核说明；建议退回时必须填写原因" rows={3}/>
      {recommendError?<p role="alert" className="dhf-pilot-opinion-error">{recommendError}</p>:null}
      <div className="dhf-pilot-actions">
       <RareButton type="button" disabled={busy||!allowedByOrder||(active.reviewKey==="__gate__"&&!active.gateReady)}
        onClick={()=>void recommend("recommend_pass")}>{busy?"处理中…":"记录通过建议"}</RareButton>
       <RareButton type="button" disabled={busy||!allowedByOrder||!comment.trim()}
        onClick={()=>void recommend("recommend_return")}>记录退回建议</RareButton>
      </div>
     </div>
     <p className="dhf-pilot-disclaimer">本操作仅保存试点复核意见；普通预览默认不是冻结版本，须先核验对应受控文件的准确版本和内容。正式电子签署、阶段批准和文件发行均未启用。</p>
   </div>:<div className="dhf-pilot-empty">选择左侧任务，查看阶段与提交信息</div>}
  </section>
 </div>
}
