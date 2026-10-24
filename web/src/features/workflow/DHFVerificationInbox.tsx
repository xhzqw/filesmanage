import {useEffect,useRef,useState} from "react";
import {request} from "../../shared/http";
import {RareButton,RareInput,RareTextarea} from "../../shared/ui/rare";
import {errorCopy} from "../../shared/errors";
import "./dhfPilotInbox.css";

type VerificationCase={
 caseId:string;returnDecisionId:string;projectId:string;stageId:string;
 originalSubmissionId:string;revisedSubmissionId:string;
 originalManifestSha:string;revisedManifestSha:string;
 returnReason:string;resolutionPlan:string;newAttemptState:string;
 readyToVerify:boolean;verificationId?:string;
};
type VerificationResponse={items:VerificationCase[];trialOnly:boolean;verificationIntent:string};
type Verified={verificationId:string;revisedSubmissionId:string;trialOnly:boolean};
const intentText="I personally verified the corrected DHF submission against my original return";

export function DHFVerificationInbox(){
 const[items,setItems]=useState<VerificationCase[]>([]);
 const[selected,setSelected]=useState<string|null>(null);
 const[loading,setLoading]=useState(true);
 const[error,setError]=useState("");
 const[refresh,setRefresh]=useState(0);
 const[serverIntent,setServerIntent]=useState("");
 const[comment,setComment]=useState("");
 const[password,setPassword]=useState("");
 const[checked,setChecked]=useState(false);
 const[busy,setBusy]=useState(false);
 const[notice,setNotice]=useState("");
 const[submitError,setSubmitError]=useState("");
 const pending=useRef<{caseId:string;comment:string;key:string}|null>(null);
 useEffect(()=>{
  let active=true;setLoading(true);setError("");
  void request<VerificationResponse>("/workbench/dhf/verifications")
   .then(result=>{if(active){setItems(result.items??[]);setServerIntent(result.verificationIntent??"");}})
   .catch(err=>{if(active)setError(errorCopy(err,"整改复验事项加载失败"));})
   .finally(()=>{if(active)setLoading(false)});
  return()=>{active=false};
 },[refresh]);
 const current=items.find(item=>item.caseId===selected)??items[0];
 useEffect(()=>{
  setComment("");setPassword("");setChecked(false);setNotice("");
  setSubmitError("");pending.current=null;
 },[current?.caseId]);
 async function verify(){
  if(!current||current.verificationId||!current.readyToVerify||busy||
   serverIntent!==intentText||!checked||comment.trim().length<10||!password)return;
  setBusy(true);setNotice("");setSubmitError("");
  try{
   const description=comment.trim();
   if(!pending.current||pending.current.caseId!==current.caseId||
       pending.current.comment!==description){
    const random=crypto.getRandomValues(new Uint8Array(16));
    pending.current={caseId:current.caseId,comment:description,
      key:Array.from(random,n=>n.toString(16).padStart(2,"0")).join("")};
   }
   const result=await request<Verified>(
    "/workbench/dhf/remediations/"+encodeURIComponent(current.caseId)+"/verify",{
    method:"POST",body:JSON.stringify({comment:description,password,
      verificationIntent:intentText,idempotencyKey:pending.current.key})
   });
   if(!result.trialOnly||!result.verificationId)throw new Error("整改复验结果尚未得到确认");
   setItems(before=>before.map(item=>item.caseId===current.caseId?
    {...item,verificationId:result.verificationId}:item));
   pending.current=null;
   setNotice("整改复验记录已写入；阶段最终批准仍需独立受控流程。");
  }catch(err){setSubmitError(errorCopy(err,"整改复验未完成，请检查签审责任与身份权限"))}
  finally{setPassword("");setBusy(false)}
 }
 return <div className="dhf-pilot-shell">
  <section className="dhf-pilot-list" aria-label="本人整改复验">
   <div className="dhf-pilot-toolbar">
    <strong>整改复验</strong>
    <RareButton type="button" onClick={()=>setRefresh(n=>n+1)}>刷新</RareButton>
   </div>
   {loading?<div className="dhf-pilot-empty">正在加载需本人复验的整改…</div>:
    error?<div role="alert" className="dhf-pilot-empty">{error}</div>:
    items.length===0?<div className="dhf-pilot-empty">当前没有分配给你的整改复验事项</div>:
    <div className="dhf-pilot-scroll">{items.map(item=><button type="button"
      className={"dhf-pilot-task"+(current?.caseId===item.caseId?" is-selected":"")}
      key={item.caseId} aria-pressed={current?.caseId===item.caseId}
      onClick={()=>setSelected(item.caseId)}>
      <span className="dhf-pilot-task-title">{item.stageId} · 原退回整改</span>
      <span className="dhf-pilot-task-meta">{item.projectId}</span>
      <span className="dhf-pilot-task-date">{item.verificationId?"已完成复验":
        item.readyToVerify?"待本人复验":"等待修订及签审责任完成"}</span>
    </button>)}</div>}
  </section>
  <section className="dhf-pilot-detail" aria-label="整改复验内容">
   {current?<div className="dhf-pilot-content">
    <span className="dhf-pilot-overline">{current.stageId} · 原提交 {current.originalSubmissionId}</span>
    <h2>独立整改复验</h2>
    <p>原退回意见</p><p className="dhf-return-reason">{current.returnReason}</p>
    <section className="dhf-pilot-evidence" aria-label="整改证据来源">
      <h3>整改计划与证据身份</h3>
      <p>{current.resolutionPlan}</p>
      <div className="dhf-pilot-evidence-item">
       <span>原始冻结证据 SHA-256</span><code>{current.originalManifestSha}</code>
       <span>整改后证据 SHA-256</span><code>{current.revisedManifestSha}</code>
       <span>新提交 {current.revisedSubmissionId||"尚未提交"}</span>
      </div>
    </section>
    {current.verificationId?<div className="dhf-pilot-evidence-item">
      <strong>已完成不可变整改复验记录</strong><code>{current.verificationId}</code>
      <span>这不是最终阶段 Gate 批准，也不会自动发行文件。</span>
    </div>:<>
      {!current.readyToVerify?<p className="dhf-pilot-gate-wait">
       尚不能复验。请先完成整改提交，并由修订批次所有审核责任人分别核验身份并确认通过。
      </p>:null}
      <div className="dhf-pilot-opinion">
       <label htmlFor="dhf-verification-comment">本人复验依据</label>
       <RareTextarea id="dhf-verification-comment" value={comment} rows={4}
        onChange={e=>setComment(e.target.value)}
        placeholder="说明如何对照原退回问题复验整改证据及结论"/>
       <label htmlFor="dhf-verification-password">再次验证本人登录密码</label>
       <RareInput id="dhf-verification-password" type="password" autoComplete="off"
        value={password} onChange={e=>setPassword(e.target.value)} placeholder="仅用于本次身份核验"/>
       <label className="dhf-attest-ack">
        <input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)}/>
        <span>我已检查原退回意见和新冻结提交的证据，并愿意对本次复验结论负责。</span>
       </label>
       <RareButton type="button" disabled={busy||!current.readyToVerify||
         !checked||comment.trim().length<10||!password||serverIntent!==intentText}
         onClick={()=>void verify()}>{busy?"正在核验…":"确认整改复验"}</RareButton>
       {submitError?<p role="alert">{submitError}</p>:null}
       {notice?<p role="status">{notice}</p>:null}
      </div>
    </>}
    <p className="dhf-pilot-disclaimer">整改复验是独立的系统审计事实；正式电子签名及阶段最终批准仍须通过经授权的发布门禁。</p>
   </div>:<div className="dhf-pilot-empty">选择需要本人复验的整改事项</div>}
  </section>
 </div>
}
