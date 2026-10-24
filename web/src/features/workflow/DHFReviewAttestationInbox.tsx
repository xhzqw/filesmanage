import {useEffect,useRef,useState} from "react";
import {request} from "../../shared/http";
import {RareButton,RareInput} from "../../shared/ui/rare";
import {errorCopy} from "../../shared/errors";
import {DHFStageGateIntake} from "./DHFStageGateIntake";
import "./dhfPilotInbox.css";

type SignedReview={
 taskId:string;decisionId:string;submissionId:string;
 projectId:string;stageId:string;reviewKey:string;
 outcome:string;reviewComment:string;
 policySha:string;manifestSha:string;
 outstandingPrior:number;canAttest:boolean;
 attestationId?:string;contentSha?:string;
};
type SigningResponse={items:SignedReview[];trialOnly:boolean;signIntent:string};
type GateVerification={
 submissionId:string;candidateId?:string;candidateStatus:"not_issued"|"trial_candidate";
 cryptographicValid:boolean;signatureDomain?:string;signatureReason?:string;
 credentialId?:string;credentialStatus:string;credentialExpiresAt?:string;
 signerId?:string;payloadSha?:string;keySha?:string;
 missingPreconditions:string[];trialOnly:boolean;formalAccepted:boolean;
};
type AttestationOutcome={attestationId:string;taskId:string;contentSha:string;trialOnly:boolean;replayed:boolean};
const LABELS:Record<string,string>={
 "__gate__":"阶段总复核","G5-SW":"软件专业复核","G5-MF":"制造专业复核",
};
const localIntent="I confirm this DHF review opinion and its fixed evidence identity";
const gateReasons:Record<string,string>={
 NO_REVIEW_OBLIGATIONS:"尚未建立完整的审核责任",
 UNSIGNED_REVIEW_OBLIGATIONS:"仍有专业审核或本人签审未完成",
 REMEDIATION_NOT_VERIFIED:"整改尚未完成独立复验",
 SIGNING_CREDENTIAL_NOT_ACTIVE:"当前没有有效的试点签署凭证",
};
const credentialLabels:Record<string,string>={
 unregistered:"未登记",unactivated:"未激活",activate:"已激活",suspend:"已暂停",
 revoke:"已撤销",replace:"已替换",expired:"已到期",
 not_yet_valid:"尚未生效",legacy_unbound:"历史候选（未关联凭证）",
 trust_anchor_missing:"信任公钥未配置",
};

export function DHFReviewAttestationInbox(){
 const [rows,setRows]=useState<SignedReview[]>([]);
 const [selected,setSelected]=useState<string|null>(null);
 const [loading,setLoading]=useState(true);
 const [refresh,setRefresh]=useState(0);
 const [error,setError]=useState("");
 const [password,setPassword]=useState("");
 const [acknowledged,setAcknowledged]=useState(false);
 const [busy,setBusy]=useState(false);
 const [submitError,setSubmitError]=useState("");
 const [message,setMessage]=useState("");
 const [serverIntent,setServerIntent]=useState("");
 const [gateResult,setGateResult]=useState<GateVerification|null>(null);
 const [gateLoading,setGateLoading]=useState(false);
 const [gateError,setGateError]=useState("");
 const intent=useRef<{taskId:string;decisionId:string;key:string}|null>(null);
 useEffect(()=>{
  let live=true;setLoading(true);setError("");
  void request<SigningResponse>("/workbench/dhf/attestations")
   .then(resp=>{if(live){setRows(resp.items??[]);setServerIntent(resp.signIntent??"");}})
   .catch(err=>{if(live)setError(errorCopy(err,"签审确认队列读取失败"));})
   .finally(()=>{if(live)setLoading(false)});
  return()=>{live=false};
 },[refresh]);
 const active=rows.find(x=>x.taskId===selected)??rows[0];
 useEffect(()=>{
  let live=true;setGateResult(null);setGateError("");
  if(active?.reviewKey!=="__gate__"){setGateLoading(false);return}
  setGateLoading(true);
  void request<GateVerification>("/workbench/dhf/gates/"+encodeURIComponent(active.submissionId)+"/verification")
   .then(data=>{if(live)setGateResult(data)})
   .catch(err=>{if(live)setGateError(errorCopy(err,"Gate 候选核验记录暂不可用"))})
   .finally(()=>{if(live)setGateLoading(false)});
  return()=>{live=false};
 },[active?.submissionId,active?.reviewKey,refresh]);
 useEffect(()=>{setPassword("");setAcknowledged(false);setSubmitError("");setMessage("");intent.current=null;},[active?.taskId]);
 async function attest(){
  if(!active||active.attestationId||!active.canAttest||!acknowledged||
     serverIntent!==localIntent||!password||busy)return;
  setBusy(true);setSubmitError("");setMessage("");
  try{
   if(!intent.current||intent.current.taskId!==active.taskId||
      intent.current.decisionId!==active.decisionId){
    const data=crypto.getRandomValues(new Uint8Array(16));
    intent.current={taskId:active.taskId,decisionId:active.decisionId,
     key:Array.from(data,value=>value.toString(16).padStart(2,"0")).join("")};
   }
   const output=await request<AttestationOutcome>(
    "/workbench/dhf/tasks/"+encodeURIComponent(active.taskId)+"/attest",{
     method:"POST",body:JSON.stringify({
      decisionId:active.decisionId,password,signIntent:localIntent,
      idempotencyKey:intent.current.key
     })
    });
   if(!output.trialOnly||!output.attestationId)throw new Error("确认记录未写入");
   intent.current=null;
   setRows(prev=>prev.map(item=>item.taskId===active.taskId?
    {...item,attestationId:output.attestationId,contentSha:output.contentSha}:item));
   setMessage("已完成本次密码再认证及签审确认记录。正式阶段 Gate 接受尚未启用。");
   setRefresh(n=>n+1);
  }catch(err){setSubmitError(errorCopy(err,"签审确认失败，请核对本人身份及前序责任"))}
  finally{setPassword("");setBusy(false)}
 }
 return <div className="dhf-pilot-shell">
  <section className="dhf-pilot-list" aria-label="本人签审确认记录">
   <div className="dhf-pilot-toolbar">
    <strong>签审身份确认</strong>
    <RareButton type="button" onClick={()=>setRefresh(n=>n+1)}>刷新</RareButton>
   </div>
   {loading?<div className="dhf-pilot-empty">正在加载本人复核记录…</div>:
    error?<div role="alert" className="dhf-pilot-empty">{error}</div>:
    rows.length===0?<div className="dhf-pilot-empty">暂无需要本人核验的复核决定</div>:
    <div className="dhf-pilot-scroll">{rows.map(item=><button type="button" key={item.taskId}
      className={"dhf-pilot-task"+(active?.taskId===item.taskId?" is-selected":"")}
      aria-pressed={active?.taskId===item.taskId}
      onClick={()=>setSelected(item.taskId)}>
      <span className="dhf-pilot-task-title">{LABELS[item.reviewKey]??item.reviewKey}</span>
      <span className="dhf-pilot-task-meta">{item.stageId} · {item.projectId}</span>
      <span className="dhf-pilot-task-date">{item.attestationId?"已再认证":"尚未进行密码再认证"}</span>
    </button>)}</div>}
  </section>
  <section className="dhf-pilot-detail" aria-label="签审确认详情">
   {active?<div className="dhf-pilot-content">
    <span className="dhf-pilot-overline">{active.stageId} · 冻结提交 {active.submissionId}</span>
    <h2>{LABELS[active.reviewKey]??active.reviewKey}</h2>
    <p>原审核决定：{active.outcome==="recommend_pass"?"建议通过":"建议退回"}</p>
    <p className="dhf-return-reason">{active.reviewComment||"未附加审核意见"}</p>
    <section className="dhf-pilot-evidence" aria-label="签审绑定摘要">
     <h3>签审绑定的不可变对象</h3>
     <div className="dhf-pilot-evidence-item">
      <span>审核决定 {active.decisionId}</span>
      <span>政策模板 SHA-256</span><code>{active.policySha}</code>
      <span>冻结文件证据清单 SHA-256</span><code>{active.manifestSha}</code>
      {active.contentSha?<><span>签审内容摘要</span><code>{active.contentSha}</code></>:null}
     </div>
    </section>
    {active.attestationId?<div className="dhf-pilot-evidence-item">
      <strong>已完成身份再认证记录</strong><code>{active.attestationId}</code>
      <span>这是试点签审确认证据，不是具有独立密码学签名凭证的正式电子签章。</span>
    </div>:<>
     {active.outstandingPrior>0&&!active.canAttest?<p className="dhf-pilot-gate-wait">
      仍有 {active.outstandingPrior} 项前序签审责任未完成；没有经授权的提前介入，不得确认本步骤。
     </p>:null}
     <div className="dhf-pilot-opinion">
      <label htmlFor="dhf-attest-password">再次输入本人登录密码</label>
      <RareInput id="dhf-attest-password" type="password" value={password}
       onChange={e=>setPassword(e.target.value)} autoComplete="off" placeholder="用于本次身份再认证"/>
      <label className="dhf-attest-ack">
       <input type="checkbox" checked={acknowledged} onChange={e=>setAcknowledged(e.target.checked)}/>
       <span>我已复核上述决定及其冻结证据身份，同意建立不可变的本人确认记录。</span>
      </label>
      <RareButton type="button" disabled={busy||!active.canAttest||!password||!acknowledged||serverIntent!==localIntent}
       onClick={()=>void attest()}>{busy?"正在核验…":"验证身份并确认本次签审"}</RareButton>
      {submitError?<p role="alert">{submitError}</p>:null}
      {message?<p role="status">{message}</p>:null}
     </div>
    </>}
    {active.reviewKey==="__gate__"?<section className="dhf-pilot-evidence" aria-label="Gate 候选数字签名核验">
      <h3>Gate 候选与独立验签</h3>
      {gateLoading?<p>正在核对签名与凭证状态…</p>:
       gateError?<p role="alert">{gateError}</p>:
       gateResult?<div className="dhf-pilot-evidence-item">
        <strong>{gateResult.candidateStatus==="trial_candidate"?
          (gateResult.cryptographicValid?"试点候选 · 数字签名验证通过":"试点候选 · 数字签名验证未通过"):
          "尚无数字签名的 Gate 候选"}</strong>
        <span>签署凭证：{credentialLabels[gateResult.credentialStatus]??gateResult.credentialStatus}</span>
        {gateResult.credentialExpiresAt?<span>凭证截止：{new Date(gateResult.credentialExpiresAt).toLocaleString("zh-CN")}</span>:null}
        {gateResult.candidateId?<span>候选记录：{gateResult.candidateId}</span>:null}
        {gateResult.signatureDomain?<span>签名内容标准：{gateResult.signatureDomain.endsWith("V1")?"历史 V1":"凭证绑定 V2"}</span>:null}
        {gateResult.payloadSha?<><span>受控签署摘要</span><code>{gateResult.payloadSha}</code></>:null}
        {gateResult.signatureReason&&gateResult.candidateStatus==="trial_candidate"?
         <span role="alert">核验异常：{gateResult.signatureReason}</span>:null}
        {gateResult.missingPreconditions.length?
         <div><strong>待完成前置条件</strong>
          {gateResult.missingPreconditions.map(reason=><p key={reason}>{gateReasons[reason]??reason}</p>)}
         </div>:null}
        <span>历史签名验证和当前凭证状态分别显示；撤销凭证不会抹除旧签名。这里不是企业正式 Stage Gate 批准。</span>
       </div>:<p>暂无可核验的信息</p>}
    </section>:null}
    {active.reviewKey==="__gate__"&&gateResult?.candidateStatus==="trial_candidate"&&
     gateResult.cryptographicValid?<DHFStageGateIntake submissionId={active.submissionId}/>:null}
    <p className="dhf-pilot-disclaimer">此处的密码再认证仅确认审核身份，不能代替 Ed25519 签名；即使独立验签成功，也不是企业正式 Stage Gate 接受。</p>
   </div>:<div className="dhf-pilot-empty">选择左侧本人审核记录</div>}
  </section>
 </div>
}
