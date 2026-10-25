import {useEffect,useRef,useState} from "react";
import {request} from "../../shared/http";
import {errorCopy} from "../../shared/errors";
import {RareButton,RareInput,RareTextarea} from "../../shared/ui/rare";
import "./dhfPilotInbox.css";

type Opinion={id:string;reviewId:string;reviewerId:string;opinion:string;
 reason:string;sourceGraphSha:string;trialOnly:boolean;formalAccepted:boolean};
type RecordItem={reviewId:string;submissionId:string;projectId:string;stageId:string;
 gateSignerId:string;candidateId:string;candidatePayloadSha:string;projectGraphSha:string;
 opinion?:Opinion;trialOnly:boolean;formalAccepted:boolean};
type Page={items:RecordItem[];trialOnly:boolean;formalAccepted:boolean};
type Outcome={opinionId:string;reviewId:string;state:string;replayed:boolean;trialOnly:boolean;formalAccepted:boolean};
const freshKey=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),v=>v.toString(16).padStart(2,"0")).join("");
const names:Record<string,string>={recommend_return:"建议退回",recommend_reject:"建议拒绝"};

/** No approved/conditional button can appear in the engineering pilot UI. */
export function DHFGateDecisionReviewInbox(){
 const [page,setPage]=useState<Page|null>(null);
 const [loading,setLoading]=useState(true);
 const [refresh,setRefresh]=useState(0);
 const [selected,setSelected]=useState<string|null>(null);
 const [choice,setChoice]=useState<"recommend_return"|"recommend_reject">("recommend_return");
 const [reason,setReason]=useState("");
 const [password,setPassword]=useState("");
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [message,setMessage]=useState("");
 const pending=useRef<{body:string;key:string}|null>(null);
 useEffect(()=>{
  let alive=true;setLoading(true);setError("");
  void request<Page>("/workbench/dhf/gate-decision-reviews")
   .then(data=>{if(alive)setPage(data)})
   .catch(err=>{if(alive)setError(errorCopy(err,"独立 Gate 复核授权读取失败"))})
   .finally(()=>{if(alive)setLoading(false)});
  return()=>{alive=false};
 },[refresh]);
 const items=page?.items??[];
 const current=items.find(x=>x.reviewId===selected)??items[0];
 function select(id:string){setSelected(id);setPassword("");setReason("");setMessage("");setError("");pending.current=null}
 async function recommend(){
  if(!current||current.opinion||busy||reason.trim().length<10||!password)return;
  const body=JSON.stringify({opinion:choice,reason:reason.trim()});
  if(!pending.current||pending.current.body!==current.reviewId+":"+body)
   pending.current={body:current.reviewId+":"+body,key:freshKey()};
  setBusy(true);setError("");setMessage("");
  try{
   const result=await request<Outcome>(
    "/workbench/dhf/gate-decision-reviews/"+encodeURIComponent(current.reviewId)+"/recommendation",
    {method:"POST",body:JSON.stringify({...JSON.parse(body) as Record<string,unknown>,
     password,idempotencyKey:pending.current.key})});
   if(!result.opinionId||!result.trialOnly||result.formalAccepted||result.state!=="recommendation_only")
    throw Error("独立复核响应不满足试点意见合同");
   pending.current=null;
   setMessage(result.replayed?"已核对原始复核意见":"复核意见已不可变登记；尚非正式企业 Gate 决策");
   setRefresh(x=>x+1);setPassword("");setReason("");
  }catch(err){setError(errorCopy(err,"独立 Gate 复核意见未能受控登记"))}
  finally{setBusy(false);setPassword("")}
 }
 return <div className="dhf-pilot-shell">
  <section className="dhf-pilot-list" aria-label="独立 Gate 复核清单">
   <div className="dhf-pilot-toolbar"><strong>独立 Gate 决策复核 · 试点</strong>
    <RareButton type="button" onClick={()=>setRefresh(n=>n+1)}>刷新</RareButton></div>
   {loading?<div className="dhf-pilot-empty">正在核验独立复核授权及有效期…</div>:
    items.length===0?<div className="dhf-pilot-empty">
     无符合独立授权的 Gate 复核记录。管理员身份不会自动产生 Gate 决策权限。</div>:
    <div className="dhf-pilot-scroll">{items.map(item=><button type="button"
      className={"dhf-pilot-task"+(current?.reviewId===item.reviewId?" is-selected":"")}
      aria-pressed={current?.reviewId===item.reviewId} key={item.reviewId}
      onClick={()=>select(item.reviewId)}>
      <strong className="dhf-pilot-task-title">{item.stageId} · {item.projectId}</strong>
      <span className="dhf-pilot-task-meta">{item.opinion?names[item.opinion.opinion]:"待独立复核"} · {item.reviewId}</span>
      <span className="dhf-pilot-task-date">原 Gate 签署人：{item.gateSignerId}</span>
     </button>)}</div>}
  </section>
  <section className="dhf-pilot-detail" aria-label="独立 Gate 复核意见">
   {current?<div className="dhf-pilot-content">
    <span className="dhf-pilot-overline">DHF / Stage Gate · 独立复核 · 非正式决策</span>
    <h2>{current.stageId} 受控验收意见</h2>
    <dl>
     <div><dt>审查申请</dt><dd>{current.reviewId}</dd></div>
     <div><dt>原提交</dt><dd>{current.submissionId}</dd></div>
     <div><dt>Gate 签署人</dt><dd>{current.gateSignerId}</dd></div>
     <div><dt>受控候选</dt><dd>{current.candidateId}</dd></div>
     <div><dt>冻结项目依赖图 SHA-256</dt><dd>{current.projectGraphSha}</dd></div>
    </dl>
    {current.opinion?<div className="dhf-pilot-evidence">
     <h3>{names[current.opinion.opinion]??current.opinion.opinion}</h3>
     <p className="dhf-return-reason">{current.opinion.reason}</p>
     <p>仅为不可变复核意见。原阶段未批准、未退回执行、未发起受控文件发行。</p>
    </div>:<div className="dhf-pilot-opinion">
     <p>必须具备独立批准、限定项目与阶段、未过期的试点复核授权。只能建议退回或拒绝，正式通过及条件放行保持禁用。</p>
     <label>复核意见
      <select value={choice} onChange={e=>{setChoice(e.target.value as typeof choice);pending.current=null}}>
       <option value="recommend_return">建议退回整改</option>
       <option value="recommend_reject">建议拒绝</option>
      </select>
     </label>
     <label>逐项说明理由
      <RareTextarea rows={4} value={reason} onChange={e=>{setReason(e.target.value);pending.current=null}}/>
     </label>
     <label>当前账号密码再认证
      <RareInput type="password" autoComplete="off" value={password} onChange={e=>setPassword(e.target.value)}/>
     </label>
     <div className="dhf-pilot-actions"><RareButton type="button"
      disabled={busy||reason.trim().length<10||!password}
      onClick={()=>void recommend()}>{busy?"正在登记…":"登记试点复核意见"}</RareButton></div>
    </div>}
    {message?<p role="status" className="dhf-pilot-feedback">{message}</p>:null}
    {error?<p role="alert" className="dhf-pilot-opinion-error">{error}</p>:null}
    <p className="dhf-pilot-disclaimer">任何复核意见都不修改原始 DHF 阶段状态。实际整改继续使用原有“退回—整改—再次签审—原审查人复验”责任链。</p>
   </div>:<div className="dhf-pilot-empty">没有可查看的独立 Gate 复核记录。</div>}
  </section>
 </div>;
}
