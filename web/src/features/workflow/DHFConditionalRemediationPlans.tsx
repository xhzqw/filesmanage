import {useEffect,useRef,useState} from "react";
import {request} from "../../shared/http";
import {errorCopy} from "../../shared/errors";
import {RareButton,RareInput,RareTextarea} from "../../shared/ui/rare";
import "./dhfPilotInbox.css";

type Owner={id:string;displayName:string};
type Option={projectId:string;stageId:string;templateId:string;dependencyId:string;
 predecessorStage:string;guardedAction:"prepare"|"submit";
 eligibleRequirements:string[];eligibleOwners:Owner[]};
type Obligation={requirementId:string;ownerId:string;correctiveAction:string;dueAt:string};
type Proposal={id:string;projectId:string;stageId:string;dependencyId:string;
 predecessorStage:string;guardedAction:string;proposedBy:string;graphSha:string;
 obligations:Obligation[];reason:string;expiresAt:string;status:string;
 withdrawalReason?:string;trialOnly:boolean;formalAccepted:boolean};
type Catalog={options:Option[];plans:Proposal[];trialOnly:boolean;formalAccepted:boolean};
type Result={id:string;status:string;replayed:boolean;trialOnly:boolean;formalAccepted:boolean};
const makeKey=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),
 n=>n.toString(16).padStart(2,"0")).join("");
const statusLabels:Record<string,string>={
 awaiting_enterprise_authority:"待企业独立授权（无权限）",
 withdrawn:"已撤回（无权限）",expired:"已到期（无权限）"};

/** Proposal authoring only. Not even a preparation/submit bypass is exposed. */
export function DHFConditionalRemediationPlans(){
 const [catalog,setCatalog]=useState<Catalog|null>(null);
 const [loadError,setLoadError]=useState("");
 const [loading,setLoading]=useState(true);
 const [refresh,setRefresh]=useState(0);
 const [selected,setSelected]=useState("");
 const [reviewId,setReviewId]=useState("");
 const [obligations,setObligations]=useState<Obligation[]>([]);
 const [reason,setReason]=useState("");
 const [expiry,setExpiry]=useState("");
 const [password,setPassword]=useState("");
 const [withdrawReason,setWithdrawReason]=useState("");
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [message,setMessage]=useState("");
 const pending=useRef<{body:string;key:string}|null>(null);
 useEffect(()=>{
  let live=true;setLoading(true);setLoadError("");
  void request<Catalog>("/workbench/dhf/conditional-plans")
   .then(data=>{if(live)setCatalog(data)})
   .catch(err=>{if(live)setLoadError(errorCopy(err,"条件整改预案读取失败"))})
   .finally(()=>{if(live)setLoading(false)});
  return()=>{live=false};
 },[refresh]);
 const options=catalog?.options??[];
 const plans=catalog?.plans??[];
 const activeOption=options.find(x=>x.projectId+":"+x.stageId+":"+x.dependencyId===selected);
 const activePlan=plans.find(x=>x.id===reviewId);
 function resetEdits(){setPassword("");setError("");setMessage("");pending.current=null}
 function chooseOption(option:Option){
  setReviewId("");
  setSelected(option.projectId+":"+option.stageId+":"+option.dependencyId);
  setObligations(option.eligibleRequirements.slice(0,1).map(requirementId=>({
   requirementId,ownerId:option.eligibleOwners[0]?.id??"",
   correctiveAction:"",dueAt:""})));
  setReason("");setExpiry("");resetEdits();
 }
 function choosePlan(id:string){setReviewId(id);setSelected("");setWithdrawReason("");resetEdits()}
 function updateObligation(index:number,patch:Partial<Obligation>){
  setObligations(xs=>xs.map((x,i)=>i===index?{...x,...patch}:x));
  pending.current=null;
 }
 async function submit(){
  if(!activeOption||!reason||!expiry||!password||!obligations.length||busy)return;
  const body=JSON.stringify({projectId:activeOption.projectId,stageId:activeOption.stageId,
   dependencyId:activeOption.dependencyId,reason:reason.trim(),
   expiresAt:new Date(expiry).toISOString(),
   obligations:obligations.map(x=>({...x,correctiveAction:x.correctiveAction.trim(),
    dueAt:new Date(x.dueAt).toISOString()}))});
  if(!pending.current||pending.current.body!==body)pending.current={body,key:makeKey()};
  setBusy(true);setMessage("");setError("");
  try{
   const result=await request<Result>("/workbench/dhf/conditional-plans",
    {method:"POST",body:JSON.stringify({...JSON.parse(body) as Record<string,unknown>,
     password,idempotencyKey:pending.current.key})});
   if(!result.id||!result.trialOnly||result.formalAccepted||
    result.status!=="awaiting_enterprise_authority")
    throw Error("整改预案响应违反未授权控制合同");
   pending.current=null;setMessage("不可变整改预案已登记，尚未产生阶段或操作授权。");
   setRefresh(n=>n+1);setReviewId(result.id);setPassword("");
  }catch(err){setError(errorCopy(err,"整改预案未能登记"))}
  finally{setBusy(false);setPassword("")}
 }
 async function withdraw(){
  if(!activePlan||activePlan.status==="withdrawn"||!password||withdrawReason.trim().length<10||busy)return;
  setBusy(true);setError("");setMessage("");
  try{
   const result=await request<Result>("/workbench/dhf/conditional-plans/"+encodeURIComponent(activePlan.id)+"/withdraw",
    {method:"POST",body:JSON.stringify({reason:withdrawReason.trim(),password})});
   if(!result.trialOnly||result.formalAccepted||result.status!=="withdrawn")
    throw Error("撤回操作未形成可靠记录");
   setMessage("预案已撤回并永久保留审计，不产生任何放行权限。");
   setPassword("");setRefresh(n=>n+1);
  }catch(err){setError(errorCopy(err,"整改预案撤回失败"))}
  finally{setBusy(false)}
 }
 return <div className="dhf-pilot-shell">
  <section className="dhf-pilot-list" aria-label="条件整改预案项目与历史">
   <div className="dhf-pilot-toolbar"><strong>条件整改预案 · 试点</strong>
    <RareButton type="button" onClick={()=>setRefresh(n=>n+1)}>刷新</RareButton></div>
   {loading?<div className="dhf-pilot-empty">正在核验项目模板和人员权限…</div>:
    loadError?<p role="alert" className="dhf-pilot-empty">{loadError}</p>:
    <div className="dhf-pilot-scroll">
     <span className="dhf-pilot-overline">可申请的已发布模板直接依赖</span>
     {options.map(option=><button type="button" key={option.projectId+":"+option.stageId+":"+option.dependencyId}
      className={"dhf-pilot-task"+(activeOption===option?" is-selected":"")}
      onClick={()=>chooseOption(option)}>
      <strong className="dhf-pilot-task-title">{option.projectId} · {option.stageId}</strong>
      <span className="dhf-pilot-task-meta">{option.predecessorStage} → {option.stageId} · {option.guardedAction} · {option.dependencyId}</span>
     </button>)}
     <span className="dhf-pilot-overline">我的不可变预案</span>
     {plans.map(plan=><button type="button" key={plan.id}
      className={"dhf-pilot-task"+(activePlan?.id===plan.id?" is-selected":"")}
      onClick={()=>choosePlan(plan.id)}>
      <strong className="dhf-pilot-task-title">{plan.stageId} · {plan.projectId}</strong>
      <span className="dhf-pilot-task-meta">{statusLabels[plan.status]??plan.status}</span>
      <span className="dhf-pilot-task-date">{plan.id}</span>
     </button>)}
     {!options.length&&!plans.length?<div className="dhf-pilot-empty">
      没有符合条件的已发布模板依赖或本人预案。普通项目角色不等于企业放行授权。</div>:null}
    </div>}
  </section>
  <section className="dhf-pilot-detail" aria-label="条件整改预案内容">
   <div className="dhf-pilot-content">
    <span className="dhf-pilot-overline">DHF / 项目直接依赖 · 企业正式授权未开放</span>
    <h2>{activePlan?"不可变整改预案":activeOption?"建立逐项整改预案":"选择左侧模板依赖"}</h2>
    {activePlan?<>
     <dl>
      <div><dt>状态</dt><dd>{statusLabels[activePlan.status]??activePlan.status}</dd></div>
      <div><dt>直接目标</dt><dd>{activePlan.predecessorStage} → {activePlan.stageId} · {activePlan.guardedAction}</dd></div>
      <div><dt>提案截止</dt><dd>{new Date(activePlan.expiresAt).toLocaleString("zh-CN")}</dd></div>
      <div><dt>全项目图 SHA</dt><dd>{activePlan.graphSha}</dd></div>
     </dl>
     <p className="dhf-return-reason">{activePlan.reason}</p>
     {activePlan.obligations.map(item=><div className="dhf-pilot-evidence-item" key={item.requirementId}>
      <strong>{item.requirementId} · 责任人 {item.ownerId}</strong>
      <span>整改截止：{new Date(item.dueAt).toLocaleString("zh-CN")}</span>
      <p>{item.correctiveAction}</p>
     </div>)}
     {activePlan.status!=="withdrawn"?<div className="dhf-pilot-opinion">
      <label>撤回原因（不可变）<RareTextarea rows={2} value={withdrawReason}
       onChange={e=>setWithdrawReason(e.target.value)}/></label>
      <label>当前账号密码确认<RareInput type="password" autoComplete="off"
       value={password} onChange={e=>setPassword(e.target.value)}/></label>
      <RareButton type="button" disabled={busy||withdrawReason.trim().length<10||!password}
       onClick={()=>void withdraw()}>{busy?"处理中…":"撤回预案"}</RareButton>
     </div>:<p>已撤回，保留原始整改内容和审计信息。</p>}
    </>:activeOption?<div className="dhf-pilot-opinion">
     <p>仅限 {activeOption.predecessorStage} → {activeOption.stageId} 的直接依赖，
      拟申请动作 {activeOption.guardedAction}。填写预案不会授予任何动作权限。</p>
     <label>计划整体截止（最长 30 天）<RareInput type="datetime-local" value={expiry}
      onChange={e=>{setExpiry(e.target.value);pending.current=null}}/></label>
     <label>申请依据与总体整改目标<RareTextarea rows={3} value={reason}
      onChange={e=>{setReason(e.target.value);pending.current=null}}/></label>
     {obligations.map((item,i)=><div className="dhf-pilot-evidence-item" key={item.requirementId}>
      <strong>{item.requirementId} · 非关键且被模板明确允许</strong>
      <label>责任人<select value={item.ownerId}
       onChange={e=>updateObligation(i,{ownerId:e.target.value})}>
       {activeOption.eligibleOwners.map(owner=><option key={owner.id} value={owner.id}>
        {owner.displayName} · {owner.id}</option>)}
      </select></label>
      <label>本项整改截止<RareInput type="datetime-local" value={item.dueAt}
       onChange={e=>updateObligation(i,{dueAt:e.target.value})}/></label>
      <label>本项整改任务与拟提交证据<RareTextarea rows={2} value={item.correctiveAction}
       onChange={e=>updateObligation(i,{correctiveAction:e.target.value})}/></label>
      {obligations.length>1?<RareButton type="button" onClick={()=>{
       setObligations(xs=>xs.filter((_,j)=>i!==j));pending.current=null;
      }}>移除本项</RareButton>:null}
     </div>)}
     {activeOption.eligibleRequirements.filter(id=>!obligations.some(x=>x.requirementId===id)).map(id=>
      <RareButton key={id} type="button" onClick={()=>{
       setObligations(xs=>[...xs,{requirementId:id,
        ownerId:activeOption.eligibleOwners[0]?.id??"",correctiveAction:"",dueAt:""}]);
       pending.current=null;
      }}>添加整改要求：{id}</RareButton>)}
     <label>当前账号密码再认证<RareInput type="password" autoComplete="off"
      value={password} onChange={e=>setPassword(e.target.value)}/></label>
     <RareButton type="button" disabled={busy||!password||!reason.trim()||!expiry||
      obligations.some(x=>!x.ownerId||!x.dueAt||x.correctiveAction.trim().length<10)}
      onClick={()=>void submit()}>{busy?"正在核对与登记…":"登记不可变整改预案"}</RareButton>
    </div>:<p>先选择左侧已发布模板中的直接依赖，或查看历史预案。</p>}
    {message?<p role="status" className="dhf-pilot-feedback">{message}</p>:null}
    {error?<p role="alert" className="dhf-pilot-opinion-error">{error}</p>:null}
    <p className="dhf-pilot-disclaimer">整改预案不是正式批准。逾期自动视为过期；
     撤回和历史记录不可抹除；不允许跨阶段或传递性豁免，也不会触发 CDW 文件发行。</p>
   </div>
  </section>
 </div>;
}
