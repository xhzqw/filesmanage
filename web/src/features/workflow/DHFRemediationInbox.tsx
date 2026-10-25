import {useEffect,useMemo,useRef,useState} from "react";
import {request} from "../../shared/http";
import {RareButton,RareTextarea} from "../../shared/ui/rare";
import {fileApi} from "../documents/api";
import {errorCopy} from "../../shared/errors";
import "./dhfPilotInbox.css";

type Req={id:string;applicability:string;file_id?:string;version_seq?:number;sha256?:string};
type ReturnItem={
 decisionId:string;reviewKey:string;projectId:string;stageId:string;
 originalSubmissionId:string;originalManifest:{requirements:Req[]};
 returnReason:string;decidedAt:string;caseId?:string;newAttemptId?:string;
 newAttemptState?:string;verificationId?:string;canPrepare:boolean;
};
type Latest={seq:number;sha:string;name:string};

export function DHFRemediationInbox(){
 const[items,setItems]=useState<ReturnItem[]>([]);
 const[fetchError,setFetchError]=useState("");
 const[loading,setLoading]=useState(true);
 const[refresh,setRefresh]=useState(0);
 const[selected,setSelected]=useState<string|null>(null);
 const[latest,setLatest]=useState<Record<string,Latest>>({});
 const[chosen,setChosen]=useState<Record<string,boolean>>({});
 const[plan,setPlan]=useState("");
 const[busy,setBusy]=useState(false);
 const[error,setError]=useState("");
 const[notice,setNotice]=useState("");
 const pendingIntent=useRef<{decisionId:string;payload:string;key:string}|null>(null);
 useEffect(()=>{
  let live=true;setLoading(true);setFetchError("");
  void request<{items:ReturnItem[]}>("/workbench/dhf/returns")
   .then(v=>{if(live)setItems(v.items??[]);})
   .catch(err=>{if(live)setFetchError(errorCopy(err,"我的研发整改事项加载失败"));})
   .finally(()=>{if(live)setLoading(false)});
  return()=>{live=false};
 },[refresh]);
 const active=items.find(x=>x.decisionId===selected)??items[0];
 useEffect(()=>{
  let live=true;
  setLatest({});setChosen({});setPlan("");setError("");setNotice("");
  if(!active)return;
  const fileIds=[...new Set((active.originalManifest?.requirements??[]).map(x=>x.file_id).filter((x):x is string=>Boolean(x)))];
  void Promise.all(fileIds.map(async fileId=>{
   try{
    const meta=await fileApi.meta(fileId);
    const newest=[...meta.versions].sort((a,b)=>b.versionSeq-a.versionSeq)[0];
    if(newest&&newest.versionSeq>0)return [fileId,{seq:newest.versionSeq,sha:newest.sha256,name:meta.file.name}] as const;
   }catch{/* Original file access may have been revoked; no selection offered. */}
   return null;
  })).then(result=>{
   if(!live)return;
   setLatest(Object.fromEntries(result.filter((x):x is readonly [string,Latest]=>x!==null)));
  });
  return()=>{live=false};
 },[active?.decisionId]);
 const original=active?.originalManifest?.requirements??[];
 const revised=useMemo(()=>original.map(item=>{
  const choice=item.file_id&&chosen[item.id]?latest[item.file_id]:null;
  return choice&&choice.seq>(item.version_seq??0)?
   {...item,version_seq:choice.seq,sha256:choice.sha}:item;
 }),[original,chosen,latest]);
 const changed=original.some((item,i)=>revised[i]?.version_seq!==item.version_seq||
  revised[i]?.sha256!==item.sha256);
 async function openRemediation(){
  if(!active||active.caseId||!active.canPrepare||!changed||plan.trim().length<10||busy)return;
  setBusy(true);setError("");setNotice("");
  try{
   const payload=JSON.stringify({manifest:{requirements:revised},resolutionPlan:plan.trim()});
   if(!pendingIntent.current||pendingIntent.current.decisionId!==active.decisionId||
      pendingIntent.current.payload!==payload){
    const raw=crypto.getRandomValues(new Uint8Array(16));
    pendingIntent.current={decisionId:active.decisionId,payload,
     key:Array.from(raw,v=>v.toString(16).padStart(2,"0")).join("")};
   }
   const result=await request<{caseId:string;newAttemptId:string;trialOnly:boolean}>(
    "/workbench/dhf/returns/"+encodeURIComponent(active.decisionId)+"/remediation",
    {method:"POST",body:JSON.stringify({...JSON.parse(payload),idempotencyKey:pendingIntent.current.key})});
   if(!result.trialOnly||!result.newAttemptId)throw new Error("整改批次确认失败");
   pendingIntent.current=null;
   setNotice("新整改批次已建立，正式阶段复验仍需按受控流程提交。");
   setItems(old=>old.map(item=>item.originalSubmissionId===active.originalSubmissionId?
    {...item,caseId:result.caseId,newAttemptId:result.newAttemptId,newAttemptState:"preparing"}:item));
  }catch(e){setError(errorCopy(e,"整改立案失败，请检查受控文件版本与项目权限"))}
  finally{setBusy(false)}
 }
 return <div className="dhf-pilot-shell">
  <section className="dhf-pilot-list" aria-label="我的研发整改">
   <div className="dhf-pilot-toolbar">
    <strong>我的研发整改</strong>
    <RareButton type="button" onClick={()=>setRefresh(n=>n+1)}>刷新</RareButton>
   </div>
   {loading?<div className="dhf-pilot-empty">正在加载退回意见…</div>:
    fetchError?<div className="dhf-pilot-empty" role="alert">{fetchError}</div>:
    items.length===0?<div className="dhf-pilot-empty">目前没有退回给我的研发提交</div>:
    <div className="dhf-pilot-scroll">{items.map(item=><RareButton type="button"
      key={item.decisionId} className={"dhf-pilot-task"+(active?.decisionId===item.decisionId?" is-selected":"")}
      aria-pressed={active?.decisionId===item.decisionId} onClick={()=>setSelected(item.decisionId)}>
      <span className="dhf-pilot-task-title">{item.stageId} · {item.reviewKey==="__gate__"?"阶段复核退回":item.reviewKey+" 专业退回"}</span>
      <span className="dhf-pilot-task-meta">{item.projectId} · {item.verificationId?"整改已复验":item.caseId?"已关联整改批次":"待整改"}</span>
      <span className="dhf-pilot-task-date">{new Date(item.decidedAt).toLocaleString("zh-CN")}</span>
    </RareButton>)}</div>}
  </section>
  <section className="dhf-pilot-detail" aria-label="退回原因与整改证据">
   {active?<div className="dhf-pilot-content">
    <span className="dhf-pilot-overline">{active.stageId} / 原始提交 {active.originalSubmissionId}</span>
    <h2>整改与重新提交</h2>
    <p className="dhf-return-reason">{active.returnReason}</p>
    {active.caseId?<div className="dhf-pilot-evidence-item">
     <strong>{active.verificationId?"已完成整改复验":"已创建独立整改批次"}</strong>
     <span>整改记录 {active.caseId}</span>
     <span>新尝试 {active.newAttemptId} · {active.newAttemptState==="submitted"?"已重新提交":"准备中"}</span>
     <span>{active.verificationId?"原退回审核人已确认复验；正式阶段批准仍未自动生效。":"旧提交和退回意见完整保留；建立批次并不等于阶段验收完成。"}</span>
    </div>:<>
     <section className="dhf-pilot-evidence" aria-label="选择受控整改证据版本">
      <h3>选择整改证据版本</h3>
      <p>先在文档管理中完成修订，再在这里明确选择该文件的新版本；不自动替换原证据。</p>
      <div className="dhf-pilot-evidence-list">{original.map(item=>{
       const newer=item.file_id?latest[item.file_id]:null;
       const available=Boolean(newer&&newer.seq>(item.version_seq??0));
       return <div className="dhf-pilot-evidence-item" key={item.id}>
        <strong>{newer?.name??item.file_id??item.id}</strong>
        <span>要求 {item.id} · 原冻结 v{item.version_seq??"—"}</span>
        <span>{available?"可选择受控新版本 v"+newer!.seq:"尚无可使用的新文件版本，或当前无权查看"}</span>
        {available?<RareButton type="button" aria-pressed={Boolean(chosen[item.id])}
          onClick={()=>setChosen(v=>({...v,[item.id]:!v[item.id]}))}>
          {chosen[item.id]?"已选择 v"+newer!.seq+" · 撤销":"使用受控 v"+newer!.seq}
        </RareButton>:null}
       </div>;
      })}</div>
     </section>
     <div className="dhf-pilot-opinion">
      <label htmlFor="dhf-remediation-plan">整改计划与修订说明</label>
      <RareTextarea id="dhf-remediation-plan" value={plan} onChange={e=>setPlan(e.target.value)}
       placeholder="说明退回问题、实际修改的受控文件版本，以及拟进行的复验" rows={4}/>
      <RareButton type="button" className="primary" disabled={busy||!active.canPrepare||!changed||plan.trim().length<10}
       onClick={()=>void openRemediation()}>{busy?"正在创建…":"建立整改批次"}</RareButton>
      {error?<p role="alert">{error}</p>:null}
      {notice?<p role="status">{notice}</p>:null}
      {!active.canPrepare?<p>当前没有此项目的整改准备权限，请联系项目责任人。</p>:null}
     </div>
    </>}
    <p className="dhf-pilot-disclaimer">整改仅创建新的证据准备批次；逐级签署、正式复验和阶段批准仍须由受控工作流执行。</p>
   </div>:<div className="dhf-pilot-empty">选择一条退回意见查看整改依据</div>}
  </section>
 </div>
}
