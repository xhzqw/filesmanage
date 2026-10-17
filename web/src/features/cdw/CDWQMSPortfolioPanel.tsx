import {useEffect,useState} from "react";
import {cdwApi,type CDWQMSPortfolio} from "./api";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {RareNotice,RareButton} from "../../shared/ui/rare";
import {errorCopy} from "../../shared/errors";

export function CDWQMSPortfolioPanel(){
 const [page,setPage]=useState<CDWQMSPortfolio|null>(null);
 const [error,setError]=useState("");
 const [loading,setLoading]=useState(true);
 const [refresh,setRefresh]=useState(0);
 useEffect(()=>{
  let active=true;setLoading(true);setError("");
  cdwApi.qmsFormalPortfolio().then(v=>{if(active)setPage(v);})
   .catch(e=>{if(active)setError(errorCopy(e,"跨审批统计加载失败"));})
   .finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};
 },[refresh]);
 return <section className="cdw-section" aria-label="跨文件审批链统计">
  <div className="cdw-section-head">
   <h3>受控审批概览</h3>
   <RareButton type="button" tone="ghost" onClick={()=>setRefresh(v=>v+1)}>刷新</RareButton>
  </div>
  {loading&&<BrandLoadingLabel showContext>汇总有权文件</BrandLoadingLabel>}
  {error&&<RareNotice tone="danger">{error}</RareNotice>}
  {page&&<>
   <p className="cdw-section-note">仅统计当前可预览且具有文控职责的文件，最多显示 {page.limit} 项；不是企业全部质量文件或合规率。</p>
   {page.items.length===0?<p className="cdw-section-note">当前权限范围内没有正式审批记录。</p>:
    <div style={{overflowX:"auto"}}>
     <table className="cdw-ledger-table">
      <thead><tr><th>受控文件</th><th>审批</th><th>中断</th><th>重启</th><th>待签</th><th>批准</th><th>未确认通知</th></tr></thead>
      <tbody>{page.items.map(item=><tr key={item.fileId}>
       <td title={item.fileId}>{item.fileName}</td>
       <td>{item.approvals}</td><td>{item.interrupted}</td><td>{item.restarts}</td>
       <td>{item.pending}</td><td>{item.approved}</td><td>{item.unconfirmedNotices}</td>
      </tr>)}</tbody>
     </table>
    </div>}
   {page.hasMore&&<RareNotice tone="warning">结果超过100项，此处仅展示最近涉及的前100个有权文件，不应视为完整统计。</RareNotice>}
  </>}
 </section>;
}
