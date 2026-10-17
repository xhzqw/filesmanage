import {useEffect,useMemo,useRef,useState} from "react";
import {Link,useNavigate,useSearchParams} from "react-router-dom";
import type {User} from "../entities/user/model";
import type {FileItem} from "../entities/file/model";
import {AppShell} from "../shared/ui/AppShell";
import {RareBadge,RareButton,RareInput,RareNotice,RareSelect} from "../shared/ui/rare";
import {CDWReviewPanel} from "../features/cdw/CDWReviewPanel";
import {CDWFormalPanel} from "../features/cdw/CDWFormalPanel";
import {CDWFormalInitiate} from "../features/cdw/CDWFormalInitiate";
import {CDWQMSReviewInbox} from "../features/cdw/CDWQMSReviewInbox";
import {CDWControlPreparePanel} from "../features/cdw/CDWControlPreparePanel";
import {CDWObligationPanel} from "../features/cdw/CDWObligationPanel";
import {CDWScopeApprovalPanel} from "../features/cdw/CDWScopeApprovalPanel";
import {CDWDepartmentReceiptPanel} from "../features/cdw/CDWDepartmentReceiptPanel";
import {CDWReadingPanel} from "../features/cdw/CDWReadingPanel";
import {CDWEffectiveSearchPanel} from "../features/cdw/CDWEffectiveSearchPanel";
import {BrandLoadingLabel} from "../shared/ui/BrandLoader";
import {toast} from "../shared/ui/feedback";
import {errorCopy} from "../shared/errors";
import {ApiError} from "../shared/http";
import {newIdempotencyKey} from "../shared/ids";
import {collaborationApi} from "../features/collaboration/api";
import {organizationApi} from "../features/organization/api";
import {fileApi} from "../features/documents/api";
import {cdwApi,type CDWBranch,type CDWInboxItem,type CDWRecipient,type CDWReviewGate,type CDWFormalApproval,type CDWApprovedCandidate,type CDWDistributionPlan,type CDWReceiptTarget,type CDWReadingAssignment,type CDWQMSPendingReview,type CDWQMSAppointmentAlert,type CDWQMSSpecialAlert,type CDWQMSSpecialAuthority,type CDWQMSSpecialPolicyImpact,type CDWQMSLegacyAnomaly,type CDWQMSFormalNotice} from "../features/cdw/api";
import "./cdwWorkbench.css";

type View="tasks"|"obligations"|"reviews"|"formal"|"appointments"|"control"|"scope"|"receipts"|"reading"|"effective"|"all";
const viewGroups:{name:string;views:{key:View;label:string;symbol:string}[]}[]=[
 {name:"个人事务",views:[{key:"tasks",label:"工作事项",symbol:"▤"},{key:"obligations",label:"责任待办",symbol:"◇"},{key:"all",label:"全部事项",symbol:"▦"}]},
 {name:"审查与批准",views:[{key:"reviews",label:"交付验收",symbol:"✓"},{key:"formal",label:"正式审批",symbol:"✎"},{key:"appointments",label:"任命核验",symbol:"♙"},{key:"scope",label:"范围审批",symbol:"◎"}]},
 {name:"受控发行",views:[{key:"control",label:"发行准备",symbol:"▣"},{key:"receipts",label:"部门签收",symbol:"⌁"},{key:"reading",label:"阅读确认",symbol:"▧"},{key:"effective",label:"生效文件",symbol:"◈"}]},
];
const kindName:Record<CDWInboxItem["kind"],string>={
 task:"工作交付",obligation:"责任履行",review:"交付验收",formal:"正式审批",
 control:"发行准备",scope:"范围审批",receipt:"部门签收",reading:"阅读确认",
};
function isActionable(item:CDWInboxItem){
 if(item.kind==="control")return true;
 if(item.kind==="task")return ["assigned","accepted","in_progress","returned"].includes(item.state);
 if(item.kind==="obligation")return ["pending","open"].includes(item.state);
 if(item.kind==="receipt")return item.state==="awaiting";
 if(item.kind==="reading")return ["assigned","opened"].includes(item.state);
 return ["pending","awaiting","open","submitted","assigned"].includes(item.state);
}

const labels:Record<string,string>={
 assigned:"待接收",accepted:"已接收",in_progress:"进行中",submitted:"待上级验收",
 returned:"已退回",awaiting:"待我验收",accepted_delivery:"交付已验收",
 open:"工作中",frozen:"已冻结",pending:"待履行",approved_candidate:"已批准 · 待发行准备",
 manage:"管理责任",integrate:"整合责任",report:"上报责任",acknowledge_override:"越级知会",
 closed:"已关闭",cancelled:"已取消",
};
const stateLabel=(v:string)=>labels[v]??v;
function taskKey(item:CDWInboxItem){return item.kind==="reading"?item.reading?.id??item.taskId:item.kind==="receipt"?item.receipt?.targetId??item.taskId:item.kind==="scope"?item.scope?.id??item.taskId:item.kind==="control"?item.candidate?.id??item.taskId:item.kind==="formal"?item.formal?.id??item.taskId:item.kind==="review"?item.review?.gateId??item.taskId:item.kind==="obligation"?item.obligationId??item.taskId:item.taskId;}
function statusTone(state:string):"neutral"|"info"|"warning"|"success"{
 if(state==="assigned"||state==="pending")return "warning";
 if(state==="submitted"||state==="frozen")return "success";
 if(state==="accepted"||state==="in_progress")return "info";
 return "neutral";
}
function RecipientPicker({value,onChange,users}:{value:string;onChange:(id:string)=>void;users:User[]}){
 return <RareSelect aria-label="指派给" searchable value={value} onChange={event=>onChange(event.target.value)}>
  <option value="">选择负责人</option>
  {users.filter(u=>!u.disabled).map(u=><option key={u.id} value={u.id}>{u.displayName} {u.login?"· "+u.login:""}</option>)}
 </RareSelect>;
}
export function CDWWorkbench({user,onLogout}:{user:User;onLogout:()=>void}){
 const[params,setParams]=useSearchParams();
 const[items,setItems]=useState<CDWInboxItem[]>([]);
 const[reviewGates,setReviewGates]=useState<CDWReviewGate[]>([]);
 const[formalApprovals,setFormalApprovals]=useState<CDWFormalApproval[]>([]);
 const[pendingAppointments,setPendingAppointments]=useState<CDWQMSPendingReview[]>([]);
 const[appointmentAlerts,setAppointmentAlerts]=useState<CDWQMSAppointmentAlert[]>([]);
 const[specialAlerts,setSpecialAlerts]=useState<CDWQMSSpecialAlert[]>([]);
 const[specialReviews,setSpecialReviews]=useState<CDWQMSSpecialAuthority[]>([]);
 const[specialImpacts,setSpecialImpacts]=useState<CDWQMSSpecialPolicyImpact[]>([]);
 const[legacyAnomalies,setLegacyAnomalies]=useState<CDWQMSLegacyAnomaly[]>([]);
 const[formalNotices,setFormalNotices]=useState<CDWQMSFormalNotice[]>([]);
 const[controlCandidates,setControlCandidates]=useState<CDWApprovedCandidate[]>([]);
 const[scopeApprovals,setScopeApprovals]=useState<CDWDistributionPlan[]>([]);
 const[receiptTargets,setReceiptTargets]=useState<CDWReceiptTarget[]>([]);
 const[readingAssignments,setReadingAssignments]=useState<CDWReadingAssignment[]>([]);
 const[formalDraft,setFormalDraft]=useState(false);
 const[busy,setBusy]=useState(false);
 const[refreshToken,refresh]=useState(0);
 const[requestError,setRequestError]=useState("");
 const[filter,setFilter]=useState<View>("tasks");
 const[search,setSearch]=useState("");
 const[priorityFirst,setPriorityFirst]=useState(true);
 const[branches,setBranches]=useState<CDWBranch[]>([]);
 const[branchesBusy,setBranchesBusy]=useState(false);
 const[detailsError,setDetailsError]=useState("");
 const[activeForm,setActiveForm]=useState<"create"|"delegate"|null>(null);
 const[title,setTitle]=useState("");
 const[allowOverrideReview,setAllowOverrideReview]=useState(false);
 const[recipient,setRecipient]=useState("");
 const[users,setUsers]=useState<User[]>([]);
 const[usersBusy,setUsersBusy]=useState(false);
 const[usersError,setUsersError]=useState("");
 const[fileQuery,setFileQuery]=useState("");
 const[searchResults,setSearchResults]=useState<FileItem[]>([]);
 const[chosenFile,setChosenFile]=useState<FileItem|null>(null);
 const[fileSearching,setFileSearching]=useState(false);
 const[fileInfo,setFileInfo]=useState<FileItem|null>(null);
 const[processing,setProcessing]=useState(false);
 const requestKeys=useRef(new Map<string,string>());
 const navigate=useNavigate();
 const selectedKey=params.get("task");
 const reviewItems=useMemo<CDWInboxItem[]>(()=>reviewGates.map(gate=>({
  kind:"review",review:gate,taskId:gate.taskId,title:gate.taskTitle,fileId:gate.fileId,
  state:gate.state,revision:gate.revision
 })),[reviewGates]);
 const formalItems=useMemo<CDWInboxItem[]>(()=>formalApprovals.map(a=>({
  kind:"formal",formal:a,taskId:a.id,title:a.fileName??"正式审批候选文件",fileId:a.fileId,
  state:a.state,revision:a.revision
 })),[formalApprovals]);
 const controlItems=useMemo<CDWInboxItem[]>(()=>controlCandidates.map(candidate=>({
  kind:"control",candidate,taskId:candidate.id,title:candidate.fileName,fileId:candidate.fileId,
  state:"approved_candidate",revision:1
 })),[controlCandidates]);
 const scopeItems=useMemo<CDWInboxItem[]>(()=>scopeApprovals.map(scope=>({
  kind:"scope",scope,taskId:scope.id,title:scope.fileName,fileId:scope.fileId,
  state:scope.state,revision:scope.revision
 })),[scopeApprovals]);
 const receiptItems=useMemo<CDWInboxItem[]>(()=>receiptTargets.map(receipt=>({
  kind:"receipt",receipt,taskId:receipt.targetId,title:receipt.fileName,fileId:receipt.fileId,
  state:receipt.state,revision:receipt.revision
 })),[receiptTargets]);
 const readingItems=useMemo<CDWInboxItem[]>(()=>readingAssignments.map(reading=>({
  kind:"reading",reading,taskId:reading.id,title:reading.fileName,fileId:reading.fileId,
  state:reading.state,revision:1
 })),[readingAssignments]);
 const allItems=useMemo(()=>[...items,...reviewItems,...formalItems,...controlItems,...scopeItems,...receiptItems,...readingItems],[items,reviewItems,formalItems,controlItems,scopeItems,receiptItems,readingItems]);
 const visible=useMemo(()=>{
  const query=search.trim().toLocaleLowerCase();
  const matched=allItems.filter(x=>(filter==="all"||x.kind===(filter==="tasks"?"task":filter==="reviews"?"review":filter==="formal"?"formal":filter==="control"?"control":filter==="scope"?"scope":filter==="receipts"?"receipt":filter==="reading"?"reading":"obligation"))
   &&(!query||x.title.toLocaleLowerCase().includes(query)||x.fileId.toLocaleLowerCase().includes(query)));
  return priorityFirst?[...matched].sort((a,b)=>Number(isActionable(b))-Number(isActionable(a))):matched;
 },[allItems,filter,search,priorityFirst]);
 const selected=visible.find(x=>taskKey(x)===selectedKey)??visible[0]??null;

 useEffect(()=>{
  const controller=new AbortController();let active=true;
  setBusy(true);setRequestError("");
  cdwApi.inbox(100,controller.signal).then(page=>{
   if(active)setItems(page.items??[]);
  }).catch(error=>{
   if(active&&!(error instanceof DOMException&&error.name==="AbortError"))setRequestError(errorCopy(error,"工作台事项加载失败"));
  }).finally(()=>{if(active)setBusy(false);});
  return()=>{active=false;controller.abort();};
 },[refreshToken,user.id]);

 useEffect(()=>{
  let active=true;
  cdwApi.reviewInbox(100).then(data=>{if(active)setReviewGates(data.items??[]);})
    .catch(error=>{if(active)setRequestError(errorCopy(error,"验收待办加载失败"));});
  return()=>{active=false};
 },[refreshToken,user.id]);

 useEffect(()=>{
  let live=true;
  cdwApi.formalInbox(100).then(result=>{if(live)setFormalApprovals(result.items??[]);})
   .catch(error=>{if(live)setRequestError(errorCopy(error,"正式审批待办加载失败"));});
  return()=>{live=false;};
 },[refreshToken,user.id]);

 useEffect(()=>{
  let live=true;
  cdwApi.qmsPendingReview().then(result=>{if(live)setPendingAppointments(result.items??[]);})
   .catch(error=>{if(live)setRequestError(errorCopy(error,"岗位任命待核验列表加载失败"));});
  return()=>{live=false;};
 },[refreshToken,user.id]);
 useEffect(()=>{
  let live=true;
  cdwApi.qmsAlerts().then(result=>{if(live)setAppointmentAlerts(result.items??[]);})
   .catch(error=>{if(live)setRequestError(errorCopy(error,"岗位任命通知加载失败"));});
  return()=>{live=false;};
 },[refreshToken,user.id]);
 useEffect(()=>{
  let live=true;
  Promise.all([cdwApi.qmsSpecialAlerts(),cdwApi.qmsSpecialList(),cdwApi.qmsSpecialImpacts(),
   cdwApi.qmsLegacyAnomalies(),cdwApi.qmsFormalNotices()])
   .then(([notices,reviews,impacts,legacy,messages])=>{if(live){
    setSpecialAlerts(notices.items??[]);setSpecialReviews(reviews.items??[]);setSpecialImpacts(impacts.items??[]);
    setLegacyAnomalies(legacy.items??[]);setFormalNotices(messages.items??[]);
   }}).catch(error=>{if(live)setRequestError(errorCopy(error,"专项签批核验事项加载失败"));});
  return()=>{live=false;};
 },[refreshToken,user.id]);
 async function readAppointmentAlert(id:string){
  try{
   await toast.track(()=>cdwApi.qmsAlertRead(id,newIdempotencyKey()),{
    loading:"正在确认通知…",success:"已确认任命失效通知",
    error:e=>errorCopy(e,"通知确认失败")});
   refresh(v=>v+1);
  }catch(error){setRequestError(errorCopy(error,"通知确认失败"));}
 }

 useEffect(()=>{
  let active=true;
  void cdwApi.controlCandidates().then(data=>{if(active)setControlCandidates(data.items??[]);})
   .catch(error=>{if(active)setRequestError(errorCopy(error,"读取已批准候选稿失败"));});
  return()=>{active=false};
 },[refreshToken,user.id]);

 useEffect(()=>{
  let active=true;
  cdwApi.scopeInbox().then(data=>{if(active)setScopeApprovals(data.items??[])})
   .catch(error=>{if(active)setRequestError(errorCopy(error,"分发范围待审列表加载失败"))});
  return()=>{active=false};
 },[refreshToken,user.id]);

 useEffect(()=>{
  let active=true;
  cdwApi.receiptInbox().then(data=>{if(active)setReceiptTargets(data.items??[])})
   .catch(error=>{if(active)setRequestError(errorCopy(error,"部门签收清单加载失败"))});
  return()=>{active=false};
 },[refreshToken,user.id]);

 useEffect(()=>{
  let active=true;
  cdwApi.readingInbox().then(data=>{if(active)setReadingAssignments(data.items??[])})
   .catch(error=>{if(active)setRequestError(errorCopy(error,"个人阅读确认列表加载失败"))});
  return()=>{active=false};
 },[refreshToken,user.id]);

 useEffect(()=>{
  if(!selected||selected.kind!=="task"){setBranches([]);setFileInfo(null);setDetailsError("");return;}
  let alive=true;
  setBranchesBusy(true);setDetailsError("");setBranches([]);setFileInfo(null);
  void cdwApi.branches(selected.taskId).then(result=>{if(alive)setBranches(result.items);})
   .catch(error=>{if(alive&&selected.state!=="assigned")setDetailsError(errorCopy(error,"无法读取工作分支"));})
   .finally(()=>{if(alive)setBranchesBusy(false);});
  void fileApi.meta(selected.fileId).then(meta=>{if(alive)setFileInfo(meta.file);}).catch(()=>undefined);
  return()=>{alive=false;};
 },[selected?.taskId,selected?.kind,selected?.state,refreshToken]);

 useEffect(()=>{
  if(!activeForm)return;
  let live=true;
  setUsersBusy(true);setUsersError("");
  (activeForm==="create"?organizationApi.users():selected?.fileId?
   fileApi.reviewAssignees(selected.fileId).then(list=>list.map(person=>({
    id:person.id,displayName:person.displayName,isAdmin:false,mustChangePassword:false
   } as User))):Promise.resolve([] as User[])).then(data=>{if(live)setUsers(data);})
   .catch(error=>{if(live)setUsersError(errorCopy(error,"无法获取负责人名单（可能没有组织目录权限）"));})
   .finally(()=>{if(live)setUsersBusy(false);});
  return()=>{live=false;};
 },[activeForm,selected?.fileId]);

 useEffect(()=>{
  if(activeForm!=="create"||fileQuery.trim().length<2){
   setSearchResults([]);setFileSearching(false);return;
  }
  const controller=new AbortController();let live=true;
  const handle=window.setTimeout(()=>{
   setFileSearching(true);
   void collaborationApi.search({q:fileQuery.trim(),sort:"updated_desc",limit:25},controller.signal)
    .then(page=>{if(live)setSearchResults(page.items.filter(f=>f.name.toLowerCase().endsWith(".docx")));})
    .catch(()=>{if(live)setSearchResults([]);})
    .finally(()=>{if(live)setFileSearching(false);});
  },230);
  return()=>{live=false;window.clearTimeout(handle);controller.abort();};
 },[fileQuery,activeForm]);

 function select(item:CDWInboxItem){
  setFormalDraft(false);
  setParams(previous=>{const next=new URLSearchParams(previous);next.set("task",taskKey(item));return next;});
  setActiveForm(null);
 }
 function beginForm(kind:"create"|"delegate"){
  setActiveForm(kind);setTitle("");setRecipient("");setChosenFile(null);setFileQuery("");setSearchResults([]);setAllowOverrideReview(false);
 }
 async function safeWrite<T>(name:string,fn:(key:string)=>Promise<T>,success:string){
  if(processing)return undefined;
  setProcessing(true);
  let key=requestKeys.current.get(name);
  if(!key){key=newIdempotencyKey();requestKeys.current.set(name,key);}
  try{
   const result=await toast.track(()=>fn(key),{loading:"正在提交…",success,error:e=>errorCopy(e,"操作失败")});
   requestKeys.current.delete(name);refresh(v=>v+1);return result;
  }catch(error){
   // A broken connection is ambiguous: only retries of the exact same command
   // may reuse its key; for other errors a new key is safe.
   if(!(error instanceof ApiError&&error.httpStatus===0))requestKeys.current.delete(name);
   return undefined;
  }finally{setProcessing(false);}
 }
 async function fulfillObligation(item:CDWInboxItem,statement:string):Promise<boolean>{
  if(!item.obligationId)return false;
  const operationKey=["fulfill",item.obligationId,item.revision,statement].join(":");
  const result=await safeWrite(operationKey,
   key=>cdwApi.fulfillObligation(item.obligationId!,item.revision,statement,key),"责任履行证据已保存");
  return Boolean(result);
 }
 async function acceptTask(item:CDWInboxItem){
  await safeWrite("accept:"+item.taskId,key=>cdwApi.accept(item.taskId,item.revision,key),"工作已接收");
 }
 async function createRoot(){
  if(!chosenFile||!recipient||!title.trim())return;
  const result=await safeWrite("create:"+chosenFile.id+":"+recipient+":"+title.trim()+":"+allowOverrideReview,
   key=>cdwApi.create({title:title.trim(),fileId:chosenFile.id,assignee:{kind:"user",id:recipient},allowOverrideReview},key),"工作已派发");
  if(result){setActiveForm(null);setParams({task:result.taskId});}
 }
 async function delegate(item:CDWInboxItem){
  if(!recipient||!title.trim())return;
  const selectedRecipient:CDWRecipient={kind:"user",id:recipient};
  const result=await safeWrite("delegate:"+item.taskId+":"+item.revision+":"+recipient+":"+title.trim(),
   key=>cdwApi.delegate(item.taskId,item.revision,{childTitle:title.trim(),assignee:selectedRecipient},key),"下级工作已派发，上级责任保留");
  if(result){setActiveForm(null);setParams({task:result.taskId});}
 }
 async function resumeTask(item:CDWInboxItem){
  const result=await safeWrite("resume:"+item.taskId+":"+item.revision,
   key=>cdwApi.resume(item.taskId,item.revision,key),"新一轮修订分支已建立");
  if(result)navigate("/workbench/branch/"+encodeURIComponent(result.branchId)+"/edit");
 }
 async function createBranch(item:CDWInboxItem){
  const result=await safeWrite("branch:"+item.taskId,
   key=>cdwApi.createBranch(item.taskId,key),"工作分支已创建");
  if(result)navigate("/workbench/branch/"+encodeURIComponent(result.branchId)+"/edit");
 }
 const totalTasks=items.filter(x=>x.kind==="task").length;
 const totalObligations=items.filter(x=>x.kind==="obligation").length;
 const totalReviews=reviewGates.length;
 const totalFormal=formalApprovals.length;
 const totalControl=controlCandidates.length;
 const totalScope=scopeApprovals.length;
 const totalReceipts=receiptTargets.filter(item=>item.state==="awaiting").length;
 const totalReading=readingAssignments.filter(item=>item.state==="assigned"||item.state==="opened").length;
 const appointmentCount=pendingAppointments.filter(a=>a.status==="pending").length+
  appointmentAlerts.filter(a=>!a.readAt).length+specialAlerts.filter(a=>!a.readAt).length+
  specialReviews.filter(a=>a.status==="pending"&&a.proposedBy!==user.id).length+
  specialImpacts.filter(a=>a.state==="open").length+legacyAnomalies.filter(a=>a.requestedBy!==user.id).length+
  formalNotices.filter(a=>!a.readAt).length;
 const counts:Record<View,number>={
  tasks:totalTasks,obligations:totalObligations,reviews:totalReviews,formal:totalFormal,
  appointments:appointmentCount,control:totalControl,scope:totalScope,receipts:totalReceipts,
  reading:totalReading,effective:0,all:allItems.length,
 };
 const selectedView=viewGroups.flatMap(group=>group.views).find(view=>view.key===filter)?.label??"工作事项";
 const actionableVisible=visible.filter(isActionable).length;
 const canWork=selected?.kind==="task"&&(selected.state==="accepted"||selected.state==="in_progress");
 const editingBranch=branches.find(b=>b.state==="open");
 return <AppShell user={user} onLogout={onLogout}>
  <div className="panels cdw-panels">
   <main className="work cdw-work">
    <div className="cdw-layout">
     <aside className="cdw-rail" aria-label="工作视图分类">
      <div className="cdw-rail-overview"><span className="cdw-rail-mark" aria-hidden="true">◫</span><span><strong>工作队列</strong><small>{allItems.filter(isActionable).length+appointmentCount} 项待处理</small></span></div>
      <nav className="cdw-rail-nav" aria-label="工作分类">
       {viewGroups.map(group=><div className="cdw-rail-group" key={group.name}>
        <div className="cdw-rail-caption">{group.name}</div>
        {group.views.map(({key,label,symbol})=>
         <RareButton key={key} type="button" className={"cdw-rail-item"+(filter===key?" is-current":"")}
          aria-current={filter===key?"page":undefined} onClick={()=>{setFilter(key);setActiveForm(null);setFormalDraft(false);}}>
          <span className="cdw-rail-icon" aria-hidden="true">{symbol}</span><span className="cdw-rail-label">{label}</span>
          {key!=="effective"&&<small className={counts[key]>0?"has-count":""}>{counts[key]}</small>}
         </RareButton>)}
       </div>)}
      </nav>
      <Link className="cdw-rail-dhf" to="/workbench/dhf"><span className="cdw-rail-icon" aria-hidden="true">▣</span><span>DHF 九阶段验收</span><span aria-hidden="true">↗</span></Link>
     </aside>
     {filter==="effective"?<CDWEffectiveSearchPanel/>:filter==="appointments"?
      <CDWQMSReviewInbox items={pendingAppointments} alerts={appointmentAlerts} actorId={user.id}
       onRead={id=>void readAppointmentAlert(id)} onVerified={()=>refresh(v=>v+1)}/>:<>
     <section className="cdw-inbox" aria-label="工作事项列表">
      <header className="cdw-inbox-tools">
       <div className="cdw-inbox-heading"><strong>{selectedView}</strong><span>{visible.length}</span></div>
       <div className="cdw-inbox-actions">
        <RareButton type="button" tone="ghost" className="cdw-refresh" aria-label="刷新工作事项" title="刷新工作事项" disabled={busy} onClick={()=>refresh(v=>v+1)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2 6M20 4v7h-7"/></svg></RareButton>
        {user.isAdmin&&(filter==="formal"?<RareButton type="button" tone="primary" onClick={()=>{setFormalDraft(true);setActiveForm(null);}}>发起审批</RareButton>:(filter==="tasks"||filter==="all")?<RareButton type="button" tone="primary" onClick={()=>beginForm("create")}>新建工作</RareButton>:null)}
       </div>
      </header>
      <div className="cdw-search"><div className="cdw-search-field"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><RareInput type="search" aria-label="筛选工作或文件" placeholder="搜索工作或文件…" value={search} onChange={e=>setSearch(e.target.value)}/></div></div>
      <div className="cdw-list-meta"><span>{actionableVisible>0?<><i className="cdw-meta-dot"/> {actionableVisible} 项待处理</>:"当前分类的全部事项"}</span><RareButton type="button" className={"cdw-sort-button"+(priorityFirst?" is-active":"")} aria-pressed={priorityFirst} tone="ghost" onClick={()=>setPriorityFirst(v=>!v)}>待处理优先 <span aria-hidden="true">{priorityFirst?"↓":"↕"}</span></RareButton></div>
      <div className="cdw-inbox-scroll">
       {busy&&items.length===0&&<div className="cdw-message"><BrandLoadingLabel showContext>加载工作事项</BrandLoadingLabel></div>}
       {requestError&&<RareNotice tone="danger">{requestError} <RareButton type="button" onClick={()=>refresh(n=>n+1)}>重试</RareButton></RareNotice>}
       {!busy&&visible.length===0&&<div className="cdw-empty"><span className="cdw-empty-icon" aria-hidden="true">▤</span><strong>{search.trim()?"没有匹配的工作":"当前没有需要展示的事项"}</strong><p>{search.trim()?"可以更换关键词继续查找":filter==="obligations"?"目前没有待履行责任":"新事项到达后会出现在这里"}</p>{search.trim()&&<RareButton type="button" tone="ghost" onClick={()=>setSearch("")}>清除搜索</RareButton>}</div>}
       {visible.map(item=><RareButton type="button" className={"cdw-task-row"+(selected===item&&!activeForm?" is-selected":"")} key={taskKey(item)}
         aria-current={selected===item&&!activeForm?"true":undefined} onClick={()=>select(item)}>
        <span className={"cdw-task-symbol cdw-kind-"+item.kind} aria-hidden="true">{item.kind==="task"?"▤":item.kind==="obligation"?"◇":item.kind==="review"?"✓":item.kind==="formal"?"✎":item.kind==="receipt"?"⌁":"▣"}</span>
        <span className="cdw-task-copy"><span className="cdw-task-kicker">{kindName[item.kind]}{item.kind==="review"&&item.review?.reviewMode==="delegated"?" · 授权代验收":""}</span><strong title={item.title}>{item.title}</strong>
         <span className="cdw-task-bottom"><small>{item.kind==="obligation"?stateLabel(item.obligationKind??"") +" · ":""}{stateLabel(item.state)}</small>{isActionable(item)&&<i className="cdw-task-unread" aria-label="待处理"/>}</span></span>
        <span className="cdw-task-chevron" aria-hidden="true">›</span>
       </RareButton>)}
      </div>
      <footer className="cdw-inbox-footer">共 {visible.length} 项工作 · 选择条目查看详情</footer>
     </section>
     <article className="cdw-detail" aria-label="工作详情">
      {formalDraft?<CDWFormalInitiate actorId={user.id} loadUsers={organizationApi.users} onCreated={()=>{setFormalDraft(false);refresh(n=>n+1);}}/>:activeForm?<section className="cdw-detail-inner">
       <div className="cdw-detail-header"><div><small>工作台</small><h2>{activeForm==="create"?"新建受控文件工作":"派发下级工作"}</h2></div>
        <RareButton tone="ghost" onClick={()=>setActiveForm(null)}>取消</RareButton></div>
       <div className="cdw-form">
        <label>工作名称<RareInput value={title} maxLength={255} placeholder="简要描述具体交付工作" onChange={e=>setTitle(e.target.value)}/></label>
        {activeForm==="create"&&<div className="cdw-file-picker">
         <label>选择受控工作文件（DOCX）<RareInput type="search" value={fileQuery} placeholder="按文件名搜索，至少两个字" onChange={e=>{setFileQuery(e.target.value);setChosenFile(null);}}/></label>
         {chosenFile&&<div className="cdw-picked">已选：{chosenFile.name}</div>}
         <div className="cdw-file-results" aria-label="搜索文件结果">
          {fileSearching&&<span>正在查找…</span>}
          {!fileSearching&&fileQuery.trim().length>=2&&searchResults.length===0&&<span>没有找到可用 DOCX 文件</span>}
          {searchResults.map(file=><RareButton type="button" key={file.id}
           className={"cdw-file-result"+(chosenFile?.id===file.id?" is-picked":"")}
           onClick={()=>setChosenFile(file)}><span>{file.name}</span><small>{file.currentVersionSeq} 版</small></RareButton>)}
         </div>
        </div>}
        <label>工作负责人
         {usersBusy?<span className="cdw-help">读取人员列表…</span>:<RecipientPicker users={users} value={recipient} onChange={setRecipient}/>}
        </label>
        {usersError&&<RareNotice tone="warning">{usersError}</RareNotice>}
        {activeForm==="create"&&<div className="cdw-form-permission">
         <RareButton type="button" aria-pressed={allowOverrideReview} tone={allowOverrideReview?"primary":"neutral"}
          onClick={()=>setAllowOverrideReview(v=>!v)}>
          {allowOverrideReview?"✓ 已允许授权越级验收":"允许授权越级验收"}
         </RareButton>
         <p className="cdw-section-note">默认关闭。开启后，直属审核人可针对具体交付节点授权更上级替代验收；中间管理与整合责任仍保留。</p>
        </div>}
        {activeForm==="delegate"&&<RareNotice tone="info">派发下级工作后，你仍须履行管理、整合和上报责任。</RareNotice>}
        <div className="cdw-form-actions">
         <RareButton type="button" tone="primary" loading={processing} disabled={!title.trim()||!recipient||usersBusy||(activeForm==="create"&&!chosenFile)}
          onClick={()=>void (activeForm==="create"?createRoot():selected&&delegate(selected))}>确认派发</RareButton>
        </div>
       </div>
      </section>:selected?.kind==="control"&&selected.candidate?
      <CDWControlPreparePanel key={selected.candidate.id} candidate={selected.candidate} user={user} loadUsers={organizationApi.users} loadDepartments={organizationApi.departments} onPrepared={()=>refresh(n=>n+1)}/>:
      selected?.kind==="reading"&&selected.reading?
      <CDWReadingPanel key={selected.reading.id} assignment={selected.reading} onConfirmed={()=>refresh(n=>n+1)}/>:
      selected?.kind==="receipt"&&selected.receipt?
      <CDWDepartmentReceiptPanel key={selected.receipt.targetId} target={selected.receipt} onSigned={()=>refresh(n=>n+1)}/>:
      selected?.kind==="scope"&&selected.scope?
      <CDWScopeApprovalPanel key={selected.scope.id} plan={selected.scope}
       loadUsers={organizationApi.users} loadDepartments={organizationApi.departments}
       onApproved={()=>refresh(n=>n+1)}/>:
      selected?.kind==="formal"&&selected.formal?
      <CDWFormalPanel key={selected.formal.id} approval={selected.formal} onDecided={()=>refresh(n=>n+1)}/>:
      selected?.kind==="review"&&selected.review?
      <CDWReviewPanel key={selected.review.gateId} gate={selected.review} onDecided={()=>refresh(n=>n+1)}/>:
      selected?<section className="cdw-detail-inner" key={taskKey(selected)}>
       <div className="cdw-detail-header"><div><small>{selected.kind==="task"?"工作详情":"责任待办"}</small>
        <h2>{selected.title}</h2></div><RareBadge tone={statusTone(selected.state)}>{stateLabel(selected.state)}</RareBadge></div>
       <div className="cdw-detail-facts">
        <div><span>事项</span><strong>{selected.kind==="task"?"工作交付":stateLabel(selected.obligationKind??"manage")}</strong></div>
        <div><span>状态</span><strong>{stateLabel(selected.state)}</strong></div>
        <div><span>关联文件</span><strong title={fileInfo?.name??selected.fileId}>{fileInfo?.name??"文件"}</strong></div>
       </div>
       <div className="cdw-section"><div className="cdw-section-head"><h3>工作文件</h3>
        <Link className="cdw-text-link" to={"/preview/"+encodeURIComponent(selected.fileId)}>打开预览 ↗</Link></div>
        <p className="cdw-section-note">原文件维持独立正式版本；在线编辑产生独立工作修订，不直接覆盖原件。</p>
       </div>
       {selected.kind==="obligation"?<CDWObligationPanel item={selected} busy={processing} onFulfill={statement=>fulfillObligation(selected,statement)}/>:<>
        {selected.state==="assigned"&&<div className="cdw-primary-action">
         <p>你收到一项工作。接收后可以建立独立编辑分支，也可以向下一级派发。</p>
         <RareButton type="button" tone="primary" loading={processing} onClick={()=>void acceptTask(selected)}>接收工作</RareButton>
        </div>}
        {canWork&&<>
         <div className="cdw-section">
          <div className="cdw-section-head"><h3>工作分支</h3>{branchesBusy&&<small>正在更新</small>}</div>
          {detailsError&&<RareNotice tone="warning">{detailsError}</RareNotice>}
          {!branchesBusy&&branches.length===0&&<p className="cdw-section-note">当前工作还没有编辑分支。创建后由 ONLYOFFICE 原生保存，交付时验证最终回执。</p>}
          {branches.map(b=><div className="cdw-branch-row" key={b.branchId}>
           <span className="cdw-branch-text"><strong>工作修订 {b.headRevisionId?"· 已有保存":"· 待编辑"}</strong>
            <small>{stateLabel(b.state)} · 工作版本 {b.revision}</small></span>
           {b.state==="open"&&<RareButton type="button" tone="primary" onClick={()=>navigate("/workbench/branch/"+encodeURIComponent(b.branchId)+"/edit")}>进入编辑</RareButton>}
           {b.state==="frozen"&&<RareBadge tone="success">待验收</RareBadge>}
          </div>)}
          {!editingBranch&&branches.length===0&&<RareButton type="button" tone="primary" loading={processing}
           onClick={()=>void createBranch(selected)}>创建工作分支</RareButton>}
         </div>
         <div className="cdw-section cdw-delegation">
          <h3>逐级派发</h3><p className="cdw-section-note">需要其他人员协助时，建立独立下级工作，上级管理责任仍保留。</p>
          <RareButton type="button" onClick={()=>beginForm("delegate")}>派发下级工作 →</RareButton>
         </div>
        </>}
        {selected.state==="returned"&&<div className="cdw-primary-action">
         <RareNotice tone="warning">上一轮交付已被退回，原冻结稿及验收记录保持只读。继续修订将建立新轮次，并以退回稿作为编辑初稿。</RareNotice>
         <RareButton type="button" tone="primary" loading={processing} onClick={()=>void resumeTask(selected)}>从退回稿继续修订</RareButton>
        </div>}
        {selected.state==="submitted"&&<RareNotice tone="info">交付稿已冻结，正在等待直属上级验收；尚未正式批准或生效。</RareNotice>}
        {selected.state==="accepted_delivery"&&<RareNotice tone="success">本轮工作交付已通过直属上级验收；文件正式审批和受控发行仍需独立处理。</RareNotice>}
       </>}
      </section>:<div className="cdw-detail-empty"><strong>选择一项工作</strong><p>查看工作分支、责任和后续交付。</p></div>}
     </article>
     </>}
    </div>
   </main>
  </div>
 </AppShell>;
}
