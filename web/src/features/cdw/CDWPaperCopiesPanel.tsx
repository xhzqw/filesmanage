import {useEffect,useRef,useState} from "react";
import {RareBadge,RareButton,RareNotice,RareSelect,RareTextarea} from "../../shared/ui/rare";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {ApiError} from "../../shared/http";
import {toast} from "../../shared/ui/feedback";
import {errorCopy} from "../../shared/errors";
import {newIdempotencyKey} from "../../shared/ids";
import {cdwApi,type CDWPaperCopy,type CDWPaperLedger} from "./api";

type Kind="collected"|"lost"|"destroyed";
const copyStatus=(s:string)=>s==="issued"?"待回收":s==="collected"?"已回收":s==="destroyed"?"已销毁":s==="lost"?"遗失":"已豁免";
export function CDWPaperCopiesPanel({targetId,editable,onChanged}:{targetId:string;editable:boolean;onChanged:()=>void}){
 const [ledger,setLedger]=useState<CDWPaperLedger|null>(null);
 const [busy,setBusy]=useState(false);
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState("");
 const [refresh,setRefresh]=useState(0);
 const [numbers,setNumbers]=useState("");
 const [selected,setSelected]=useState("");
 const [kind,setKind]=useState<Kind>("collected");
 const [reason,setReason]=useState("");
 const key=useRef("");
 useEffect(()=>{
  let alive=true;setLoading(true);setError("");setLedger(null);
  cdwApi.paperLedger(targetId).then(data=>{if(alive)setLedger(data)})
   .catch(e=>{if(alive)setError(errorCopy(e,"读取纸质副本台账失败"))})
   .finally(()=>{if(alive)setLoading(false)});
  return()=>{alive=false};
 },[targetId,refresh]);
 const copyNumbers=numbers.split(/\r?\n/).map(v=>v.trim()).filter(Boolean);
 const validNumbers=Boolean(ledger&&copyNumbers.length===ledger.paperQuantity&&
  new Set(copyNumbers).size===copyNumbers.length&&copyNumbers.every(v=>/^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/.test(v)));
 const selectedCopy=ledger?.copies.find(c=>c.id===selected);
 async function issue(){
  if(!ledger||ledger.lotId||!editable||!validNumbers||busy)return;
  if(!key.current)key.current=newIdempotencyKey();
  setBusy(true);
  try{
   await toast.track(()=>cdwApi.paperIssue(targetId,ledger.targetRevision,copyNumbers,key.current),{
    loading:"正在校验冻结纸质数量并逐份登记…",success:"纸质副本编号已登记，等待逐份回收",
    error:e=>errorCopy(e,"登记纸质副本失败")
   });
   key.current="";setNumbers("");setRefresh(n=>n+1);onChanged();
  }catch(e){if(!(e instanceof ApiError&&e.httpStatus===0))key.current="";}
  finally{setBusy(false);}
 }
 async function record(copy:CDWPaperCopy){
  if(!editable||busy||reason.trim().length<12)return;
  if(!key.current)key.current=newIdempotencyKey();
  setBusy(true);
  try{
   await toast.track(()=>cdwApi.paperEvent(copy.id,copy.revision,kind,reason.trim(),key.current),{
    loading:"正在写入该份纸质副本的不可变处理凭证…",
    success:"该份纸质副本的处理凭证已保存",
    error:e=>errorCopy(e,"记录纸质回收或异常失败")
   });
   key.current="";setSelected("");setReason("");setRefresh(n=>n+1);onChanged();
  }catch(e){if(!(e instanceof ApiError&&e.httpStatus===0))key.current="";}
  finally{setBusy(false);}
 }
 return <section className="cdw-section">
  <div className="cdw-section-head"><h3>纸质受控副本逐份台账</h3>
   <RareButton type="button" tone="ghost" disabled={loading||busy} onClick={()=>setRefresh(v=>v+1)}>刷新</RareButton>
  </div>
  {loading&&<BrandLoadingLabel showContext>读取冻结发放记录和逐份回收状态</BrandLoadingLabel>}
  {error&&<RareNotice tone="danger">{error}</RareNotice>}
  {ledger&&<div className="cdw-form">
   <div className="cdw-detail-facts">
    <div><span>批准纸质份数</span><strong>{ledger.paperQuantity}</strong></div>
    <div><span>实际登记</span><strong>{ledger.issued}</strong></div>
    <div><span>未回收（含遗失）</span><strong>{ledger.outstanding}</strong></div>
    <div><span>已回收/已销毁</span><strong>{ledger.collected+ledger.destroyed}</strong></div>
    <div><span>遗失</span><strong>{ledger.lost}</strong></div>
   </div>
   {!ledger.lotId&&editable&&<div className="cdw-review-form">
    <RareNotice tone="info">部门签收后才能登记纸质副本。每行一个唯一编号，数量必须与已批准发行范围完全一致；冻结后不可改号、删份。</RareNotice>
    <label>纸质副本编号（每行一份，共 {ledger.paperQuantity} 份）
     <RareTextarea rows={Math.min(6,Math.max(3,ledger.paperQuantity))} value={numbers} maxLength={6500}
      placeholder="例如 DOC-A0-001" disabled={busy}
      onChange={e=>{setNumbers(e.target.value);key.current="";}}/>
    </label>
    <div className="cdw-review-actions"><RareButton type="button" tone="primary" loading={busy}
     disabled={!validNumbers||busy} onClick={()=>void issue()}>冻结并登记全部纸质副本</RareButton></div>
   </div>}
   {ledger.lotId&&<div className="cdw-ledger-scroll" role="region" aria-label="纸质副本逐份回收台账">
    <table className="cdw-ledger-table"><thead><tr><th>副本编号</th><th>当前状态</th><th>负责人</th><th>最后操作说明</th><th>处理</th></tr></thead>
     <tbody>{ledger.copies.map(c=><tr key={c.id}>
      <td><strong>{c.copyNo}</strong></td>
      <td><RareBadge tone={c.state==="issued"?"warning":c.state==="lost"?"danger":"neutral"}>{copyStatus(c.state)}</RareBadge></td>
      <td>{c.holderId}</td><td>{c.lastReason??"—"}</td>
      <td>{editable&&(c.state==="issued"||c.state==="collected")?
       <RareButton type="button" tone="neutral" disabled={busy} onClick={()=>{setSelected(c.id);setKind(c.state==="collected"?"destroyed":"collected");setReason("");key.current="";}}>登记处理</RareButton>:"—"}</td>
     </tr>)}</tbody>
    </table>
   </div>}
   {selectedCopy&&<div className="cdw-review-form">
    <strong>副本 {selectedCopy.copyNo} · {copyStatus(selectedCopy.state)}</strong>
    <RareSelect aria-label="纸质副本处理类型" value={kind} disabled={busy} onChange={e=>{setKind(e.target.value as Kind);key.current="";}}>
     {selectedCopy.state==="issued"&&<><option value="collected">实物已回收</option><option value="lost">报告实物遗失</option></>}
     {selectedCopy.state==="collected"&&<option value="destroyed">已按规定销毁</option>}
    </RareSelect>
    <label>处理证据说明（不少于 12 字）
     <RareTextarea value={reason} rows={3} maxLength={2000} disabled={busy}
      onChange={e=>{setReason(e.target.value);key.current="";}}
      placeholder="记载实际接收人、物理交接、时间与凭证位置"/>
    </label>
    <div className="cdw-review-actions">
     <RareButton type="button" tone="primary" disabled={busy||reason.trim().length<12}
      loading={busy} onClick={()=>void record(selectedCopy)}>保存逐份处理凭证</RareButton>
     <RareButton type="button" tone="ghost" disabled={busy} onClick={()=>setSelected("")}>取消</RareButton>
    </div>
   </div>}
   <p className="cdw-section-note">纸质回收率与电子阅读率独立计算。遗失不等于已回收，已回收后的销毁单独留痕。</p>
  </div>}
 </section>;
}
