import {useState} from "react";
import {RareButton,RareNotice,RareTextarea} from "../../shared/ui/rare";
import {toast} from "../../shared/ui/feedback";
import {errorCopy} from "../../shared/errors";
import {newIdempotencyKey} from "../../shared/ids";
import {cdwApi,type CDWQMSPendingReview,type CDWQMSAppointmentAlert} from "./api";
import {CDWQMSSpecialAuthorityPanel} from "./CDWQMSSpecialAuthorityPanel";

// Only items already checked against live document-control role and file ACL
// reach this list. Signing still revalidates both at transaction time.
export function CDWQMSReviewInbox({items,alerts,actorId,onVerified,onRead}:{items:CDWQMSPendingReview[];alerts:CDWQMSAppointmentAlert[];actorId:string;onVerified:()=>void;onRead:(id:string)=>void}){
 const [selectedId,setSelectedId]=useState("");
 const [statement,setStatement]=useState("");
 const [revokeReason,setRevokeReason]=useState("");
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
 async function revoke(){
  if(!selected||selected.status!=="verified"||Array.from(revokeReason.trim()).length<16||busy)return;
  setBusy(true);setError("");
  try{
   await toast.track(()=>cdwApi.qmsAppointmentRevoke(selected.id,revokeReason.trim(),newIdempotencyKey()),{
    loading:"正在撤销签批任命…",success:"任命已撤销，并生成受影响人员通知",
    error:e=>errorCopy(e,"撤销任命失败")});
   setRevokeReason("");setSelectedId("");onVerified();
  }catch(e){setError(errorCopy(e,"撤销任命失败"));}
  finally{setBusy(false);}
 }
 return <>
  <section className="cdw-inbox" aria-label="岗位任命待核验列表">
   <header className="cdw-inbox-tools"><div className="cdw-inbox-heading"><strong>任命核验与撤销</strong><span>{items.length}</span></div></header>
   <div className="cdw-inbox-scroll">
    {items.length===0&&<div className="cdw-empty"><strong>暂无可处理任命</strong><p>仅显示您有文控权限、且不是本人或本人提报的任命。</p></div>}
    {items.map(item=><RareButton key={item.id} type="button"
     className={"cdw-task-row"+(selected?.id===item.id?" is-selected":"")}
     onClick={()=>{setSelectedId(item.id);setStatement("");setRevokeReason("");setError("");}}>
     <span className="cdw-task-symbol" aria-hidden="true">↳</span>
     <span className="cdw-task-copy"><strong title={item.fileName}>{item.fileName}</strong>
      <small>{item.nodeKey.replaceAll("_"," ")} · {item.status==="verified"?"已核验，可受控撤销":"待独立核验"}</small></span>
    </RareButton>)}
   </div>
   <footer className="cdw-inbox-footer">受控证据可见、独立角色授权和利益冲突门禁</footer>
  </section>
  <article className="cdw-detail" aria-label="岗位任命核验详情">
   <div className="cdw-detail-inner">
    <CDWQMSSpecialAuthorityPanel actorId={actorId} onChange={onVerified}/>
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
     {selected.status==="pending"?<label>独立核验结论
      <RareTextarea aria-label="独立文控核验结论" value={statement} rows={4} disabled={busy}
       onChange={event=>setStatement(event.target.value)}
       placeholder="记录已核验的任命原件、签字权限、岗位、期限与适用范围（至少 16 字）"/>
     </label>:<>
      <RareNotice tone="warning">此任命已核验。经文控确认撤销后，后续签署立即失效；历史批准保留、相关人员收到独立通知。</RareNotice>
      <label>任命撤销原因与依据
       <RareTextarea aria-label="独立任命撤销依据" value={revokeReason} rows={3} disabled={busy}
        onChange={event=>setRevokeReason(event.target.value)}
        placeholder="记录任命撤销原因、事实和依据，至少 16 字"/>
      </label>
     </>}
     {error&&<RareNotice tone="danger">{error}</RareNotice>}
     {selected.status==="pending"?<RareButton type="button" tone="primary" loading={busy}
      disabled={busy||Array.from(statement.trim()).length<16} onClick={()=>void verify()}>
      确认独立文控核验
     </RareButton>:<RareButton type="button" tone="primary" loading={busy}
      disabled={busy||Array.from(revokeReason.trim()).length<16} onClick={()=>void revoke()}>
      确认撤销此岗位任命
     </RareButton>}
    </>:<RareNotice tone="info">选择一条待核验任命以查看证据信息。</RareNotice>}
   </div>
  </article>
 </>;
}
