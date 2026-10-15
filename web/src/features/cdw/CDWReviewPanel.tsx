import {useRef,useState} from "react";
import {RareBadge,RareButton,RareNotice,RareTextarea} from "../../shared/ui/rare";
import {toast} from "../../shared/ui/feedback";
import {errorCopy} from "../../shared/errors";
import {ApiError} from "../../shared/http";
import {newIdempotencyKey} from "../../shared/ids";
import {cdwApi,type CDWReviewGate} from "./api";

export function CDWReviewPanel({gate,onDecided}:{gate:CDWReviewGate;onDecided:()=>void}){
 const [mode,setMode]=useState<"accept"|"return"|null>(null);
 const [reason,setReason]=useState("");
 const [busy,setBusy]=useState(false);
 const keyRef=useRef("");
 const operationRef=useRef("");
 const contentURL="/api/workbench/review-gates/"+encodeURIComponent(gate.gateId)+"/content";
 async function submit(){
  if(!mode||busy)return;
  if(mode==="return"&&!reason.trim()){toast.warning("退回必须填写明确的修订要求");return;}
  if(reason.length>3000){toast.warning("审核说明最多 3000 字");return;}
  setBusy(true);
  const op=[gate.gateId,gate.revision,mode,reason.trim()].join("|");
  if(operationRef.current!==op){operationRef.current=op;keyRef.current=newIdempotencyKey();}
  try{
   await toast.track(()=>cdwApi.reviewDecide(gate.gateId,gate.revision,mode,reason.trim(),keyRef.current),{
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
   <div><small>直属上级验收 · 第 {gate.round} 轮</small><h2>{gate.taskTitle}</h2></div>
   <RareBadge tone="warning">待我验收</RareBadge>
  </div>
  <div className="cdw-detail-facts">
   <div><span>交付来源</span><strong>直接下级</strong></div>
   <div><span>审核轮次</span><strong>第 {gate.round} 轮</strong></div>
   <div><span>冻结状态</span><strong>交付内容不可变</strong></div>
  </div>
  <section className="cdw-section">
   <div className="cdw-section-head"><h3>本轮冻结交付稿</h3>
    <a className="cdw-text-link" href={contentURL} download="CDW-delivery.docx">下载冻结稿 ↗</a>
   </div>
   <p className="cdw-section-note">请审阅这份已冻结的修订稿，不要仅凭原文件预览进行验收。验收结论仅作用于此交付及其 SHA。</p>
   <div className="cdw-review-digest"><small>内容 SHA-256</small><code title={gate.sha256}>{gate.sha256}</code></div>
  </section>
  <section className="cdw-section">
   <h3>验收决定</h3>
   <p className="cdw-section-note">通过表示认可当前任务交付，不等于正式文件批准或受控发行。退回会保留原稿和审核痕迹，执行人从冻结稿继续修订并重新提交。</p>
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
    <RareNotice tone={mode==="return"?"warning":"info"}>{mode==="return"?"退回不删除原交付和中间管理责任。":"该操作不能替代独立的正式受控文件审批。"}</RareNotice>
    <div className="cdw-review-actions">
     <RareButton type="button" tone="primary" disabled={busy||(mode==="return"&&!reason.trim())}
      loading={busy} onClick={()=>void submit()}>{mode==="accept"?"确认验收通过":"确认退回"}</RareButton>
     <RareButton type="button" tone="ghost" disabled={busy} onClick={()=>setMode(null)}>取消</RareButton>
    </div>
   </div>}
  </section>
 </div>;
}
