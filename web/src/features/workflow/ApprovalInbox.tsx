import {useEffect,useMemo,useState} from "react";
import {useLocation} from "react-router-dom";
import {RareBadge,RareButton,RareInput,RareSelect,RareTextarea} from "../../shared/ui/rare";
import {toast} from "../../shared/ui/feedback";
import {Dialog} from "../../shared/ui/Dialog";
import {FileResourceIcon} from "../../shared/ui/ResourceIcons";
import {workflowApi,type Approval} from "./api";
import {approvalActivityApi,type ApprovalEvent,type ApprovalNotification} from "./activityApi";
import {ApprovalDetail} from "./ApprovalDetail";
import {errorCode,errorCopy} from "../../shared/errors";
import type {User} from "../../entities/user/model";
import "./approvalActivity.css";

export type ApprovalView="inbox"|"mine"|"notifications";
const stateLabels:Record<string,string>={pending:"待审批",approved:"已通过",rejected:"已拒绝",cancelled:"已撤回",conflicted:"已失效"};
const stateTones={pending:"warning",approved:"success",rejected:"danger",cancelled:"neutral",conflicted:"danger"} as const;
const actionLabels:Record<string,string>={edit:"内容修改",rollback:"版本回滚"};
const eventLabels:Record<string,string>={submitted:"提交申请",advanced:"本级通过",approved:"最终通过",rejected:"拒绝",cancelled:"撤回",conflicted:"版本冲突"};
const timeLabel=(value:string)=>value?new Date(value).toLocaleString("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}):"—";
type Decision={approval:Approval;action:"approve"|"reject"|"cancel"};

export function ApprovalInbox({currentUser,view,onReview,onCounts}:{currentUser:User;view:ApprovalView;onReview:(approval:Approval)=>void;onCounts:(value:{pending:number;unread:number})=>void}){
 const[inbox,setInbox]=useState<Approval[]>([]);
 const[mine,setMine]=useState<Approval[]>([]);
 const[loading,setLoading]=useState(true);
 const[loadError,setLoadError]=useState("");
 const[refreshKey,setRefreshKey]=useState(0);
 const[notifications,setNotifications]=useState<ApprovalNotification[]>([]);
 const[noticeError,setNoticeError]=useState("");
 const[selected,setSelected]=useState("");
 const[record,setRecord]=useState<{id:string;approval:Approval}|null>(null);
 const[recordError,setRecordError]=useState("");
 const[mobileDetail,setMobileDetail]=useState(false);
 const[query,setQuery]=useState("");
 const[statusFilter,setStatusFilter]=useState("all");
 const[typeFilter,setTypeFilter]=useState("all");
 const[decision,setDecision]=useState<Decision|null>(null);
 const[comment,setComment]=useState("");
 const[decisionError,setDecisionError]=useState("");
 const[busyId,setBusyId]=useState("");
 const[events,setEvents]=useState<ApprovalEvent[]>([]);
 const[historyLoading,setHistoryLoading]=useState(false);
 const[historyError,setHistoryError]=useState("");
 const location=useLocation();
 const linkedId=new URLSearchParams(location.search).get("item");
 const deepLink=linkedId&&linkedId.length<=128?linkedId:"";

 useEffect(()=>{
  let active=true;
  setLoading(true);setLoadError("");
  Promise.all([workflowApi.approvals("inbox"),workflowApi.approvals("mine")])
   .then(([todo,own])=>{if(active){setInbox(todo);setMine(own);}})
   .catch(error=>{if(active)setLoadError(errorCopy(error,"审批列表加载失败"));})
   .finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};
 },[refreshKey]);
 useEffect(()=>{
  let active=true;
  const update=()=>approvalActivityApi.notifications().then(items=>{if(active){setNotifications(items);setNoticeError("");}})
   .catch(()=>{if(active)setNoticeError("通知读取失败");});
  void update();
  const timer=window.setInterval(()=>void update(),20000);
  const changed=()=>{void update();setRefreshKey(i=>i+1);};
  window.addEventListener("filesmanage:approvals-changed",changed);
  window.addEventListener("filesmanage:approval-notifications-read",update);
  return()=>{active=false;window.clearInterval(timer);window.removeEventListener("filesmanage:approvals-changed",changed);window.removeEventListener("filesmanage:approval-notifications-read",update);};
 },[]);
 const unread=notifications.filter(note=>!note.read).length;
 useEffect(()=>onCounts({pending:inbox.length,unread}),[inbox.length,unread,onCounts]);

 const list=useMemo(()=>{
  const source=view==="mine"?mine:inbox;
  const term=query.trim().toLocaleLowerCase();
  return source.filter(a=>(view!=="mine"||statusFilter==="all"||a.state===statusFilter)&&
   (typeFilter==="all"||a.action===typeFilter)&&
   (!term||[a.fileName,a.requesterName,a.approverName,a.reason,actionLabels[a.action]||""]
    .some(text=>text.toLocaleLowerCase().includes(term))))
   .sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
 },[view,inbox,mine,query,statusFilter,typeFilter]);
 const matchingNotes=useMemo(()=>notifications.filter(note=>
  !query.trim()||[note.fileName,eventLabels[note.kind]||note.kind].some(text=>text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
 ),[notifications,query]);
 const allApprovals=useMemo(()=>[...inbox,...mine.filter(a=>!inbox.some(b=>b.id===a.id))],[inbox,mine]);
 const currentItems=view==="notifications"?matchingNotes.map(n=>n.approvalId):list.map(a=>a.id);
 useEffect(()=>{if(deepLink)setSelected(deepLink);},[deepLink]);
 useEffect(()=>{
  // Keep notification deep links even when a completed request left the inbox.
  setSelected(previous=>currentItems.includes(previous)||previous===deepLink?previous:currentItems[0]||"");
 },[view,query,statusFilter,typeFilter,inbox,mine,notifications,deepLink]);
 useEffect(()=>setMobileDetail(false),[view]);
 useEffect(()=>{
  if(!selected||allApprovals.some(a=>a.id===selected)){setRecord(null);setRecordError("");return;}
  let active=true;setRecord(null);setRecordError("");
  workflowApi.detail(selected).then(approval=>{if(active)setRecord({id:selected,approval});})
   .catch(error=>{if(active)setRecordError(errorCopy(error,"无法读取这条审批"));});
  return()=>{active=false;};
 },[selected,allApprovals,refreshKey]);
 const selectedApproval=allApprovals.find(a=>a.id===selected)??(record?.id===selected?record.approval:null);
 useEffect(()=>{
  if(!selected){setEvents([]);setHistoryLoading(false);setHistoryError("");return;}
  let active=true;setEvents([]);setHistoryError("");setHistoryLoading(true);
  approvalActivityApi.history(selected).then(rows=>{if(active)setEvents(rows);})
   .catch(()=>{if(active)setHistoryError("审批记录读取失败");})
   .finally(()=>{if(active)setHistoryLoading(false);});
  return()=>{active=false;};
 },[selected,refreshKey]);
 async function openNote(note:ApprovalNotification){
  setSelected(note.approvalId);setMobileDetail(true);
  if(note.read)return;
  try{
   await approvalActivityApi.read(note.id);
   setNotifications(items=>items.map(item=>item.id===note.id?{...item,read:true}:item));
   window.dispatchEvent(new Event("filesmanage:approval-notifications-read"));
  }catch{setNoticeError("标记已读失败");}
 }
 function openDecision(approval:Approval,action:Decision["action"]){
  setDecision({approval,action});setComment("");setDecisionError("");
 }
 async function submitDecision(){
  if(!decision||busyId)return;
  const{approval,action}=decision;
  if(action==="reject"&&!comment.trim()){setDecisionError("请填写拒绝原因");return;}
  setBusyId(approval.id);
  try{
   if(action==="approve"){
    const result=await workflowApi.approve(approval.id,comment.trim());
    toast.success(result.status==="committed"?"已通过，文件已生成新版本":"本级已通过，等待下一级审批");
   }else if(action==="reject"){
    await workflowApi.reject(approval.id,comment.trim());toast.success("已拒绝，文件版本未改变");
   }else{
    await workflowApi.cancel(approval.id);toast.success("申请已撤回");
   }
   setDecision(null);setComment("");setRefreshKey(value=>value+1);
  }catch(error){
   const code=errorCode(error);
   if(code==="E_VERSION_CONFLICT"||code==="E_APPROVAL_PENDING"||code==="E_NETWORK"){
    setDecision(null);setRefreshKey(value=>value+1);
    toast.warning(code==="E_NETWORK"?"操作结果未确认，请核对刷新后的记录":"审批状态已变化，列表已刷新");
   }else setDecisionError(errorCopy(error,"操作失败"));
  }finally{setBusyId("");}
 }
 const isInboxItem=!!selectedApproval&&inbox.some(a=>a.id===selectedApproval.id);
 const isMineItem=!!selectedApproval&&mine.some(a=>a.id===selectedApproval.id);
 const canReview=!!selectedApproval&&selectedApproval.state==="pending"&&isInboxItem&&selectedApproval.approverId===currentUser.id;
 const canCancel=!!selectedApproval&&selectedApproval.state==="pending"&&isMineItem&&selectedApproval.requesterId===currentUser.id;
 const title=view==="inbox"?"待我审批":view==="mine"?"我发起的":"通知";
 const count=view==="notifications"?matchingNotes.length:list.length;
 const hasFilters=query.trim()||typeFilter!=="all"||(view==="mine"&&statusFilter!=="all");
 return <div className="approval-page">
  <div className="approval-toolbar">
   <div className="approval-heading"><strong>{title}</strong><span>{count}</span></div>
   <div className="approval-filters">
    <RareInput aria-label="搜索审批" type="search" placeholder={view==="notifications"?"搜索通知":"搜索文件或人员"} value={query} onChange={e=>setQuery(e.target.value)}/>
    {view!=="notifications"&&<RareSelect aria-label="申请类型" value={typeFilter} onChange={e=>setTypeFilter(e.target.value)}>
     <option value="all">全部类型</option><option value="edit">内容修改</option><option value="rollback">版本回滚</option>
    </RareSelect>}
    {view==="mine"&&<RareSelect aria-label="审批状态" value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}>
     <option value="all">全部状态</option>{Object.entries(stateLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}
    </RareSelect>}
    <RareButton type="button" className="approval-refresh" title="刷新审批列表" aria-label="刷新审批列表" onClick={()=>setRefreshKey(n=>n+1)} disabled={!!busyId}>刷新</RareButton>
   </div>
  </div>
  <div className={"approval-workbench"+(mobileDetail?" side-open":"")}>
   <section className="approval-main" aria-label={title}>
    {loadError&&<div role="alert" className="approval-error-bar">{loadError}<RareButton onClick={()=>setRefreshKey(n=>n+1)}>重试</RareButton></div>}
    {view==="notifications"&&noticeError&&<div role="alert" className="approval-error-bar">{noticeError}</div>}
    {loading?<div className="approval-list-empty" role="status">正在读取审批…</div>:
     view==="notifications"?<>
      {matchingNotes.length===0&&<div className="approval-list-empty">{query?"没有匹配的通知":"暂无通知"}</div>}
      {matchingNotes.map(note=><RareButton type="button" key={note.id}
       className={"approval-list-row approval-notification-row"+(selected===note.approvalId?" is-selected":"")+(note.read?"":" is-unread")}
       aria-pressed={selected===note.approvalId} onClick={()=>void openNote(note)}>
       <span className="approval-file-mark"><FileResourceIcon size={21}/></span>
       <span className="approval-row-core"><strong>{note.fileName||"文件"}</strong><small>{eventLabels[note.kind]||note.kind}</small></span>
       <span className="approval-row-end">{!note.read&&<i className="approval-unread-dot" aria-label="未读"/>}<small>{timeLabel(note.createdAt)}</small></span>
      </RareButton>)}
     </>:<>
      {list.length===0&&<div className="approval-list-empty">{hasFilters?"没有匹配的审批":view==="inbox"?"当前没有待处理的申请":"还没有发起过审批"}</div>}
      {list.map(approval=><RareButton type="button" key={approval.id}
       className={"approval-list-row"+(selected===approval.id?" is-selected":"")}
       aria-pressed={selected===approval.id} onClick={()=>{setSelected(approval.id);setMobileDetail(true);}}>
       <span className="approval-file-mark"><FileResourceIcon size={21}/></span>
       <span className="approval-row-core"><strong title={approval.fileName}>{approval.fileName}</strong><small>{view==="mine"?"审批人："+approval.approverName:"申请人："+approval.requesterName} · {actionLabels[approval.action]}{approval.rollbackTargetSeq?" · 目标 v"+approval.rollbackTargetSeq:""}</small></span>
       <span className="approval-row-end">{view==="mine"?<RareBadge tone={stateTones[approval.state]} dot>{stateLabels[approval.state]}</RareBadge>:<small>第 {approval.stepIndex+1}/{approval.stepTotal} 级</small>}<small>{timeLabel(approval.createdAt)}</small></span>
      </RareButton>)}
     </>}
   </section>
   <aside className="approval-side" aria-label="审批详情">
    <div className="approval-side-header"><strong>申请详情</strong>
     <RareButton type="button" className="approval-side-close" onClick={()=>setMobileDetail(false)} aria-label="关闭审批详情">关闭</RareButton>
    </div>
    <div className="approval-side-scroll">
     {recordError&&<div className="approval-error-bar" role="alert">{recordError}</div>}
     <ApprovalDetail approval={selectedApproval} events={events} historyLoading={historyLoading}
      historyError={historyError} onDecision={openDecision} onReview={onReview} busy={!!busyId}
      canCancel={canCancel} canReview={canReview}/>
    </div>
   </aside>
  </div>
  {decision&&<Dialog open title={decision.action==="approve"?"通过审批":decision.action==="reject"?"拒绝审批":"撤回申请"}
   className="approval-decision-dialog" closeGuard={()=>!busyId}
   onClose={()=>{if(!busyId)setDecision(null);}} initialFocus={decision.action==="cancel"?undefined:"#approval-decision-comment"}>
   <p className="approval-decision-file" title={decision.approval.fileName}>{decision.approval.fileName}</p>
   {decision.action!=="cancel"&&<label className="approval-decision-label" htmlFor="approval-decision-comment">
    {decision.action==="reject"?"拒绝原因":"审批意见（选填）"}
    <RareTextarea id="approval-decision-comment" value={comment} disabled={!!busyId} rows={3}
     placeholder={decision.action==="reject"?"填写拒绝原因":"填写审批意见"} onChange={e=>{setComment(e.target.value);setDecisionError("");}}/>
   </label>}
   {decisionError&&<p role="alert" className="approval-error">{decisionError}</p>}
   <div className="dialog-actions">
    <RareButton type="button" disabled={!!busyId} onClick={()=>setDecision(null)}>取消</RareButton>
    <RareButton type="button" tone={decision.action==="reject"?"danger":decision.action==="approve"?"primary":"neutral"}
     disabled={!!busyId||(decision.action==="reject"&&!comment.trim())} loading={!!busyId} onClick={()=>void submitDecision()}>
     {busyId?"处理中…":decision.action==="approve"?"确认通过":decision.action==="reject"?"确认拒绝":"确认撤回"}</RareButton>
   </div>
  </Dialog>}
 </div>;
}