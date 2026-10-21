import {useEffect,useState} from "react";
import {Link} from "react-router-dom";
import {RareBadge,RareButton,RareNotice,RareTextarea} from "../../shared/ui/rare";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {toast} from "../../shared/ui/feedback";
import {errorCopy} from "../../shared/errors";
import {customerApi} from "./api";
import {categories,type CustomerRegistration} from "./model";

const stateNames={pending:"待审核",approved:"已通过",rejected:"未通过"};
export function CustomerRegistrationWorkspace({actorId,refreshToken,onDecided,initialScope="inbox"}:{actorId:string;refreshToken:number;onDecided:()=>void;initialScope?:"inbox"|"mine"}){
 const[scope,setScope]=useState<"inbox"|"mine">(initialScope);
 const[items,setItems]=useState<CustomerRegistration[]>([]);
 const[selectedId,setSelectedId]=useState("");
 const[busy,setBusy]=useState(false);
 const[error,setError]=useState("");
 const[reason,setReason]=useState("");
 const[processing,setProcessing]=useState(false);
 const[updated,setUpdated]=useState(0);
 useEffect(()=>{
  let active=true;setBusy(true);setError("");
  customerApi.registrations(scope).then(page=>{if(active){setItems(page.items??[]);setSelectedId(id=>page.items?.some(v=>v.id===id)?id:page.items?.[0]?.id??"");}})
   .catch(e=>{if(active){setItems([]);setError(errorCopy(e,"客户登记审批读取失败"));}})
   .finally(()=>{if(active)setBusy(false)});
  return()=>{active=false};
 },[scope,refreshToken,updated]);
 const selected=items.find(x=>x.id===selectedId)??null;
 async function decide(decision:"approved"|"rejected"){
  if(!selected||processing)return;
  if(decision==="rejected"&&reason.trim().length<3){toast.warning("退回时请填写至少三个字的审核意见");return;}
  setProcessing(true);
  try{
   await toast.track(()=>customerApi.decide(selected.id,selected.revision,decision,reason.trim()),
    {loading:"正在提交客户登记审批…",success:decision==="approved"?"客户登记审核已通过":"客户登记审核已退回",error:e=>errorCopy(e,"审批失败")});
   setReason("");setUpdated(x=>x+1);onDecided();
  }catch{/* toast handles error */}finally{setProcessing(false)}
 }
 return <section className="customer-approvals-workbench" aria-label="客户登记审批">
  <header className="customer-approvals-header"><div><strong>客户登记审批</strong><small>客户资料的审核统一在工作台办理</small></div><div>
   <RareButton type="button" className={scope==="inbox"?"selected":""} onClick={()=>{setScope("inbox");setReason("")}}>待我审核</RareButton>
   <RareButton type="button" className={scope==="mine"?"selected":""} onClick={()=>{setScope("mine");setReason("")}}>我发起的</RareButton>
  </div></header>
  {error&&<RareNotice tone="danger">{error}<RareButton onClick={()=>setUpdated(n=>n+1)}>重试</RareButton></RareNotice>}
  <div className="customer-approvals-columns">
   <div className="customer-approvals-list">
    {busy&&<div className="customer-approvals-empty"><BrandLoadingLabel showContext>读取登记事项</BrandLoadingLabel></div>}
    {!busy&&items.length===0&&<div className="customer-approvals-empty"><strong>{scope==="inbox"?"暂无客户登记待办":"尚未发起客户登记"}</strong><small>可从客户资料中直接发起登记审批</small></div>}
    {items.map(x=><RareButton type="button" key={x.id} className={selectedId===x.id?"chosen":""} onClick={()=>{setSelectedId(x.id);setReason("")}}>
     <span><small>{x.customerCode} · {x.state==="pending"?"待审核":stateNames[x.state]}</small><strong>{x.customerName}</strong><small>{new Date(x.createdAt).toLocaleDateString("zh-CN")}</small></span><span aria-hidden="true">›</span>
    </RareButton>)}
   </div>
   <article className="customer-approvals-detail">
    {selected?<><div className="customer-approvals-detail-head"><div><small>客户登记 / {selected.customerCode}</small><h2>{selected.customerName}</h2></div>
     <RareBadge tone={selected.state==="approved"?"success":selected.state==="rejected"?"danger":"warning"}>{stateNames[selected.state]}</RareBadge></div>
     <div className="customer-approvals-snapshot">
      <div><span>客户类别</span><strong>{categories[selected.snapshot.category]}</strong></div>
      <div><span>统一社会信用代码</span><strong>{selected.snapshot.creditCode||"—"}</strong></div>
      <div><span>联系人</span><strong>{selected.snapshot.profile.contact||"—"}</strong></div>
      <div><span>联系电话</span><strong>{selected.snapshot.profile.phone||"—"}</strong></div>
      <div className="wide"><span>地址</span><strong>{selected.snapshot.profile.address||"—"}</strong></div>
      <div className="wide"><span>经营范围</span><strong>{selected.snapshot.profile.businessScope||"—"}</strong></div>
      <div><span>档案版本</span><strong>第 {selected.snapshotRevision} 版</strong></div>
      <div><span>资质证照</span><strong>{selected.snapshot.profile.certificates?.length??0} 份</strong></div>
     </div>
     {(selected.snapshot.profile.certificates??[]).length>0&&<div className="customer-approvals-cert-list">
      <h3>资质文件</h3>
      {selected.snapshot.profile.certificates.map((cert,i)=><div key={cert.id||i}><span>{cert.kind||"资质证照"} · {cert.number||"无证号"} · 有效期至 {cert.expiresOn||"未填写"}</span>
       {cert.fileId&&<Link to={"/preview/"+encodeURIComponent(cert.fileId)}>原始文件 ↗</Link>}</div>)}
     </div>}
     <div className="customer-approvals-foot">
      {selected.state==="pending"&&selected.reviewerId===actorId?<>
       <label>审核意见（退回时必填）<RareTextarea value={reason} rows={3} maxLength={1000} placeholder="核验客户资料、经营资质及原始附件后填写审核意见" onChange={e=>setReason(e.target.value)}/></label>
       <div className="customer-approvals-actions"><RareButton type="button" tone="neutral" disabled={processing} onClick={()=>void decide("rejected")}>退回</RareButton>
        <RareButton type="button" tone="primary" loading={processing} disabled={processing} onClick={()=>void decide("approved")}>审核通过</RareButton></div>
      </>:selected.state==="pending"?<RareNotice tone="info">申请已提交，正在等待指定审核人处理。</RareNotice>:
       <div className="customer-approvals-decision"><strong>{stateNames[selected.state]}</strong><span>{selected.reason||"没有填写审核意见"}</span></div>}
      <Link to={"/customers?customer="+encodeURIComponent(selected.customerId)}>返回客户档案 ↗</Link>
     </div>
    </>:<div className="customer-approvals-empty">选择客户登记事项查看审核资料</div>}
   </article>
  </div>
 </section>;
}
