import {useEffect,useRef,useState} from "react";
import {RareBadge,RareButton,RareNotice} from "../../shared/ui/rare";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {toast} from "../../shared/ui/feedback";
import {errorCopy} from "../../shared/errors";
import {newIdempotencyKey} from "../../shared/ids";
import {ApiError} from "../../shared/http";
import {cdwApi,type CDWDistributionPlan} from "./api";
import {organizationApi} from "../organization/api";

export function CDWScopeApprovalPanel({plan,onApproved}:{plan:CDWDistributionPlan;onApproved:()=>void}){
 const [detail,setDetail]=useState<CDWDistributionPlan|null>(null);
 const [departmentNames,setDepartmentNames]=useState<Record<string,string>>({});
 const [personNames,setPersonNames]=useState<Record<string,string>>({});
 const [error,setError]=useState("");
 const [busy,setBusy]=useState(false);
 const key=useRef("");
 useEffect(()=>{
  let active=true;setDetail(null);setError("");
  cdwApi.distributionRead(plan.id).then(item=>{if(active)setDetail(item)})
   .catch(e=>{if(active)setError(errorCopy(e,"无法读取冻结范围"))});
  organizationApi.departments().then(items=>{
   if(active)setDepartmentNames(Object.fromEntries(items.map(d=>[d.id,d.name])));
  }).catch(()=>undefined);
  organizationApi.users().then(items=>{
   if(active)setPersonNames(Object.fromEntries(items.map(u=>[u.id,u.displayName])));
  }).catch(()=>undefined);
  return()=>{active=false};
 },[plan.id]);
 async function approve(){
  if(!detail||detail.state!=="frozen"||busy)return;
  if(!key.current)key.current=newIdempotencyKey();
  setBusy(true);
  try{
   await toast.track(()=>cdwApi.scopeApprove(detail.id,detail.revision,key.current),{
    loading:"正在核对冻结清单与签署权限…",success:"分发范围已获独立批准；尚未发行",
    error:e=>errorCopy(e,"范围批准失败")
   });
   key.current="";onApproved();
  }catch(e){if(!(e instanceof ApiError&&e.httpStatus===0))key.current="";}
  finally{setBusy(false);}
 }
 return <div className="cdw-detail-inner">
  <div className="cdw-detail-header"><div><small>G9 · 分发范围独立审批</small><h2>{plan.fileName}</h2></div>
   <RareBadge tone="warning">待范围批准</RareBadge></div>
  {error&&<RareNotice tone="danger">{error}</RareNotice>}
  {!detail&&!error&&<BrandLoadingLabel showContext>核验分发清单</BrandLoadingLabel>}
  {detail&&<section className="cdw-section">
   <p className="cdw-section-note">批准人须独立于编制人。服务器重新核对冻结 SHA-256 摘要、部门接收人及权限。批准不等于发行或生效。</p>
   <div className="cdw-detail-facts">
    <div><span>涉及部门</span><strong>{detail.departmentCount}</strong></div>
    <div><span>清单状态</span><strong>{detail.state==="frozen"?"待审核":detail.state}</strong></div>
   </div>
   <div className="cdw-control-recipients" role="table" aria-label="冻结接收清单">
    <div className="cdw-control-recipient-head" role="row"><strong>接收部门</strong><strong>指定接收人</strong><span>渠道</span></div>
    {detail.targets.map(t=><div className="cdw-control-recipient-row" role="row" key={t.departmentId}>
     <span>{departmentNames[t.departmentId]??t.departmentId}</span>
     <span>{personNames[t.receiverId]??t.receiverId}</span><small>电子</small>
    </div>)}
   </div>
   <div className="cdw-review-digest"><small>冻结范围 SHA-256</small><code>{detail.digestSha256}</code></div>
   {detail.state==="frozen"&&<div className="cdw-review-actions">
    <RareButton type="button" tone="primary" loading={busy} disabled={busy}
     onClick={()=>void approve()}>独立批准分发范围</RareButton>
   </div>}
  </section>}
 </div>;
}
