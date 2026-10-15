import {useEffect,useMemo,useState} from "react";
import {RareBadge,RareButton,RareInput,RareNotice,RareSelect} from "../../shared/ui/rare";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {errorCopy} from "../../shared/errors";
import {cdwApi,type CDWDistributionLedger,type CDWDistributionLedgerRow} from "./api";

type Sort="department"|"signed"|"reading";
function readingLabel(row:CDWDistributionLedgerRow){
 if(row.readingStatus==="unassigned")return "待建阅读名册";
 if(row.readingStatus==="confirmed")return "阅读已完成";
 return row.readingStatus==="partial"?"部分已读":"待阅读确认";
}
export function CDWDistributionLedgerPanel({planId}:{planId:string}){
 const [ledger,setLedger]=useState<CDWDistributionLedger|null>(null);
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState("");
 const [reload,setReload]=useState(0);
 const [query,setQuery]=useState("");
 const [sort,setSort]=useState<Sort>("department");
 const [onlyPending,setOnlyPending]=useState(false);
 useEffect(()=>{
  let live=true;
  setLoading(true);setError("");
  cdwApi.distributionLedger(planId).then(data=>{if(live)setLedger(data)})
   .catch(e=>{if(live)setError(errorCopy(e,"读取受控发行签收台账失败"))})
   .finally(()=>{if(live)setLoading(false)});
  return()=>{live=false};
 },[planId,reload]);
 const rows=useMemo(()=>{
  const q=query.toLocaleLowerCase().trim();
  return (ledger?.rows??[]).filter(row=>
   (!onlyPending||(row.receiptStatus!=="received"||row.readingStatus!=="confirmed"))
   &&(!q||[row.departmentName,row.receiverName,row.actualSignerName??"",
    row.exceptionReason??""].some(v=>v.toLocaleLowerCase().includes(q))))
   .sort((a,b)=>{
    if(sort==="signed")return (b.signedAt??"").localeCompare(a.signedAt??"");
    if(sort==="reading")return (a.readingConfirmed/Math.max(a.readingAssigned,1))-
     (b.readingConfirmed/Math.max(b.readingAssigned,1));
    return a.departmentName.localeCompare(b.departmentName,"zh-CN");
   });
 },[ledger,query,sort,onlyPending]);
 return <section className="cdw-section">
  <div className="cdw-section-head"><h3>部门受控发行签收台账</h3>
   <RareButton type="button" tone="ghost" disabled={loading} onClick={()=>setReload(v=>v+1)}>刷新</RareButton>
  </div>
  {loading&&<BrandLoadingLabel showContext>正在核验真实签收和阅读事件</BrandLoadingLabel>}
  {error&&<RareNotice tone="danger">{error}</RareNotice>}
  {ledger&&!loading&&<div className="cdw-form">
   <div className="cdw-detail-facts">
    <div><span>部门签收</span><strong>{ledger.receiptCompleted} / {ledger.rows.length}</strong></div>
    <div><span>已指定人员阅读</span><strong>{ledger.readingConfirmed} / {ledger.readingAssigned}</strong></div>
    <div><span>部门阅读名册配置</span><strong>{ledger.rows.filter(row=>row.readingAssigned>0).length} / {ledger.rows.length}</strong></div>
   </div>
   <div className="cdw-review-digest"><small>发行清单 SHA-256</small><code>{ledger.manifestSha256}</code></div>
   <div className="cdw-ledger-tools">
    <RareInput type="search" aria-label="搜索部门签收台账" value={query}
     placeholder="搜索部门、接收人或异常…" onChange={e=>setQuery(e.target.value)}/>
    <RareSelect aria-label="台账排序" value={sort} onChange={e=>setSort(e.target.value as Sort)}>
     <option value="department">按部门</option><option value="signed">按签收时间</option>
     <option value="reading">按阅读进度</option>
    </RareSelect>
    <RareButton type="button" aria-pressed={onlyPending} tone={onlyPending?"primary":"neutral"}
     onClick={()=>setOnlyPending(v=>!v)}>{onlyPending?"✓ 仅待办":"仅看未完成"}</RareButton>
   </div>
   <div className="cdw-ledger-scroll" role="region" aria-label="部门签收及阅读统计">
    <table className="cdw-ledger-table">
     <thead><tr>
      <th>接收部门</th><th>指定接收人</th><th>实际签收人</th><th>签收时间</th>
      <th>阅读确认</th><th>状态与异常</th>
     </tr></thead>
     <tbody>
      {rows.map(row=><tr key={row.targetId}>
       <td><strong>{row.departmentName}</strong></td>
       <td>{row.receiverName}</td>
       <td>{row.actualSignerName??"—"}</td>
       <td>{row.signedAt?new Date(row.signedAt).toLocaleString("zh-CN"):"未签收"}</td>
       <td><span>{row.readingConfirmed}/{row.readingAssigned}</span>
        <small>{readingLabel(row)}</small></td>
       <td>{row.exceptionReason?<RareBadge tone="warning">{row.exceptionReason}</RareBadge>:
        row.overdue?<RareBadge tone="warning">签收逾期</RareBadge>:
        row.receiptStatus==="received"&&row.readingStatus==="confirmed"?
         <RareBadge tone="success">已完成</RareBadge>:
         <RareBadge tone="neutral">{row.receiptStatus==="received"?"待阅读完成":"待部门签收"}</RareBadge>}
       </td>
      </tr>)}
     </tbody>
    </table>
    {rows.length===0&&<div className="cdw-message">暂无符合筛选条件的部门</div>}
   </div>
  </div>}
 </section>;
}
