import {useEffect,useRef,useState} from "react";
import {RareBadge,RareButton,RareNotice,RareTextarea,RareSelect} from "../../shared/ui/rare";
import {toast} from "../../shared/ui/feedback";
import {errorCopy} from "../../shared/errors";
import {ApiError} from "../../shared/http";
import {newIdempotencyKey} from "../../shared/ids";
import {cdwApi,type CDWReviewGate,type CDWOverrideGrant} from "./api";

export function CDWReviewPanel({gate,onDecided}:{gate:CDWReviewGate;onDecided:()=>void}){
 const [mode,setMode]=useState<"accept"|"return"|null>(null);
 const [reason,setReason]=useState("");
 const [busy,setBusy]=useState(false);
 const [grants,setGrants]=useState<CDWOverrideGrant[]>([]);
 const [candidates,setCandidates]=useState<Array<{id:string;displayName:string}>>([]);
 const [grantMode,setGrantMode]=useState(false);
 const [grantee,setGrantee]=useState("");
 const [grantReason,setGrantReason]=useState("");
 const [grantBusy,setGrantBusy]=useState(false);
 const grantKey=useRef("");
 const revokeKey=useRef("");
 const [grantError,setGrantError]=useState("");
 useEffect(()=>{
  if(gate.reviewMode!=="direct"||!gate.substitutable)return;
  let live=true;
  Promise.all([cdwApi.reviewCandidates(gate.gateId),cdwApi.reviewGrants(gate.gateId)])
   .then(([people,existing])=>{if(live){setCandidates(people.items);setGrants(existing.items);}})
   .catch(error=>{if(live)setGrantError(errorCopy(error,"无法读取越级授权信息"));});
  return()=>{live=false};
 },[gate.gateId,gate.reviewMode,gate.substitutable]);
 async function grant(){
  if(grantBusy||!grantee||!grantReason.trim())return;
  setGrantBusy(true);
  if(!grantKey.current)grantKey.current=newIdempotencyKey();
  try{
   const result=await toast.track(()=>cdwApi.reviewGrant(gate.gateId,gate.revision,grantee,grantReason.trim(),grantKey.current),{
    loading:"正在签发节点授权…",success:"授权已签发；中间责任继续保留",error:e=>errorCopy(e,"无法签发授权")
   });
   setGrants(list=>[result,...list]);setGrantReason("");setGrantee("");setGrantMode(false);grantKey.current="";
  }catch(error){if(!(error instanceof ApiError&&error.httpStatus===0))grantKey.current="";}
  finally{setGrantBusy(false);}
 }
 async function revoke(grantId:string){
  if(grantBusy)return;
  setGrantBusy(true);
  if(!revokeKey.current)revokeKey.current=newIdempotencyKey();
  try{
   const result=await toast.track(()=>cdwApi.reviewRevoke(gate.gateId,grantId,revokeKey.current),{
    loading:"正在撤销节点授权…",success:"授权已撤销",error:e=>errorCopy(e,"授权撤销失败")
   });
   setGrants(list=>list.map(gr=>gr.grantId===result.grantId?result:gr));revokeKey.current="";
  }catch(error){if(!(error instanceof ApiError&&error.httpStatus===0))revokeKey.current="";}
  finally{setGrantBusy(false);}
 }
 const keyRef=useRef("");
 const operationRef=useRef("");
 const contentURL="/api/workbench/review-gates/"+encodeURIComponent(gate.gateId)+"/content";
 async function submit(){
  if(!mode||busy)return;
  if(mode==="return"&&!reason.trim()){toast.warning("退回必须填写明确的修订要求");return;}
  if(reason.length>3000){toast.warning("审核说明最多 3000 字");return;}
  setBusy(true);
  const op=[gate.gateId,gate.revision,mode,reason.trim(),gate.overrideGrantId??""].join("|");
  if(operationRef.current!==op){operationRef.current=op;keyRef.current=newIdempotencyKey();}
  try{
   await toast.track(()=>cdwApi.reviewDecide(gate.gateId,gate.revision,mode,reason.trim(),keyRef.current,gate.overrideGrantId),{
    loading:mode==="accept"?"正在提交验收结论…":"正在下达退回意见…",
    success:mode==="accept"?"交付验收已通过，未触发正式文件批准":"已退回原执行人，上一轮交付保持只读",
    error:error=>errorCopy(error,"验收决定提交失败"),
   });
   keyRef.current="";operationRef.current="";onDecided();
  }catch(error){
   if(!(error instanceof ApiError&&error.httpStatus===0)){
    keyRef.current="";operationRef.current="";
   }
  }finally{setBusy(false);}
 }
 return <div className="cdw-detail-inner cdw-review-pane" key={gate.gateId}>
  <div className="cdw-detail-header">
   <div><small>{gate.reviewMode==="delegated"?"授权越级代验收":"直属上级验收"} · 第 {gate.round} 轮</small><h2>{gate.taskTitle}</h2></div>
   <RareBadge tone="warning">{gate.reviewMode==="delegated"?"授权代验收":"待我验收"}</RareBadge>
  </div>
  <div className="cdw-detail-facts">
   <div><span>审核身份</span><strong>{gate.reviewMode==="delegated"?"代原审核人执行":"直属审核人"}</strong></div>
   <div><span>审核轮次</span><strong>第 {gate.round} 轮</strong></div>
   <div><span>冻结状态</span><strong>交付内容不可变</strong></div>
  </div>
  <section className="cdw-section">
   <div className="cdw-section-head"><h3>本轮冻结交付稿</h3>
    <a className="cdw-text-link" href={contentURL} download="CDW-delivery.docx">下载冻结稿 ↗</a>
   </div>
   <div className="cdw-review-digest"><small>内容 SHA-256</small><code title={gate.sha256}>{gate.sha256}</code></div>
  </section>
  {gate.reviewMode==="direct"&&gate.substitutable&&<section className="cdw-section">
   <div className="cdw-section-head"><h3>授权上级代验收</h3>
    <RareButton type="button" tone="ghost" disabled={grantBusy} onClick={()=>setGrantMode(v=>!v)}>{grantMode?"收起":"签发授权"}</RareButton>
   </div>
   {grantError&&<RareNotice tone="warning">{grantError}</RareNotice>}
   {grants.filter(gr=>!gr.revoked).map(gr=><div key={gr.grantId} className="cdw-branch-row">
    <span className="cdw-branch-text"><strong>{candidates.find(person=>person.id===gr.actorId)?.displayName??gr.actorId}</strong>
     <small>截至 {new Date(gr.expiresAt).toLocaleString("zh-CN")}</small></span>
    <RareButton type="button" tone="ghost" disabled={grantBusy} onClick={()=>void revoke(gr.grantId)}>撤销</RareButton>
   </div>)}
   {grantMode&&<div className="cdw-review-form">
    <label>允许代验收的上级负责人
     <RareSelect aria-label="越级受权人" value={grantee} onChange={e=>{setGrantee(e.target.value);grantKey.current="";}}>
      <option value="">选择任务链上级</option>
      {candidates.map(person=><option key={person.id} value={person.id}>{person.displayName}</option>)}
     </RareSelect>
    </label>
    <label>授权原因（必填）
     <RareTextarea value={grantReason} maxLength={1000} rows={3}
      onChange={e=>{setGrantReason(e.target.value);grantKey.current="";}} placeholder="说明本轮为何需要越级审核"/>
    </label>
    <RareButton type="button" tone="primary" loading={grantBusy}
     disabled={grantBusy||!grantee||!grantReason.trim()} onClick={()=>void grant()}>确认授权</RareButton>
   </div>}
  </section>}
  <section className="cdw-section">
   <h3>验收决定</h3>
   <div className="cdw-review-actions">
    <RareButton type="button" tone={mode==="accept"?"primary":"neutral"}
     disabled={busy} onClick={()=>{setMode("accept");setReason("");}}>验收通过</RareButton>
    <RareButton type="button" tone={mode==="return"?"primary":"neutral"}
     disabled={busy} onClick={()=>setMode("return")}>退回修订</RareButton>
   </div>
   {mode&&<div className="cdw-review-form">
    <label>{mode==="return"?"退回原因与修改要求（必填）":"验收说明（可选）"}
     <RareTextarea value={reason} onChange={event=>setReason(event.target.value)}
      rows={4} maxLength={3000} placeholder={mode==="return"?"请指出问题、需要修改的内容及验收标准":"补充本轮验收说明"}/>
    </label>
    <div className="cdw-review-actions">
     <RareButton type="button" tone="primary" disabled={busy||(mode==="return"&&!reason.trim())}
      loading={busy} onClick={()=>void submit()}>{mode==="accept"?"确认验收通过":"确认退回"}</RareButton>
     <RareButton type="button" tone="ghost" disabled={busy} onClick={()=>setMode(null)}>取消</RareButton>
    </div>
   </div>}
  </section>
 </div>;
}
