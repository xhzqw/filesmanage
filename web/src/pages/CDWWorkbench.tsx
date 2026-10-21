import {useEffect,useMemo,useRef,useState} from "react";
import {Link,useNavigate,useSearchParams} from "react-router-dom";
import type {User} from "../entities/user/model";
import type {FileItem} from "../entities/file/model";
import {AppShell,BrandLogo} from "../shared/ui/AppShell";
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
import {cdwApi,type CDWBranch,type CDWInboxItem,type CDWInitiatedItem,type CDWRecipient,type CDWReviewGate,type CDWFormalApproval,type CDWApprovedCandidate,type CDWDistributionPlan,type CDWReceiptTarget,type CDWReadingAssignment,type CDWQMSPendingReview,type CDWQMSAppointmentAlert,type CDWQMSSpecialAlert,type CDWQMSSpecialAuthority,type CDWQMSSpecialPolicyImpact,type CDWQMSLegacyAnomaly,type CDWQMSFormalNotice} from "../features/cdw/api";
import "./cdwWorkbench.css";
import {CDWWorkbenchHome,workNeedsAction} from "./CDWWorkbenchHome";
import {CDWInitiatedWorkspace} from "./CDWInitiatedWorkspace";
import {SealLibrary} from "../features/seals/SealLibrary";

export function WorkbenchIcon({name,className=""}:{name:string;className?:string}){
 switch(name){
  case "home":
   return <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-4v6H4a1 1 0 0 1-1-1z"/></svg>;
  case "todo":
   return <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m9 12 2 2 4-4"/></svg>;
  case "initiated":
   return <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2 15 22 11 13 2 9z"/></svg>;
  case "all":
   return <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect width="7" height="7" x="3" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="14" rx="1.5"/><rect width="7" height="7" x="3" y="14" rx="1.5"/></svg>;
  case "following":
   return <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg>;
  case "tasks":
   return <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>;
  case "obligations":
   return <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>;
  case "reviews":
   return <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>;
  case "formal":
   return <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m18 2 4 4-10 10H8v-4z"/><path d="m14 6 4 4"/><path d="M4 22h16"/></svg>;
  case "appointments":
   return <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m19 8 2 2 4-4"/></svg>;
  case "scope":
   return <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 9v3a3 3 0 0 0 3 3h6"/></svg>;
  case "control":
   return <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>;
  case "receipts":
   return <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>;
  case "reading":
   return <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>;
  case "effective":
   return <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>;
  case "seals":
   return <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><circle cx="12" cy="12" r="3"/></svg>;
  case "dhf":
   return <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>;
  case "customers":
   return <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>;
  case "projects":
   // 多层「看板列」造型：区别于文件/文件夹图标，暗示这是同一批数据的多视图
   return <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="5" height="16" rx="1.2"/><rect x="10" y="4" width="5" height="10" rx="1.2"/><rect x="17" y="4" width="4" height="13" rx="1.2"/></svg>;
  default:
   return <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/></svg>;
 }
}

type View="home"|"todo"|"initiated"|"following"|"tasks"|"obligations"|"reviews"|"formal"|"appointments"|"control"|"scope"|"receipts"|"reading"|"effective"|"all"|"seals";
const viewGroups:{name:string;views:{key:View;label:string;icon:string}[]}[]=[
 {name:"工作区",views:[{key:"home",label:"工作首页",icon:"home"},{key:"todo",label:"待我处理",icon:"todo"},{key:"initiated",label:"我发起的",icon:"initiated"},{key:"all",label:"全部事项",icon:"all"}]},
 {name:"审批与验收",views:[{key:"formal",label:"正式审批",icon:"formal"},{key:"reviews",label:"交付验收",icon:"reviews"},{key:"scope",label:"范围审批",icon:"scope"},{key:"appointments",label:"任命核验",icon:"appointments"}]},
 {name:"受控与流转",views:[{key:"tasks",label:"文件工作",icon:"tasks"},{key:"obligations",label:"责任待办",icon:"obligations"},{key:"control",label:"发行准备",icon:"control"},{key:"receipts",label:"部门签收",icon:"receipts"},{key:"reading",label:"阅读确认",icon:"reading"},{key:"effective",label:"生效文件",icon:"effective"},{key:"seals",label:"电子签章",icon:"seals"}]},
];
const kindName:Record<CDWInboxItem["kind"],string>={
 task:"工作交付",obligation:"责任履行",review:"交付验收",formal:"正式审批",
 control:"发行准备",scope:"范围审批",receipt:"部门签收",reading:"阅读确认",
};
const isActionable=workNeedsAction;

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
 const[initiatedItems,setInitiatedItems]=useState<CDWInitiatedItem[]>([]);
 const[initiatedCursor,setInitiatedCursor]=useState("");
 const[initiatedBusy,setInitiatedBusy]=useState(false);
 const[initiatedError,setInitiatedError]=useState("");
 const initiatedLoadSeq=useRef(0);
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
 const[filter,setFilter]=useState<View>(()=>params.get("view")==="initiated"?"initiated":params.get("task")?"all":"home");
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
  const matched=allItems.filter(x=>(filter==="all"||filter==="home"||filter==="todo"&&isActionable(x)||filter==="following"&&!isActionable(x)||filter!=="initiated"&&x.kind===(filter==="tasks"?"task":filter==="reviews"?"review":filter==="formal"?"formal":filter==="control"?"control":filter==="scope"?"scope":filter==="receipts"?"receipt":filter==="reading"?"reading":"obligation"))
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
  const controller=new AbortController();
  const sequence=++initiatedLoadSeq.current;
  setInitiatedBusy(true);setInitiatedError("");setInitiatedCursor("");
  cdwApi.initiated("",30,controller.signal).then(page=>{
   if(sequence!==initiatedLoadSeq.current)return;
   setInitiatedItems(page.items??[]);setInitiatedCursor(page.nextCursor??"");
  }).catch(error=>{
   if(sequence===initiatedLoadSeq.current&&!(error instanceof DOMException&&error.name==="AbortError"))
    setInitiatedError(errorCopy(error,"我发起的工作加载失败"));
  }).finally(()=>{if(sequence===initiatedLoadSeq.current)setInitiatedBusy(false)});
  return()=>{controller.abort();};
 },[refreshToken,user.id]);
 async function loadMoreInitiated(){
  if(!initiatedCursor||initiatedBusy)return;
  const sequence=initiatedLoadSeq.current;
  setInitiatedBusy(true);setInitiatedError("");
  try{
   const page=await cdwApi.initiated(initiatedCursor,30);
   if(sequence!==initiatedLoadSeq.current)return;
   setInitiatedItems(old=>[...old,...(page.items??[]).filter(item=>!old.some(existing=>existing.taskId===item.taskId))]);
   setInitiatedCursor(page.nextCursor??"");
  }catch(error){
   if(sequence===initiatedLoadSeq.current)setInitiatedError(errorCopy(error,"读取更早的工作失败"));
  }finally{if(sequence===initiatedLoadSeq.current)setInitiatedBusy(false);}
 }
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
  home:allItems.filter(isActionable).length+appointmentCount,todo:allItems.filter(isActionable).length+appointmentCount,initiated:initiatedItems.length,following:allItems.filter(x=>!isActionable(x)).length,
  tasks:totalTasks,obligations:totalObligations,reviews:totalReviews,formal:totalFormal,
  appointments:appointmentCount,control:totalControl,scope:totalScope,receipts:totalReceipts,
  reading:totalReading,effective:0,all:allItems.length,seals:0,
 };
 const selectedView=viewGroups.flatMap(group=>group.views).find(view=>view.key===filter)?.label??"工作事项";
 const actionableVisible=visible.filter(isActionable).length;
 const canWork=selected?.kind==="task"&&(selected.state==="accepted"||selected.state==="in_progress");
 const editingBranch=branches.find(b=>b.state==="open");
 return <AppShell user={user} onLogout={onLogout} finderSidebarWidth={240}>
  <div className="panels document-explorer cdw-panels">
   <aside className="sidebar finder-sidebar cdw-rail" aria-label="工作视图分类" style={{width:"240px"}}>
    <Link to="/doc" className="finder-sidebar-home" aria-label="中晟生物 · 返回文档首页">
     <BrandLogo size={27} className="finder-sidebar-logo" transparent/><span>中晟生物</span>
    </Link>
    <div className="sidebar-scroll">
     <nav className="cdw-rail-nav" aria-label="工作分类">
      {viewGroups.map(group=><div className="cdw-rail-group" key={group.name}>
       <div className="cdw-rail-caption">{group.name}</div>
       {group.views.map(({key,label,icon})=>
        <RareButton key={key} type="button" className={"cdw-rail-item"+(filter===key?" is-current":"")}
         aria-current={filter===key?"page":undefined} onClick={()=>{setFilter(key);setActiveForm(null);setFormalDraft(false);}}>
         <span className="cdw-rail-icon" aria-hidden="true"><WorkbenchIcon name={icon}/></span><span className="cdw-rail-label">{label}</span>
         {counts[key]>0&&<small className="has-count">{counts[key]}</small>}
        </RareButton>)}
      </div>)}
     </nav>
     <Link className="cdw-rail-dhf" to="/workbench/dhf"><span className="cdw-rail-icon" aria-hidden="true"><WorkbenchIcon name="dhf"/></span><span>DHF 九阶段验收</span><span aria-hidden="true">↗</span></Link>
     <Link className="cdw-rail-dhf" to="/workbench/customer-registrations"><span className="cdw-rail-icon" aria-hidden="true"><WorkbenchIcon name="customers"/></span><span>客户登记审批</span><span aria-hidden="true">↗</span></Link>
     <Link className="cdw-rail-dhf" to="/workbench/projects"><span className="cdw-rail-icon" aria-hidden="true"><WorkbenchIcon name="projects"/></span><span>项目</span><span aria-hidden="true">↗</span></Link>
    </div>
    <div className="sidebar-resizer" role="separator" aria-orientation="vertical" tabIndex={-1}/>
   </aside>
   <main className="work cdw-work">
    <div className="cdw-layout">
     {filter==="home"?<CDWWorkbenchHome initiatedCount={initiatedItems.length} initiatedHasMore={Boolean(initiatedCursor)} initiatedError={initiatedError} initiatedBusy={initiatedBusy} items={allItems} appointmentCount={appointmentCount} busy={busy} error={requestError}
      canCreate={user.isAdmin} onRefresh={()=>refresh(v=>v+1)} onCreate={()=>{setFilter("tasks");beginForm("create");}}
      onOpen={item=>{setFilter("all");select(item);}} onView={view=>{setFilter(view);setActiveForm(null);setFormalDraft(false);}}/>:filter==="initiated"?
      <CDWInitiatedWorkspace items={initiatedItems} busy={initiatedBusy} error={initiatedError} nextCursor={initiatedCursor}
       onMore={()=>void loadMoreInitiated()} onRefresh={()=>refresh(v=>v+1)}/>:filter==="effective"?<CDWEffectiveSearchPanel/>:filter==="appointments"?
      <CDWQMSReviewInbox items={pendingAppointments} alerts={appointmentAlerts} actorId={user.id}
       onRead={id=>void readAppointmentAlert(id)} onVerified={()=>refresh(v=>v+1)}/>:filter==="seals"?<div className="cdw-seals-view"><SealLibrary isAdmin={user.isAdmin}/></div>:<>
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
       {filter==="todo"&&appointmentCount>0&&<RareButton type="button" className="cdw-appointment-shortcut" onClick={()=>setFilter("appointments")}>
        <strong>专项核验及通知</strong><small>{appointmentCount} 项需关注或处理</small><span aria-hidden="true">→</span>
       </RareButton>}
       {busy&&items.length===0&&<div className="cdw-message"><BrandLoadingLabel showContext>加载工作事项</BrandLoadingLabel></div>}
       {requestError&&<RareNotice tone="danger">{requestError} <RareButton type="button" onClick={()=>refresh(n=>n+1)}>重试</RareButton></RareNotice>}
       {!busy&&visible.length===0&&(filter!=="todo"||appointmentCount===0)&&<div className="cdw-empty"><span className="cdw-empty-icon" aria-hidden="true">▤</span><strong>{search.trim()?"没有匹配的工作":"当前没有需要展示的事项"}</strong><p>{search.trim()?"可以更换关键词继续查找":filter==="obligations"?"目前没有待履行责任":"新事项到达后会出现在这里"}</p>{search.trim()&&<RareButton type="button" tone="ghost" onClick={()=>setSearch("")}>清除搜索</RareButton>}</div>}
       {visible.map(item=><RareButton type="button" className={"cdw-task-row"+(selected===item&&!activeForm?" is-selected":"")} key={taskKey(item)}
         aria-current={selected===item&&!activeForm?"true":undefined} onClick={()=>select(item)}>
        <span className={"cdw-task-symbol cdw-kind-"+item.kind} aria-hidden="true"><WorkbenchIcon name={item.kind==="task"?"tasks":item.kind==="obligation"?"obligations":item.kind==="review"?"reviews":item.kind==="formal"?"formal":item.kind==="receipt"?"receipts":item.kind==="scope"?"scope":item.kind==="reading"?"reading":"control"}/></span>
        <span className="cdw-task-copy"><span className="cdw-task-kicker">{kindName[item.kind]}{item.kind==="review"&&item.review?.reviewMode==="delegated"?" · 授权代验收":""}</span><strong title={item.title}>{item.title}</strong>
         <span className="cdw-task-bottom"><small>{item.kind==="obligation"?stateLabel(item.obligationKind??"") +" · ":""}{stateLabel(item.state)}</small>{isActionable(item)&&<i className="cdw-task-unread" aria-label="待处理"/>}</span></span>
        <span className="cdw-task-chevron" aria-hidden="true">›</span>
       </RareButton>)}
      </div>
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
        </div>}
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
       </div>
       {selected.kind==="obligation"?<CDWObligationPanel item={selected} busy={processing} onFulfill={statement=>fulfillObligation(selected,statement)}/>:<>
        {selected.state==="assigned"&&<div className="cdw-primary-action">
         <RareButton type="button" tone="primary" loading={processing} onClick={()=>void acceptTask(selected)}>接收工作</RareButton>
        </div>}
        {canWork&&<>
         <div className="cdw-section">
          <div className="cdw-section-head"><h3>工作分支</h3>{branchesBusy&&<small>正在更新</small>}</div>
          {detailsError&&<RareNotice tone="warning">{detailsError}</RareNotice>}
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
          <h3>逐级派发</h3>
          <RareButton type="button" onClick={()=>beginForm("delegate")}>派发下级工作 →</RareButton>
         </div>
        </>}
        {selected.state==="returned"&&<div className="cdw-primary-action">
         <RareNotice tone="warning">上一轮交付已退回，继续修订将以退回稿作为新轮次编辑初稿。</RareNotice>
         <RareButton type="button" tone="primary" loading={processing} onClick={()=>void resumeTask(selected)}>从退回稿继续修订</RareButton>
        </div>}
        {selected.state==="submitted"&&<RareNotice tone="info">交付稿已冻结，等待上级验收。</RareNotice>}
        {selected.state==="accepted_delivery"&&<RareNotice tone="success">本轮工作交付已通过验收。</RareNotice>}
       </>}
      </section>:<div className="cdw-detail-empty"><span className="cdw-detail-empty-icon" aria-hidden="true"><WorkbenchIcon name="tasks"/></span><strong>未选择事项</strong></div>}
     </article>
     </>}
    </div>
   </main>
  </div>
 </AppShell>;
}
