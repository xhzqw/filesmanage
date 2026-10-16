import {useRef,useState} from "react";
import {RareBadge,RareButton,RareNotice,RareTextarea} from "../../shared/ui/rare";
import {toast} from "../../shared/ui/feedback";
import {errorCopy} from "../../shared/errors";
import {newIdempotencyKey} from "../../shared/ids";
import {ApiError} from "../../shared/http";
import {cdwApi,type CDWReadingAssignment} from "./api";

export function CDWReadingPanel({assignment,onConfirmed}:{
 assignment:CDWReadingAssignment;onConfirmed:()=>void;
}){
 const [statement,setStatement]=useState("");
 const [busy,setBusy]=useState(false);
 const key=useRef("");
 async function confirm(){
  if(assignment.state==="confirmed"||statement.trim().length<12||busy)return;
  if(!key.current)key.current=newIdempotencyKey();
  setBusy(true);
  try{
   await toast.track(()=>cdwApi.readingConfirm(assignment.id,statement.trim(),key.current),{
    loading:"核验指定阅读人并保存不可变阅读凭证…",
    success:"本人的受控文件阅读确认已完成",
    error:e=>errorCopy(e,"阅读确认失败")
   });
   key.current="";setStatement("");onConfirmed();
  }catch(e){if(!(e instanceof ApiError&&e.httpStatus===0))key.current="";}
  finally{setBusy(false);}
 }
 return <div className="cdw-detail-inner">
  <div className="cdw-detail-header"><div>
   <small>G9 · 指定人员独立阅读确认</small><h2>{assignment.fileName}</h2>
  </div><RareBadge tone={assignment.state==="confirmed"?"success":"warning"}>
   {assignment.state==="confirmed"?"本人已确认":"待我阅读"}
  </RareBadge></div>
  <div className="cdw-detail-facts">
   <div><span>正式发行版次</span><strong>{assignment.revisionLabel}</strong></div>
   <div><span>确认状态</span><strong>{assignment.state==="confirmed"?"已确认":"待本人确认"}</strong></div>
  </div>
  <section className="cdw-section">
   <div className="cdw-section-head"><h3>核对精确受控发行稿</h3>
    <a className="cdw-text-link" href={"/api/workbench/reading-assignments/"+encodeURIComponent(assignment.id)+"/content"}
     download="CDW-controlled-distribution.docx">获取本次发行 DOCX ↗</a>
   </div>
   <p className="cdw-section-note">先完整下载并打开受控文件，再签署阅读声明。服务器必须记录完整文件传送成功，未下载或传送中断均不能确认；下载记录不代表已经阅读。</p>
   <div className="cdw-review-digest"><small>精确文件 SHA-256</small><code>{assignment.artifactSha256}</code></div>
  </section>
  {(assignment.state==="assigned"||assignment.state==="opened")&&<section className="cdw-section">
   <RareNotice tone="info">阅读确认是本人对具体受控版本的独立声明，不等于部门签收、生效或培训合格。</RareNotice>
   <div className="cdw-review-form">
    <label>本人阅读声明（至少 12 字）
     <RareTextarea value={statement} rows={4} maxLength={2000}
      placeholder="说明已阅读本次发行版次，并确认知悉文件内容"
      onChange={e=>{setStatement(e.target.value);key.current="";}}/>
    </label>
    <div className="cdw-review-actions">
     <RareButton type="button" tone="primary" disabled={busy||statement.trim().length<12}
      loading={busy} onClick={()=>void confirm()}>本人签署阅读确认</RareButton>
    </div>
   </div>
  </section>}
  {assignment.state==="confirmed"&&<RareNotice tone="success">
   本人已完成阅读确认，数据库留存不可变确认事件；这并不代表培训完成。
  </RareNotice>}
 </div>;
}
