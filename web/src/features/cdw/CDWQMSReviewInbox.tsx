import {useState} from "react";
import {RareButton,RareNotice,RareTextarea} from "../../shared/ui/rare";
import {toast} from "../../shared/ui/feedback";
import {errorCopy} from "../../shared/errors";
import {newIdempotencyKey} from "../../shared/ids";
import {cdwApi,type CDWQMSPendingReview,type CDWQMSAppointmentAlert} from "./api";

// Only items already checked against live document-control role and file ACL
// reach this list. Signing still revalidates both at transaction time.
export function CDWQMSReviewInbox({items,alerts,onVerified,onRead}:{items:CDWQMSPendingReview[];alerts:CDWQMSAppointmentAlert[];onVerified:()=>void;onRead:(id:string)=>void}){
 const [selectedId,setSelectedId]=useState("");
 const [statement,setStatement]=useState("");
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const selected=items.find(item=>item.id===selectedId)??items[0];
 async function verify(){
  if(!selected||Array.from(statement.trim()).length<16||busy)return;
  setBusy(true);setError("");
  try{
   await toast.track(()=>cdwApi.qmsAppointmentVerify(selected.id,statement.trim(),newIdempotencyKey()),{
    loading:"正在核对岗位任命…",success:"独立文控核验已记录",
    error:e=>errorCopy(e,"无法核验任命材料")});
   setStatement("");setSelectedId("");onVerified();
  }catch(e){setError(errorCopy(e,"任命核验失败"));}
  finally{setBusy(false);}
 }
 return <>
  <section className="cdw-inbox" aria-label="岗位任命待核验列表">
   <header className="cdw-inbox-tools"><div className="cdw-inbox-heading"><strong>任命待核验</strong><span>{items.length}</span></div></header>
   <div className="cdw-inbox-scroll">
    {items.length===0&&<div className="cdw-empty"><strong>暂无待核验任命</strong><p>这里只显示您有文控权限、且不属于本人或本人提报的任命材料。</p></div>}
    {items.map(item=><RareButton key={item.id} type="button"
     className={"cdw-task-row"+(selected?.id===item.id?" is-selected":"")}
     onClick={()=>{setSelectedId(item.id);setStatement("");setError("");}}>
     <span className="cdw-task-symbol" aria-hidden="true">↳</span>
     <span className="cdw-task-copy"><strong title={item.fileName}>{item.fileName}</strong>
      <small>{item.nodeKey.replaceAll("_"," ")} · 待独立核验</small></span>
    </RareButton>)}
   </div>
   <footer className="cdw-inbox-footer">仅显示文件可见且有对应文控资格的待审核事项</footer>
  </section>
  <article className="cdw-detail" aria-label="岗位任命核验详情">
   <div className="cdw-detail-inner">
    {alerts.some(a=>!a.readAt)&&<section className="cdw-section">
     <div className="cdw-section-head"><h3>任命撤销通知</h3></div>
     {alerts.filter(a=>!a.readAt).map(a=><div className="cdw-review-digest" key={a.id}>
      <p className="cdw-section-note">受控签批岗位 {a.nodeKey.replaceAll("_"," ")} 的任命已撤销，原授权不可再用于签署。</p>
      <RareButton type="button" tone="neutral" onClick={()=>onRead(a.id)}>已知悉此通知</RareButton>
     </div>)}
    </section>}
    {selected?<>
     <div className="cdw-detail-header"><div><small>QMS 任命证据核验</small><h2>{selected.fileName}</h2></div></div>
     <div className="cdw-review-digest">
      <small>任命岗位：{selected.nodeKey.replaceAll("_"," ")}</small>
      <p className="cdw-section-note">{selected.reason}</p>
      <small>截止日期：{selected.expiresAt.slice(0,10)}</small>
     </div>
     <div className="cdw-review-digest">
      <small>任命凭据文件：{selected.evidenceFileName}</small>
      <p className="cdw-section-note">核定的发行版本：<code>{selected.evidenceReleaseId}</code></p>
      <a className="cdw-text-link" href={cdwApi.qmsAppointmentEvidenceUrl(selected.id)}>
       下载精确受控发行版本 DOCX ↗
      </a>
     </div>
     <RareNotice tone="info">此下载由服务器核验发行版本与 SHA-256，不读取“最新文件”。请核对原始任命签字、岗位和期限；本人或提报人不可自审。</RareNotice>
     <label>独立核验结论
      <RareTextarea aria-label="独立文控核验结论" value={statement} rows={4} disabled={busy}
       onChange={event=>setStatement(event.target.value)}
       placeholder="记录已核验的任命原件、签字权限、岗位、期限与适用范围（至少 16 字）"/>
     </label>
     {error&&<RareNotice tone="danger">{error}</RareNotice>}
     <RareButton type="button" tone="primary" loading={busy}
      disabled={busy||Array.from(statement.trim()).length<16} onClick={()=>void verify()}>
      确认独立文控核验
     </RareButton>
    </>:<RareNotice tone="info">选择一条待核验任命以查看证据信息。</RareNotice>}
   </div>
  </article>
 </>;
}
