import {useCallback,useEffect,useState} from "react";
import {RareButton,RareInput,RareSelect,RareTextarea,RareNotice} from "../../shared/ui/rare";
import {toast} from "../../shared/ui/feedback";
import {errorCopy} from "../../shared/errors";
import {newIdempotencyKey} from "../../shared/ids";
import type {User} from "../../entities/user/model";
import {cdwApi,type CDWQMSAppointment,type CDWEffectiveSearchHit} from "./api";

type Position={value:string;label:string};

// Document evidence and independent verification live in the existing CDW
// workbench, never in a separate un-audited authorization dialog.
export function CDWQMSAppointmentEvidence({fileId,policyReleaseId,users,positions}:{
 fileId:string;policyReleaseId:string;users:User[];positions:Position[];
}){
 const [items,setItems]=useState<CDWQMSAppointment[]>([]);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [person,setPerson]=useState("");
 const [position,setPosition]=useState("management_representative");
 const [search,setSearch]=useState("");
 const [results,setResults]=useState<CDWEffectiveSearchHit[]>([]);
 const [evidence,setEvidence]=useState("");
 const [until,setUntil]=useState("");
 const [reason,setReason]=useState("");
 const [statement,setStatement]=useState("");
 const [revokeTarget,setRevokeTarget]=useState("");
 const [revokeReason,setRevokeReason]=useState("");
 const refresh=useCallback(async()=>{
  const data=await cdwApi.qmsAppointments(fileId);
  setItems(data.items.filter(item=>item.policyReleaseId===policyReleaseId));
 },[fileId,policyReleaseId]);
 useEffect(()=>{
  let active=true;
  setItems([]);setEvidence("");setResults([]);setError("");setStatement("");
  cdwApi.qmsAppointments(fileId).then(page=>{
   if(active)setItems(page.items.filter(item=>item.policyReleaseId===policyReleaseId));
  }).catch(e=>{if(active)setError(errorCopy(e,"无法载入岗位任命记录"));});
  return()=>{active=false};
 },[fileId,policyReleaseId]);
 async function findEvidence(){
  if(!search.trim())return;
  setBusy(true);
  try{
   const data=await cdwApi.controlEffectiveSearch(search.trim(),"",30);
   setResults(data.items);setEvidence("");
  }catch(e){setError(errorCopy(e,"任命依据检索失败"));}
  finally{setBusy(false);}
 }
 async function propose(){
  if(!person||!evidence||!until||Array.from(reason.trim()).length<16)return;
  const date=new Date(until+"T23:59:59");
  if(!Number.isFinite(date.getTime())||date.getTime()<=Date.now())return;
  setBusy(true);
  try{
   await toast.track(()=>cdwApi.qmsAppointmentPropose({
    fileId,userId:person,nodeKey:position,policyReleaseId,evidenceReleaseId:evidence,
    expiresAt:date.toISOString(),reason:reason.trim()},newIdempotencyKey()),{
    loading:"正在登记待核验任命…",success:"任命材料已登记，须独立文控核验",
    error:e=>errorCopy(e,"登记任命材料失败")});
   setReason("");await refresh();
  }catch(e){setError(errorCopy(e,"登记任命材料失败"));}
  finally{setBusy(false);}
 }
 async function verify(id:string){
  if(Array.from(statement.trim()).length<16)return;
  setBusy(true);
  try{
   await toast.track(()=>cdwApi.qmsAppointmentVerify(id,statement.trim(),newIdempotencyKey()),{
    loading:"正在核对任命依据…",success:"任命证据已核验，适用岗位仍以正式文件为准",
    error:e=>errorCopy(e,"任命核验失败")});
   setStatement("");await refresh();
  }catch(e){setError(errorCopy(e,"任命核验失败"));}
  finally{setBusy(false);}
 }
 async function revoke(id:string){
  if(Array.from(revokeReason.trim()).length<16||busy)return;
  setBusy(true);
  try{
   await toast.track(()=>cdwApi.qmsAppointmentRevoke(id,revokeReason.trim(),newIdempotencyKey()),{
    loading:"正在撤销岗位任命…",success:"任命已撤销，后续 QMS 签批即刻失效",
    error:e=>errorCopy(e,"任命撤销失败")});
   setRevokeTarget("");setRevokeReason("");await refresh();
  }catch(e){setError(errorCopy(e,"任命撤销失败"));}
  finally{setBusy(false);}
 }
 return <section className="cdw-section">
  <div className="cdw-section-head"><h3>签批岗位任命核验</h3></div>
  <p className="cdw-section-note">技术授权不等于岗位任命。任命证据必须来自当前有效的受控发行文件，且由非提报人、非被任命人的有权文控人员独立复核。</p>
  {error&&<RareNotice tone="danger">{error}</RareNotice>}
  <div className="cdw-form">
   <label>被任命人
    <RareSelect aria-label="被任命人" value={person} disabled={busy} onChange={e=>setPerson(e.target.value)}>
     <option value="">选择人员</option>
     {users.map(u=><option key={u.id} value={u.id}>{u.displayName}</option>)}
    </RareSelect>
   </label>
   <label>被授予的岗位
    <RareSelect aria-label="任命岗位" value={position} disabled={busy} onChange={e=>setPosition(e.target.value)}>
     {positions.map(p=><option key={p.value} value={p.value}>{p.label}</option>)}
    </RareSelect>
   </label>
   <label>任命证据受控文件搜索
    <RareInput type="search" aria-label="任命证据搜索" value={search} disabled={busy}
     placeholder="检索任命书或正式授权矩阵" onChange={e=>{setSearch(e.target.value);setEvidence("");setResults([]);}}/>
   </label>
   <RareButton type="button" disabled={busy||!search.trim()} onClick={()=>void findEvidence()}>查找任命证据</RareButton>
   {results.length>0&&<label>选取受控任命凭据
    <RareSelect aria-label="任命证据发行版本" value={evidence} disabled={busy} onChange={e=>setEvidence(e.target.value)}>
     <option value="">选择当前有效的任命文件</option>
     {results.map(item=><option key={item.releaseId} value={item.releaseId}>{item.fileName}</option>)}
    </RareSelect>
   </label>}
   <label>任命有效截止日
    <RareInput type="date" aria-label="任命有效截止日" value={until} disabled={busy} onChange={e=>setUntil(e.target.value)}/>
   </label>
   <label>任命范围及材料说明
    <RareTextarea rows={2} aria-label="任命材料说明" value={reason} disabled={busy}
     onChange={e=>setReason(e.target.value)} placeholder="明确任命文件条款、适用范围及岗位（至少 16 字）"/>
   </label>
  </div>
  <RareButton type="button" loading={busy}
   disabled={busy||!person||!evidence||!until||Array.from(reason.trim()).length<16}
   onClick={()=>void propose()}>登记待复核任命</RareButton>
  <div className="cdw-section-head"><h3>任命记录与独立核验</h3></div>
  {items.length===0&&<p className="cdw-section-note">暂无任命证据；当前质量体系正式签批权限不可启用。</p>}
  {items.map(item=><div key={item.id} className="cdw-review-digest">
   <small>{users.find(u=>u.id===item.userId)?.displayName||"人员"} · {positions.find(p=>p.value===item.nodeKey)?.label||item.nodeKey} · {item.status==="verified"?"已核验":item.status==="pending"?"待独立核验":"已撤销"} · 截止 {item.expiresAt.slice(0,10)}</small>
   <p className="cdw-section-note">{item.reason}</p>
   {item.status==="pending"&&<>
    <label>独立核验结论
     <RareTextarea aria-label="独立任命核验结论" rows={2} value={statement} disabled={busy}
      onChange={e=>setStatement(e.target.value)} placeholder="核对签批资格、任命条款、有效期、适用项目和原件证据（至少 16 字）"/>
    </label>
    <RareButton type="button" disabled={busy||Array.from(statement.trim()).length<16}
     onClick={()=>void verify(item.id)}>由有权文控人员核验此任命</RareButton>
   </>}
   {item.status==="verified"&&<>
    <RareButton type="button" disabled={busy} tone="neutral"
     onClick={()=>{setRevokeTarget(v=>v===item.id?"":item.id);setRevokeReason("");}}>
     {revokeTarget===item.id?"取消撤销操作":"撤销任命资格"}
    </RareButton>
    {revokeTarget===item.id&&<>
     <RareNotice tone="warning">撤销立即阻断该岗位后续正式签批，向相关人员生成持久通知；历史签署记录不会删除。</RareNotice>
     <label>撤销事实与依据
      <RareTextarea aria-label="岗位任命撤销依据" rows={2} value={revokeReason} disabled={busy}
       onChange={e=>setRevokeReason(e.target.value)} placeholder="说明撤销依据、起效条件及影响范围（至少 16 字）"/>
     </label>
     <RareButton type="button" disabled={busy||Array.from(revokeReason.trim()).length<16}
      onClick={()=>void revoke(item.id)}>确认撤销岗位任命</RareButton>
    </>}
   </>}
  </div>)}
 </section>;
}
