import {useEffect,useMemo,useState,type FormEvent} from "react";
import {Link,useSearchParams} from "react-router-dom";
import type {User} from "../entities/user/model";
import {AppShell} from "../shared/ui/AppShell";
import {RareBadge,RareButton,RareDataTable,RareInput,RareNotice,RareSelect,RareTextarea} from "../shared/ui/rare";
import {BrandLoadingLabel} from "../shared/ui/BrandLoader";
import {toast} from "../shared/ui/feedback";
import {errorCopy} from "../shared/errors";
import {organizationApi} from "../features/organization/api";
import {customerApi} from "../features/customers/api";
import {categories,fromCustomer,newCustomer,type Customer,type CustomerCategory,type CustomerWrite,type CustomerEvent,type CustomerRegistration,type CustomerProfile} from "../features/customers/model";
import {CustomerCertificateEditor} from "../features/customers/CustomerCertificateEditor";
import "./customerData.css";

const categoryOptions=Object.entries(categories) as [CustomerCategory,string][];
const simpleProfileFields:{field:keyof CustomerProfile;label:string;type?:string}[]=[
 {field:"contact",label:"业务联系人"},{field:"phone",label:"联系电话"},
 {field:"email",label:"电子邮箱",type:"email"},{field:"address",label:"联系地址"},
 {field:"legalRepresentative",label:"法定代表人"},{field:"businessMethod",label:"经营方式"},
 {field:"bankName",label:"开户银行"},{field:"bankAccount",label:"银行账号"},
 {field:"taxNumber",label:"开票税号"},
];
const eventName:Record<string,string>={created:"建立客户档案",updated:"更新客户资料",disabled:"停用客户",enabled:"恢复客户",
 registration_submitted:"发起登记审批",registration_approved:"登记审批通过",registration_rejected:"登记审批退回"};
const stateName:Record<CustomerRegistration["state"],string>={pending:"待审核",approved:"已通过",rejected:"未通过"};
function displayDate(s:string){return s?new Date(s).toLocaleString("zh-CN",{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}):"—"}
function DetailFact({label,value}:{label:string;value?:string}){return <div className="customer-fact"><span>{label}</span><strong>{value||"—"}</strong></div>}
function CustomerEdit({draft,setDraft,busy,onSave,onCancel,isNew}:{draft:CustomerWrite;setDraft:(next:CustomerWrite)=>void;busy:boolean;onSave:(e:FormEvent)=>void;onCancel:()=>void;isNew:boolean}){
 const basic=(field:"name"|"creditCode",value:string)=>setDraft({...draft,[field]:value});
 const profile=(field:keyof CustomerProfile,value:string)=>setDraft({...draft,profile:{...draft.profile,[field]:value}});
 const certificates=draft.profile.certificates??[];
 const editCertificate=(index:number,next:typeof certificates[number])=>setDraft({...draft,profile:{...draft.profile,certificates:certificates.map((c,i)=>i===index?next:c)}});
 return <form className="customer-form" onSubmit={onSave}>
  <div className="customer-detail-toolbar"><div><strong>{isNew?"新增客户":"编辑客户资料"}</strong><small>{isNew?"录入后立即保存客户档案":"修改完成后保存新修订"}</small></div><RareButton type="button" tone="ghost" disabled={busy} onClick={onCancel}>取消</RareButton></div>
  <div className="customer-detail-scroll">
   <h3>基本信息</h3><div className="customer-fields">
    <label className="customer-field-wide">客户全称 <span className="customer-required">*</span>
     <RareInput required autoFocus maxLength={200} value={draft.name} placeholder="企业或机构的完整法定名称" onChange={e=>basic("name",e.target.value)}/>
    </label>
    <label>客户类别<RareSelect value={draft.category} onChange={e=>setDraft({...draft,category:e.target.value as CustomerCategory})}>
     {categoryOptions.map(([key,value])=><option value={key} key={key}>{value}</option>)}
    </RareSelect></label>
    <label>统一社会信用代码<RareInput maxLength={32} value={draft.creditCode} onChange={e=>basic("creditCode",e.target.value)}/></label>
   </div>
   <h3>联系与经营信息</h3>
   <div className="customer-fields">
    {simpleProfileFields.map(item=><label key={item.field} className={item.field==="address"?"customer-field-wide":undefined}>
     {item.label}<RareInput type={item.type??"text"} maxLength={500} value={String(draft.profile[item.field]??"")} onChange={e=>profile(item.field,e.target.value)}/>
    </label>)}
   </div>
   <div className="customer-fields customer-long-fields">
    <label>经营范围<RareTextarea rows={3} maxLength={4000} value={draft.profile.businessScope} onChange={e=>profile("businessScope",e.target.value)}/></label>
    <label>备注<RareTextarea rows={3} maxLength={4000} value={draft.profile.notes} onChange={e=>profile("notes",e.target.value)}/></label>
   </div>
   <div className="customer-section-header"><h3>资质证照</h3><RareButton type="button" tone="ghost" onClick={()=>{
    const cert={id:"",kind:"",number:"",issuedOn:"",expiresOn:"",fileId:"",note:""};
    setDraft({...draft,profile:{...draft.profile,certificates:[...certificates,cert]}});
   }}>＋ 添加证照</RareButton></div>
   {certificates.length===0&&<p className="customer-placeholder">暂无证照。可先保存客户，再随时补充资质文件。</p>}
   {certificates.map((certificate,index)=><CustomerCertificateEditor key={certificate.id||"draft-"+index} certificate={certificate}
    onChange={v=>editCertificate(index,v)} onRemove={()=>setDraft({...draft,profile:{...draft.profile,certificates:certificates.filter((_,i)=>i!==index)}})}/>)}
  </div>
  <div className="customer-form-actions"><RareButton tone="primary" type="submit" loading={busy} disabled={busy||draft.name.trim().length<2}>{isNew?"建立客户档案":"保存修改"}</RareButton></div>
 </form>;
}

export function CustomerData({user,onLogout}:{user:User;onLogout:()=>void}){
 const[params,setParams]=useSearchParams();
 const selectedId=params.get("customer")??"";
 const[search,setSearch]=useState("");
 const[query,setQuery]=useState("");
 const[category,setCategory]=useState("");
 const[status,setStatus]=useState("");
 const[rows,setRows]=useState<Customer[]>([]);
 const[nextCursor,setNextCursor]=useState("");
 const[refresh,setRefresh]=useState(0);
 const[busy,setBusy]=useState(false);
 const[moreBusy,setMoreBusy]=useState(false);
 const[listError,setListError]=useState("");
 const[detail,setDetail]=useState<Customer|null>(null);
 const[detailBusy,setDetailBusy]=useState(false);
 const[events,setEvents]=useState<CustomerEvent[]>([]);
 const[cases,setCases]=useState<CustomerRegistration[]>([]);
 const[section,setSection]=useState<"profile"|"certificates"|"history">("profile");
 const[mode,setMode]=useState<"create"|"edit"|null>(null);
 const[draft,setDraft]=useState<CustomerWrite>(newCustomer());
 const[pristine,setPristine]=useState<CustomerWrite>(newCustomer());
 const[saving,setSaving]=useState(false);
 const[reviewer,setReviewer]=useState("");
 const[reviewerOpen,setReviewerOpen]=useState(false);
 const[reviewers,setReviewers]=useState<User[]>([]);
 const[reviewersBusy,setReviewersBusy]=useState(false);
 const[reviewerError,setReviewerError]=useState("");
 const[submissionBusy,setSubmissionBusy]=useState(false);
 const dirty=mode!==null&&JSON.stringify(draft)!==JSON.stringify(pristine);
 const selectedCase=cases.find(x=>x.customerId===selectedId);
 const waiting=selectedCase?.state==="pending";
 const list=useMemo(()=>rows,[rows]);
 useEffect(()=>{const timer=window.setTimeout(()=>setQuery(search.trim()),260);return()=>window.clearTimeout(timer)},[search]);
 useEffect(()=>{
  const controller=new AbortController();let live=true;
  setBusy(true);setListError("");setNextCursor("");
  customerApi.list(query,category,status,"",50,controller.signal).then(v=>{
   if(live){setRows(v.items??[]);setNextCursor(v.nextCursor??"");}
  }).catch(err=>{if(live){setRows([]);setListError(errorCopy(err,"客户列表读取失败"));}})
   .finally(()=>{if(live)setBusy(false)});
  return()=>{live=false;controller.abort()};
 },[query,category,status,refresh]);
 useEffect(()=>{
  if(!selectedId){setDetail(null);setCases([]);setEvents([]);return;}
  let live=true;setDetailBusy(true);
  Promise.all([customerApi.get(selectedId),customerApi.registrations("mine"),customerApi.events(selectedId)])
   .then(([item,registrations,history])=>{if(live){setDetail(item);setCases(registrations.items??[]);setEvents(history.items??[]);}})
   .catch(e=>{if(live){setDetail(null);toast.error(errorCopy(e,"客户资料读取失败"));}})
   .finally(()=>{if(live)setDetailBusy(false)});
  return()=>{live=false};
 },[selectedId,refresh]);
 useEffect(()=>{
  if(!dirty)return;
  const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue="";};
  window.addEventListener("beforeunload",warn);
  return()=>window.removeEventListener("beforeunload",warn);
 },[dirty]);
 function canLeave(){return !dirty||window.confirm("当前客户表单尚未保存，确定放弃修改吗？")}
 function choose(id:string){if(!canLeave())return;setMode(null);setReviewerOpen(false);setSection("profile");setParams(current=>{
  const n=new URLSearchParams(current);if(id)n.set("customer",id);else n.delete("customer");return n;
 });}
 function create(){if(!canLeave())return;const start=newCustomer();setPristine(start);setDraft(start);setMode("create");setReviewerOpen(false);}
 function edit(){if(!detail)return;const start=fromCustomer(detail);setPristine(start);setDraft(start);setMode("edit");}
 function cancel(){if(canLeave())setMode(null)}
 async function save(e:FormEvent){
  e.preventDefault();if(saving)return;setSaving(true);
  try{
   const saved=await toast.track(()=>mode==="create"?customerApi.create(draft):customerApi.update(detail!.id,draft),
    {loading:"正在保存客户档案…",success:mode==="create"?"客户档案已建立":"客户资料已更新",error:err=>errorCopy(err,"保存失败")});
   setMode(null);setPristine(fromCustomer(saved));setDetail(saved);
   setParams(current=>{const n=new URLSearchParams(current);n.set("customer",saved.id);return n});
   setRefresh(n=>n+1);
  }catch{/* toast.track shows failure */}finally{setSaving(false)}
 }
 async function loadMore(){
  if(!nextCursor||moreBusy)return;
  setMoreBusy(true);
  try{
   const page=await customerApi.list(query,category,status,nextCursor,50);
   setRows(before=>[...before,...page.items.filter(x=>!before.some(y=>x.id===y.id))]);setNextCursor(page.nextCursor??"");
  }catch(e){toast.error(errorCopy(e,"读取更多客户失败"))}finally{setMoreBusy(false)}
 }
 async function showReviewers(){
  setReviewerOpen(true);setReviewerError("");setReviewersBusy(true);
  try{setReviewers((await organizationApi.users()).filter(x=>!x.disabled&&x.id!==user.id));}
  catch(e){setReviewerError(errorCopy(e,"无法获取可选审核人"))}finally{setReviewersBusy(false)}
 }
 async function submitRegistration(){
  if(!detail||!reviewer||submissionBusy)return;setSubmissionBusy(true);
  try{
   await toast.track(()=>customerApi.submit(detail.id,reviewer),{loading:"正在发起客户登记审批…",success:"审批已提交到工作台",error:e=>errorCopy(e,"提交审批失败")});
   setReviewerOpen(false);setReviewer("");setRefresh(v=>v+1);
  }catch{/* toast handles it */}finally{setSubmissionBusy(false)}
 }
 async function flipStatus(){
  if(!detail||saving)return;
  const next=detail.status==="active"?"disabled":"active";
  if(next==="disabled"&&!window.confirm("确定停用该客户？停用后不能发起新的登记审批。"))return;
  setSaving(true);
  try{
   await toast.track(()=>customerApi.update(detail.id,{...fromCustomer(detail),status:next}),{loading:"正在变更客户状态…",success:next==="disabled"?"客户已停用":"客户已恢复使用",error:e=>errorCopy(e,"状态变更失败")});
   setRefresh(v=>v+1);
  }catch{/* toast handles it */}finally{setSaving(false)}
 }
 if(!user.isAdmin)return <AppShell user={user} onLogout={onLogout}><main className="customer-no-access"><RareNotice tone="warning">当前账号没有客户档案维护权限，请联系管理员授权。</RareNotice></main></AppShell>;
 return <AppShell user={user} onLogout={onLogout}>
  <div className="panels customers-panels"><main className="work customer-work" aria-label="客户资料">
   <div className="customer-layout">
    <aside className="customer-sidebar" aria-label="客户类别"><div className="customer-side-heading">客户资料<small>客户主数据</small></div>
     <nav><RareButton type="button" className={!category?"active":""} aria-current={!category?"page":undefined} onClick={()=>setCategory("")}>全部客户</RareButton>
      {categoryOptions.map(([key,value])=><RareButton type="button" key={key} className={category===key?"active":""} aria-current={category===key?"page":undefined} onClick={()=>setCategory(key)}>{value}</RareButton>)}
     </nav><div className="customer-sidebar-hint">客户建档和登记审批分离；审批事务在工作台处理。</div>
    </aside>
    <section className="customer-list-pane" aria-label="客户档案列表">
     <div className="customer-list-toolbar"><div className="customer-search"><RareInput type="search" aria-label="搜索客户" placeholder="搜索名称、编号或信用代码" value={search} onChange={e=>setSearch(e.target.value)}/></div>
      <RareButton type="button" tone="primary" onClick={create}>＋ 新增客户</RareButton>
     </div>
     <div className="customer-list-subtools"><RareSelect aria-label="筛选客户状态" value={status} onChange={e=>setStatus(e.target.value)}>
      <option value="">全部状态</option><option value="active">使用中</option><option value="disabled">已停用</option>
     </RareSelect><span>当前显示 {list.length} 位客户{nextCursor?" · 可加载更多":""}</span>
      <RareButton type="button" tone="ghost" onClick={()=>setRefresh(v=>v+1)}>刷新</RareButton></div>
     {listError&&<RareNotice tone="danger">{listError} <RareButton onClick={()=>setRefresh(v=>v+1)}>重试</RareButton></RareNotice>}
     <div className="customer-table-scroll">
      <RareDataTable><thead><tr><th>客户编号</th><th>客户名称</th><th>类别</th><th>联系人</th><th>状态</th></tr></thead>
       <tbody>{list.map(item=><tr className={selectedId===item.id&&mode!=="create"?"selected":""} key={item.id}>
        <td><RareButton type="button" tone="ghost" className="customer-row-select" onClick={()=>choose(item.id)}>{item.code}</RareButton></td>
        <td><RareButton type="button" tone="ghost" className="customer-row-name" onClick={()=>choose(item.id)}>{item.name}</RareButton></td>
        <td>{categories[item.category]}</td><td>{item.profile?.contact||"—"}</td>
        <td><RareBadge tone={item.status==="active"?"success":"neutral"}>{item.status==="active"?"使用中":"已停用"}</RareBadge></td>
       </tr>)}</tbody></RareDataTable>
      {busy&&<div className="customer-list-message"><BrandLoadingLabel showContext>加载客户资料</BrandLoadingLabel></div>}
      {!busy&&!listError&&list.length===0&&<div className="customer-list-message"><strong>{query?"未找到匹配客户":"尚无客户档案"}</strong><p>{query?"尝试其他名称或编号":"使用右上角新增客户开始建档"}</p></div>}
      {!!nextCursor&&<div className="customer-more"><RareButton type="button" disabled={moreBusy} loading={moreBusy} onClick={()=>void loadMore()}>加载更多客户</RareButton></div>}
     </div>
    </section>
    <article className="customer-detail-pane" aria-label="客户档案详情">
     {mode?<CustomerEdit draft={draft} setDraft={setDraft} busy={saving} onSave={save} onCancel={cancel} isNew={mode==="create"}/>:
      detailBusy?<div className="customer-detail-loading"><BrandLoadingLabel showContext>读取客户详情</BrandLoadingLabel></div>:
      detail?<><div className="customer-detail-toolbar">
       <div><small>{detail.code} · {categories[detail.category]}</small><strong>{detail.name}</strong></div>
       <div className="customer-detail-actions"><RareButton type="button" tone="ghost" onClick={edit}>编辑</RareButton>
        <RareButton type="button" tone="primary" disabled={!!waiting||detail.status==="disabled"} onClick={()=>void showReviewers()}>{waiting?"审批进行中":"发起登记审批"}</RareButton></div>
      </div>
      <div className="customer-detail-tabs" role="tablist" aria-label="客户详情">
       {(["profile","certificates","history"] as const).map((key,i)=><RareButton key={key} type="button" role="tab" aria-selected={section===key} className={section===key?"active":""} tone="ghost" onClick={()=>setSection(key)}>{["基本资料","资质证照","变更记录"][i]}</RareButton>)}
      </div>
      <div className="customer-detail-scroll">
       {section==="profile"&&<>
        <div className="customer-profile-heading"><h3>客户信息</h3><RareBadge tone={detail.status==="active"?"success":"neutral"}>{detail.status==="active"?"使用中":"已停用"}</RareBadge></div>
        <div className="customer-facts"><DetailFact label="客户编号" value={detail.code}/><DetailFact label="统一社会信用代码" value={detail.creditCode}/>
        <DetailFact label="业务联系人" value={detail.profile.contact}/><DetailFact label="联系电话" value={detail.profile.phone}/>
        <DetailFact label="法定代表人" value={detail.profile.legalRepresentative}/><DetailFact label="电子邮箱" value={detail.profile.email}/>
        <DetailFact label="联系地址" value={detail.profile.address}/><DetailFact label="经营方式" value={detail.profile.businessMethod}/>
        <DetailFact label="开户银行" value={detail.profile.bankName}/><DetailFact label="银行账号" value={detail.profile.bankAccount}/>
        <DetailFact label="开票税号" value={detail.profile.taxNumber}/></div>
        <h3>经营范围</h3><p className="customer-long-text">{detail.profile.businessScope||"未填写"}</p>
        <h3>备注</h3><p className="customer-long-text">{detail.profile.notes||"未填写"}</p>
        <h3>档案管理</h3><div className="customer-facts"><DetailFact label="创建时间" value={displayDate(detail.createdAt)}/><DetailFact label="最后修改" value={displayDate(detail.updatedAt)}/><DetailFact label="档案修订" value={String(detail.revision)}/></div>
        <div className="customer-status-action"><RareButton type="button" tone={detail.status==="active"?"danger":"neutral"} disabled={saving||!!waiting} onClick={()=>void flipStatus()}>{detail.status==="active"?"停用此客户":"恢复此客户"}</RareButton></div>
       </>}
       {section==="certificates"&&<><div className="customer-section-header"><h3>客户资质证照</h3><span>{detail.profile.certificates?.length||0} 份</span></div>
        {(detail.profile.certificates??[]).length===0?<p className="customer-placeholder">尚未关联任何证照。点击“编辑”补充证照号码、日期及原始文件。</p>:
        detail.profile.certificates.map((cert,index)=><section className="customer-cert-summary" key={cert.id||index}>
         <strong>{cert.kind||"其他证照"}</strong><div className="customer-facts">
          <DetailFact label="证照号码" value={cert.number}/><DetailFact label="签发日期" value={cert.issuedOn}/>
          <DetailFact label="到期日期" value={cert.expiresOn}/><DetailFact label="备注" value={cert.note}/></div>
         {cert.fileId?<Link to={"/preview/"+encodeURIComponent(cert.fileId)}>查看关联原始文件 ↗</Link>:<small>未关联文件</small>}
        </section>)}
       </>}
       {section==="history"&&<><h3>档案变更与审批留痕</h3>
        {events.length===0?<p className="customer-placeholder">还没有操作记录。</p>:<ol className="customer-history">
         {events.map(event=><li key={event.id}><strong>{eventName[event.action]??event.action}</strong><span>{displayDate(event.createdAt)} · 操作人 {event.actorId}</span><small>档案修订 {event.revision}{event.reason?" · "+event.reason:""}</small></li>)}
        </ol>}
       </>}
      </div>
      {reviewerOpen&&<div className="customer-reviewer-inline">
       <div className="customer-reviewer-heading"><strong>发起客户登记审批</strong><RareButton tone="ghost" type="button" onClick={()=>setReviewerOpen(false)}>关闭</RareButton></div>
       <p>将当前客户资料锁定为审批快照，审核人从工作台处理。</p>
       {reviewerError&&<RareNotice tone="danger">{reviewerError}</RareNotice>}
       <label>指定审核人<RareSelect aria-label="登记审核人" searchable disabled={reviewersBusy} value={reviewer} onChange={e=>setReviewer(e.target.value)}>
        <option value="">选择审核人员</option>{reviewers.map(person=><option key={person.id} value={person.id}>{person.displayName}</option>)}
       </RareSelect></label>
       <RareButton type="button" tone="primary" loading={submissionBusy} disabled={!reviewer||submissionBusy} onClick={()=>void submitRegistration()}>确认发起</RareButton>
      </div>}
      {selectedCase&&<div className="customer-registration-summary"><span>最近一次登记审批</span><strong>{stateName[selectedCase.state]}</strong><small>{displayDate(selectedCase.createdAt)} · <Link to="/workbench/customer-registrations?scope=mine">进入工作台查看 →</Link></small></div>}
      </>:<div className="customer-detail-empty"><strong>选择一位客户</strong><p>查看完整档案、证照、变更记录，或新建客户。</p><RareButton type="button" onClick={create}>新增客户</RareButton></div>}
    </article>
   </div>
  </main></div>
 </AppShell>;
}
