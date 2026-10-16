import {useEffect,useState} from "react";
import {RareBadge,RareButton,RareNotice} from "../../shared/ui/rare";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {errorCopy} from "../../shared/errors";
import {cdwApi,type CDWActivationAttempt} from "./api";

const blockers:Record<string,string>={
 unsupported_activation_policy:"生效策略版本不适用",
 planned_effective_time_not_reached:"计划生效时间未到",
 verified_dispatched_manifest_missing:"发行物或批准清单未就绪",
 distribution_not_dispatched:"发行批次未完成",
 distribution_targets_invalid:"分发目标已失效",
 department_receipts_incomplete:"部门签收未齐",
 required_readings_incomplete:"人员阅读确认未齐",
 paper_issue_not_frozen:"纸质副本未按批准数量登记",
 supersession_lineage_mismatch:"版本替代关系冲突",
 previous_paper_copies_outstanding:"旧版纸质副本未回收",
 supersession_pointer_missing:"旧版有效指针异常"
};
export function CDWActivationHistoryPanel({releaseId}:{releaseId:string}){
 const [rows,setRows]=useState<CDWActivationAttempt[]>([]);
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState("");
 const [revision,setRevision]=useState(0);
 useEffect(()=>{
  let active=true;setLoading(true);setError("");
  cdwApi.controlActivationHistory(releaseId)
   .then(r=>{if(active)setRows(r.items??[])})
   .catch(e=>{if(active)setError(errorCopy(e,"无法读取正式生效时间线"))})
   .finally(()=>{if(active)setLoading(false)});
  return()=>{active=false};
 },[releaseId,revision]);
 return <div className="cdw-review-form">
  <div className="cdw-review-actions"><strong>生效判定与审计时间线</strong>
   <RareButton type="button" tone="ghost" disabled={loading} onClick={()=>setRevision(v=>v+1)}>刷新</RareButton>
  </div>
  {loading&&<BrandLoadingLabel showContext>读取生效判定记录</BrandLoadingLabel>}
  {error&&<RareNotice tone="danger">{error}</RareNotice>}
  {!loading&&!error&&rows.length===0&&<p className="cdw-section-note">尚未发起正式生效判定。</p>}
  {!loading&&!error&&rows.length>0&&<div className="cdw-ledger-scroll" role="region" aria-label="不可变正式生效判定记录">
   <table className="cdw-ledger-table">
    <thead><tr><th>判定时间</th><th>结果</th><th>操作人</th><th>条件和阻断证据</th></tr></thead>
    <tbody>{rows.map(row=><tr key={row.id}>
     <td>{new Date(row.attemptedAt).toLocaleString("zh-CN")}</td>
     <td><RareBadge tone={row.outcome==="activated"?"success":"warning"}>
      {row.outcome==="activated"?"已生效":row.outcome==="blocked"?"未满足条件":"生效失败"}
     </RareBadge></td>
     <td>{row.actorId||"系统"}</td>
     <td>{row.blockers.length?row.blockers.map(b=>blockers[b]??b).join("；"):"全部条件通过"}</td>
    </tr>)}</tbody>
   </table>
  </div>}
 </div>;
}
