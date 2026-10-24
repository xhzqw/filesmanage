import {useEffect,useRef,useState} from "react";
import {request} from "../../shared/http";
import {RareButton,RareInput} from "../../shared/ui/rare";
import {errorCopy} from "../../shared/errors";
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
type AttestationOutcome={attestationId:string;taskId:string;contentSha:string;trialOnly:boolean;replayed:boolean};
const LABELS:Record<string,string>={
 "__gate__":"阶段总复核","G5-SW":"软件专业复核","G5-MF":"制造专业复核",
};
const localIntent="I confirm this DHF review opinion and its fixed evidence identity";

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
    <p className="dhf-pilot-disclaimer">此处仅形成经当前账号密码再认证的受控确认凭证。正式电子签名策略、身份签署凭证、整改复验关闭及 Stage Gate 接受仍未开放。</p>
   </div>:<div className="dhf-pilot-empty">选择左侧本人审核记录</div>}
  </section>
 </div>
}
