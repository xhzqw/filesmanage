import {useEffect,useRef,useState} from "react";
import {request} from "../../shared/http";
import {errorCopy} from "../../shared/errors";
import {RareButton,RareInput} from "../../shared/ui/rare";

type Dependency={id:string;predecessorStage:string;guardedAction:string;state:string};
type ProjectGraphNode={stageId:string;templateId:string;policySha:string;
 positionState:string;conditionalTemplateFlag:boolean;
 dependencies:{id:string;predecessorStage:string;guardedAction:string;allowConditional:boolean}[]};
type Readiness={
 submissionId:string;candidateId:string;projectId:string;stageId:string;
 templateId:string;policySha:string;manifestSha:string;
 dependencies:Dependency[];missingPreconditions:string[];
 projectGraph:ProjectGraphNode[];projectGraphSha?:string;
 strictRequestAllowed:boolean;conditionalRequestAllowed:boolean;
 reviewId?:string;reviewState?:string;trialOnly:boolean;formalAccepted:boolean;
};
type Outcome={reviewId?:string;state:string;replayed:boolean;trialOnly:boolean;formalAccepted:boolean};
const labels:Record<string,string>={
 "ENTERPRISE_GATE_AUTHORITY_NOT_APPROVED":"企业正式 Gate 授权及签署制度尚未获批",
};
const key=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,"0")).join("");

/** Review-intake only: does not activate an accepted Stage transition. */
export function DHFStageGateIntake({submissionId}:{submissionId:string}){
 const [data,setData]=useState<Readiness|null>(null);
 const [busy,setBusy]=useState(false);
 const [loading,setLoading]=useState(true);
 const [password,setPassword]=useState("");
 const [error,setError]=useState("");
 const [message,setMessage]=useState("");
 const [tick,setTick]=useState(0);
 const retry=useRef<string|null>(null);
 useEffect(()=>{
  let alive=true;setData(null);setLoading(true);setError("");
  void request<Readiness>("/workbench/dhf/gates/"+encodeURIComponent(submissionId)+"/readiness")
   .then(result=>{if(alive)setData(result)})
   .catch(err=>{if(alive)setError(errorCopy(err,"正式 Gate 审查状态无法核验"))})
   .finally(()=>{if(alive)setLoading(false)});
  return()=>{alive=false};
 },[submissionId,tick]);
 useEffect(()=>{setPassword("");setMessage("");retry.current=null},[submissionId]);
 async function file(){
  if(!data||busy||!password||!data.strictRequestAllowed||data.reviewId)return;
  setBusy(true);setError("");setMessage("");
  try{
   if(!retry.current)retry.current=key();
   const result=await request<Outcome>(
    "/workbench/dhf/gates/"+encodeURIComponent(submissionId)+"/review-request",
    {method:"POST",body:JSON.stringify({mode:"strict",password,idempotencyKey:retry.current})});
   if(!result.trialOnly||result.formalAccepted||result.state!=="awaiting_enterprise_authority"||!result.reviewId)
    throw Error("Stage Gate 审查申请响应不符合试点受控合同");
   retry.current=null;
   setMessage(result.replayed?"已核对原始审查申请记录":"已提交不可变 Gate 审查申请，等待企业正式制度及授权；未批准阶段");
   setTick(n=>n+1);
  }catch(err){setError(errorCopy(err,"Gate 审查申请未提交"))}
  finally{setBusy(false);setPassword("")}
 }
 return <section className="dhf-pilot-evidence" aria-label="正式 Stage Gate 验收准备">
  <h3>Stage Gate 验收申请 · 受控预备</h3>
  {loading?<p>正在核对已发布模板与阶段依赖…</p>:
   data?<div className="dhf-pilot-evidence-item">
    <strong>{data.reviewId?"已登记待授权验收申请":"尚未申请企业正式阶段验收"}</strong>
    <span>严格模式 · {data.stageId} · 原始候选 {data.candidateId}</span>
    <section aria-label="项目九阶段依赖全图">
     <strong>项目有效模板依赖图 · {data.projectGraph?.length??0} 个已配置阶段</strong>
     <span>仅展示项目已发布并激活的模板；没有配置的阶段不会被推定为已完成。</span>
     <div role="list">{(data.projectGraph??[]).map(node=><div key={node.stageId}
       role="listitem" className="dhf-pilot-evidence-item">
      <strong>{node.stageId}{node.stageId===data.stageId?" · 当前阶段":""} · {node.positionState}</strong>
      <span>模板 {node.templateId} · 直接依赖 {node.dependencies.length} 条</span>
      {node.dependencies.map(edge=><span key={edge.id}>
       {edge.predecessorStage} → {node.stageId} · {edge.guardedAction}
       {edge.allowConditional?" · 模板可建议受限放行（尚未授权）":""}
      </span>)}
     </div>)}</div>
     {data.projectGraphSha?<><span>已冻结项目依赖图 SHA-256</span>
       <code>{data.projectGraphSha}</code></>:null}
    </section>
    <span>已发布模板显式定义的上游依赖：{data.dependencies.length} 项。未定义的阶段关联不会自动推定。</span>
    {data.dependencies.map(dep=><div key={dep.id}>
     <span>{dep.predecessorStage} → {data.stageId} · {dep.guardedAction} · {dep.state==="accepted"?"正式已通过":"尚未正式通过"}</span>
    </div>)}
    {data.missingPreconditions.length?<div>
     <strong>阻断正式接受的条件</strong>
     {data.missingPreconditions.map(reason=><p key={reason}>
      {labels[reason]??(reason.startsWith("UNACCEPTED_PREDECESSOR:")?
        "显式依赖 "+reason.slice("UNACCEPTED_PREDECESSOR:".length)+" 尚未正式通过":reason)}
     </p>)}
    </div>:null}
    {data.reviewId?<><span>不可变审查申请：{data.reviewId}</span>
     <span>状态：待企业授权。原阶段未进入 accepted，也没有任何受控分发权限。</span></>:
     data.strictRequestAllowed?<div className="dhf-pilot-opinion">
      <label>申请人当前登录密码再认证
       <RareInput type="password" autoComplete="off" value={password}
        onChange={e=>setPassword(e.target.value)} placeholder="仅用于本次申请，不存储密码"/>
      </label>
      <RareButton type="button" disabled={busy||!password} onClick={()=>void file()}>
       {busy?"正在核对与登记…":"登记严格模式 Gate 验收申请"}
      </RareButton>
     </div>:null}
    {message?<p role="status">{message}</p>:null}
    <span>条件通过默认关闭；没有授权制度、时限和逐项整改，不可提出条件放行或正式接受。</span>
   </div>:<p>当前试点 Gate 尚不具备受控验收申请条件。</p>}
  {error?<p role="alert">{error}</p>:null}
 </section>;
}
