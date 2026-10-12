import {GooeyNav,RareBadge,RareButton,RareDataTable,RareInput,RareRowActions,RareSelect,RareTabs,RareTextarea} from "../../shared/ui/rare";
import {toast} from "../../shared/ui/feedback";
import {Dialog} from "../../shared/ui/Dialog";
import {useEffect,useState,type KeyboardEvent,type MouseEvent} from "react";
import {useLocation} from "react-router-dom";
import {workflowApi} from "./api";
import type {Approval} from "./api";
import {errorCode,errorCopy} from "../../shared/errors";
import type {User} from "../../entities/user/model";
import {approvalActivityApi,type ApprovalEvent,type ApprovalNotification} from "./activityApi";
import {ApprovalDetail} from "./ApprovalDetail";
import "./approvalActivity.css";

const STATE_LABELS:Record<string,string>={
 pending:"待审批",
 approved:"已通过",
 rejected:"已拒绝",
 cancelled:"已撤回",
 conflicted:"冲突失效",
};

const ACTION_LABELS:Record<string,string>={
 edit:"内容修改",
 rollback:"版本回滚",
};
const STATE_TONES={
 pending:"warning",approved:"success",rejected:"danger",
 cancelled:"neutral",conflicted:"danger",
} as const;

export function ApprovalInbox({currentUser,onReview}:{currentUser:User;onReview:(approval:Approval)=>void}){
 const[inbox,setInbox]=useState<Approval[]>([]);
 const[mine,setMine]=useState<Approval[]>([]);
 const[status,setStatus]=useState("loading");
 const[decision,setDecision]=useState<{approval:Approval;action:"approve"|"reject"|"cancel"}|null>(null);
 const[comment,setComment]=useState("");
 const[decisionError,setDecisionError]=useState("");
 const[busyId,setBusyId]=useState("");
 const[reloadToken,setReloadToken]=useState(0);
 const[activeList,setActiveList]=useState<"inbox"|"mine">("inbox");
 const[search,setSearch]=useState("");
 const[stateFilter,setStateFilter]=useState("all");
 const[typeFilter,setTypeFilter]=useState("all");
 const[sortOrder,setSortOrder]=useState<"newest"|"oldest">("newest");
 const[sideOpen,setSideOpen]=useState(false);
 const[sideMode,setSideMode]=useState<"detail"|"notifications">("detail");
 const[selected,setSelected]=useState("");
 const location=useLocation();
 useEffect(()=>{const id=new URLSearchParams(location.search).get("item");const target=id&&id.length<=128?id:"";if(target){setSelected(target);setSideMode("detail");setSideOpen(true);}},[location.search]);
 const[events,setEvents]=useState<ApprovalEvent[]>([]);
 const[historyLoading,setHistoryLoading]=useState(false);
 const[historyError,setHistoryError]=useState("");
 const[notifications,setNotifications]=useState<ApprovalNotification[]>([]);
 const[noticeError,setNoticeError]=useState("");
 const[showAllNotes,setShowAllNotes]=useState(false);
 useEffect(()=>{
  let active=true;
  const refresh=()=>approvalActivityApi.notifications().then(items=>{if(active){setNotifications(items);setNoticeError("");}}).catch(()=>{if(active)setNoticeError("通知读取失败");});
  void refresh();
  const timer=window.setInterval(()=>void refresh(),20000);
  const onLive=()=>{void refresh();setReloadToken(n=>n+1);};
  window.addEventListener("filesmanage:approvals-changed",onLive);
  window.addEventListener("filesmanage:approval-notifications-read",refresh);
  return()=>{active=false;window.clearInterval(timer);window.removeEventListener("filesmanage:approvals-changed",onLive);window.removeEventListener("filesmanage:approval-notifications-read",refresh);};
 },[]);
 useEffect(()=>{
  if(!selected){setEvents([]);setHistoryLoading(false);return;}
  let active=true;
  setEvents([]);setHistoryError("");setHistoryLoading(true);
  approvalActivityApi.history(selected).then(items=>{if(active)setEvents(items);}).catch(()=>{if(active)setHistoryError("无法读取审批记录");})
   .finally(()=>{if(active)setHistoryLoading(false);});
  return()=>{active=false;};
 },[selected,reloadToken]);
 async function readNote(note:ApprovalNotification){
  setSelected(note.approvalId);setSideMode("detail");setSideOpen(true);
  if(!note.read){
   try{await approvalActivityApi.read(note.id);setNotifications(items=>items.map(item=>item.id===note.id?{...item,read:true}:item));window.dispatchEvent(new Event("filesmanage:approval-notifications-read"));}
   catch{setNoticeError("标记已读失败，请重试");}
  }
 }
 const unread=notifications.filter(n=>!n.read).length;
 const eventLabels:Record<string,string>={submitted:"提交申请",advanced:"本级通过",approved:"最终通过",rejected:"拒绝",cancelled:"撤回",conflicted:"版本冲突"};

 useEffect(()=>{
  let valid=true;
  setStatus("loading");
  Promise.all([workflowApi.approvals("inbox"),workflowApi.approvals("mine")])
   .then(([pending,requested])=>{
    if(!valid)return;
    setInbox(pending);setMine(requested);setStatus("ready");
     setSelected(previous=>previous||pending[0]?.id||requested[0]?.id||"");
   })
   .catch(()=>{if(valid)setStatus("failed");});
  return()=>{valid=false;};
 },[reloadToken]);

 // Per-decision comment (WF-31): the comment ships with the decision, one
 // in-flight decision blocks every row so a second click cannot double-submit,
 // a 409 state change reloads the list instead of trusting a stale outcome,
 // and a non-committed result never reads as 已通过/已拒绝.
 async function act(id:string,action:"approve"|"reject"|"cancel"){
  if(busyId!=="")return;
  if(action==="reject"&&!comment.trim()){setDecisionError("拒绝审批需要填写原因");return;}
  setBusyId(id);
  try{
   if(action==="approve"){
    const result=await workflowApi.approve(id,comment);
    const detail=result.status==="committed"?"已通过并生成新版本":"本级审批已通过，已转交下一级；当前版本不变";
    toast.success(detail);
   }else if(action==="reject"){
    await workflowApi.reject(id,comment);
    toast.success("审批已拒绝，文件版本未改变");
   }else{
    await workflowApi.cancel(id);
    toast.success("审批申请已撤回");
   }
   setDecision(null);setComment("");
   setReloadToken(token=>token+1);
  }catch(error){
   const code=errorCode(error);
   if(code==="E_VERSION_CONFLICT"||code==="E_APPROVAL_PENDING"){
    setDecision(null);toast.warning("审批状态已变化，正在刷新列表");
    setReloadToken(token=>token+1);
   }else if(code==="E_NETWORK"){
    // Lost response is not a rejection; do not leave the confirmation button
    // active for an accidental duplicate approval or withdrawal.
    setDecision(null);
    toast.warning("网络中断，审批结果未确认；请核对刷新后的列表");
    setReloadToken(token=>token+1);
   }else{
    // The modal's actionable alert is authoritative. A second global alert
    // would read out the same error twice.
    const detail=errorCopy(error,"操作失败");setDecisionError(detail);
   }
  }finally{
   setBusyId("");
  }
 }


 function openDecision(approval:Approval,action:"approve"|"reject"|"cancel"){
  setComment("");setDecisionError("");setDecision({approval,action});
 }
 function showHistory(id:string){setSelected(id);setSideMode("detail");setSideOpen(true);}
 function switchList(tab:"inbox"|"mine"){
  setActiveList(tab);setSelected((tab==="inbox"?inbox:mine)[0]?.id||"");setSideMode("detail");
 }
 const matches=(a:Approval)=>{
  const text=search.trim().toLocaleLowerCase();
  return (typeFilter==="all"||a.action===typeFilter)&&
   (!text||[a.fileName,a.requesterName,a.approverName,a.reason,a.decisionComment,ACTION_LABELS[a.action]??""]
    .some(v=>(v??"").toLocaleLowerCase().includes(text)));
 };
 const compareTime=(a:Approval,b:Approval)=>sortOrder==="newest"?b.createdAt.localeCompare(a.createdAt):a.createdAt.localeCompare(b.createdAt);
 const visibleInbox=inbox.filter(matches).sort(compareTime);
 const visibleMine=mine.filter(a=>matches(a)&&(stateFilter==="all"||a.state===stateFilter)).sort(compareTime);
 const activeApprovals=activeList==="inbox"?visibleInbox:visibleMine;
 const selectedApproval=activeApprovals.find(a=>a.id===selected)??activeApprovals[0]??null;
 // Filtering can remove the current row from the visible result. The side
 // inspector must follow the visible selection instead of showing stale
 // history or an empty panel while matching approvals remain in the list.
 useEffect(()=>{
  if(selectedApproval&&selectedApproval.id!==selected)setSelected(selectedApproval.id);
 },[selectedApproval?.id,selected]);
 function onRowShortcut(event:KeyboardEvent<HTMLTableRowElement>,approval:Approval){
  if(event.target!==event.currentTarget)return;
  if(event.key==="Enter"||event.key===" "){event.preventDefault();showHistory(approval.id);}
 }
 function onRowSelect(event:MouseEvent<HTMLTableRowElement>,approval:Approval){
  if((event.target as HTMLElement).closest("a,button,input,select,textarea"))return;
  showHistory(approval.id);
 }
 const decisionTitle=decision?.action==="approve"?"通过审批":decision?.action==="reject"?"拒绝审批":"撤回申请";
 const formatTime=(v:string)=>v.replace("T"," ").slice(0,16);

 if(status!=="ready")return <div className="approval-load" role="status">
  {status==="loading"?"正在加载审批…":<>获取审批列表失败 <RareButton type="button" onClick={()=>setReloadToken(n=>n+1)}>重试</RareButton></>}
 </div>;

 return <div className="work-body approval-page">
  <div className="approval-toolbar">
   <RareTabs className="approval-tabs" label="审批分类">
    {(["inbox","mine"] as const).map(tab=><RareButton type="button" key={tab} id={"approval-tab-"+tab}
     role="tab" aria-selected={activeList===tab} tabIndex={activeList===tab?0:-1}
     aria-controls={activeList===tab?"approval-panel-"+tab:undefined}
     onClick={()=>switchList(tab)}>{tab==="inbox"?"待我审批":"我发起的"}
     <span className="approval-tab-count">{tab==="inbox"?inbox.length:mine.length}</span></RareButton>)}
   </RareTabs>
   <div className="approval-filters">
    <RareInput aria-label="搜索审批" type="search" placeholder="搜索文件或人员" value={search} onChange={e=>setSearch(e.target.value)}/>
     <RareSelect aria-label="申请类型" value={typeFilter} onChange={e=>setTypeFilter(e.target.value)}>
      <option value="all">全部类型</option><option value="edit">内容修改</option><option value="rollback">版本回滚</option>
     </RareSelect>
    {activeList==="mine"&&<RareSelect aria-label="审批状态" value={stateFilter} onChange={e=>setStateFilter(e.target.value)}>
     <option value="all">全部状态</option>
     {Object.entries(STATE_LABELS).map(([key,label])=><option key={key} value={key}>{label}</option>)}
    </RareSelect>}
    <RareSelect aria-label="排序方式" value={sortOrder} onChange={e=>setSortOrder(e.target.value as "newest"|"oldest")}>
      <option value="newest">最新优先</option><option value="oldest">最早优先</option>
     </RareSelect>
     <RareButton type="button" disabled={!!busyId} onClick={()=>setReloadToken(n=>n+1)}>刷新</RareButton>
    <RareButton type="button" className="approval-mobile-notes" onClick={()=>{setSideOpen(v=>!v);setSideMode("detail");}}>
     详情
    </RareButton>
   </div>
  </div>
  <div className={"approval-workbench"+(sideOpen?" side-open":"")}>
   <div className="approval-main" id={"approval-panel-"+activeList} role="tabpanel" aria-labelledby={"approval-tab-"+activeList}>
    <div className="approval-result-count">{activeList==="inbox"?"待处理":"我的申请"} · {activeApprovals.length} 条</div>
     <section className="table approval-data">
     <RareDataTable className="approval-table">
      <thead>{activeList==="inbox"
       ?<tr><th scope="col">文件</th><th className="approval-optional" scope="col">申请人</th>
        <th className="approval-optional" scope="col">类型</th><th className="approval-optional" scope="col">基准版本</th>
        <th className="approval-optional" scope="col">申请时间</th><th scope="col" className="approval-actions-col">操作</th></tr>
       :<tr><th scope="col">文件</th><th className="approval-optional" scope="col">类型</th>
        <th scope="col" className="approval-status-col">状态</th><th className="approval-optional" scope="col">审批人</th>
        <th className="approval-optional" scope="col">意见</th><th scope="col" className="approval-actions-col">操作</th></tr>}
      </thead>
      <tbody>{activeList==="inbox"?<>
       {visibleInbox.length===0&&<tr><td colSpan={6} className="empty">{search||typeFilter!=="all"?"没有匹配的审批":"没有待处理的审批"}</td></tr>}
       {visibleInbox.map(a=><tr key={a.id} tabIndex={0}
        aria-label={"查看审批详情 "+a.fileName}
        onClick={event=>onRowSelect(event,a)} onKeyDown={event=>onRowShortcut(event,a)}
        className={selectedApproval?.id===a.id?"approval-selected":""}>
        <td className="approval-file"><a className="approval-file-name" href={"/preview/"+encodeURIComponent(a.fileId)} title={a.fileName}>{a.fileName}</a>
         <span className="approval-mobile-meta">{a.requesterName} · {ACTION_LABELS[a.action]??a.action} · 第 {a.stepIndex+1}/{a.stepTotal} 级</span>
        </td>
        <td className="approval-optional">{a.requesterName}</td>
        <td className="approval-optional">{ACTION_LABELS[a.action]??a.action}{a.rollbackTargetSeq?" → v"+a.rollbackTargetSeq:""}</td>
        <td className="approval-optional">v{a.baseSeq} · 第 {a.stepIndex+1}/{a.stepTotal} 级</td>
        <td className="approval-optional approval-date">{formatTime(a.createdAt)}</td>
        <td className="approval-actions"><RareRowActions className="approval-action-buttons">
         <RareButton type="button" aria-label={"查看"+a.fileName+"审批详情"} onClick={()=>showHistory(a.id)}>详情</RareButton>
         <RareButton type="button" className="primary" disabled={!!busyId} onClick={()=>openDecision(a,"approve")}>通过</RareButton>
         <RareButton type="button" disabled={!!busyId} onClick={()=>openDecision(a,"reject")}>拒绝</RareButton>
        </RareRowActions></td>
       </tr>)}
      </>:<>
       {visibleMine.length===0&&<tr><td colSpan={6} className="empty">{search||stateFilter!=="all"||typeFilter!=="all"?"没有匹配的审批":"没有发起过审批"}</td></tr>}
       {visibleMine.map(a=><tr key={a.id} tabIndex={0}
        aria-label={"查看申请详情 "+a.fileName}
        onClick={event=>onRowSelect(event,a)} onKeyDown={event=>onRowShortcut(event,a)}
        className={selectedApproval?.id===a.id?"approval-selected":""}>
        <td className="approval-file"><a className="approval-file-name" href={"/preview/"+encodeURIComponent(a.fileId)} title={a.fileName}>{a.fileName}</a>
         <span className="approval-mobile-meta">{ACTION_LABELS[a.action]??a.action} · {a.approverName} · 第 {a.stepIndex+1}/{a.stepTotal} 级</span>
        </td>
        <td className="approval-optional">{ACTION_LABELS[a.action]??a.action}</td>
        <td className="approval-status-col"><RareBadge className="approval-status" tone={STATE_TONES[a.state]} dot>{STATE_LABELS[a.state]??a.state}</RareBadge></td>
        <td className="approval-optional">{a.approverName} · {a.stepIndex+1}/{a.stepTotal} 级</td>
        <td className="approval-optional approval-comment" title={a.decisionComment||undefined}>{a.decisionComment||"—"}</td>
        <td className="approval-actions"><RareRowActions className="approval-action-buttons">
         <RareButton type="button" aria-label={"查看"+a.fileName+"审批详情"} onClick={()=>showHistory(a.id)}>详情</RareButton>
         {a.state==="pending"&&<RareButton type="button" disabled={!!busyId} onClick={()=>openDecision(a,"cancel")}>撤回</RareButton>}
        </RareRowActions></td>
       </tr>)}
      </>}</tbody>
     </RareDataTable>
    </section>
   </div>
   <aside className="approval-side" aria-label="审批通知与时间线">
     <div className="approval-side-header">
      <GooeyNav className="approval-side-nav" aria-label="审批详情与通知" size="xs" radius={7} separation={10}
       items={["申请详情",unread>0?"通知 ("+unread+")":"通知"]}
       activeColor="var(--brand-blue)" activeLabelColor="var(--text-inverse)"
       value={sideMode==="detail"?0:1} onChange={index=>setSideMode(index===0?"detail":"notifications")}/>
      <RareButton type="button" className="approval-side-close" onClick={()=>setSideOpen(false)}>关闭</RareButton>
     </div>
     {sideMode==="detail"?<ApprovalDetail approval={selectedApproval} events={events} historyLoading={historyLoading}
      historyError={historyError} onDecision={openDecision} onReview={onReview} busy={!!busyId}
      canCancel={activeList==="mine"&&selectedApproval?.state==="pending"}
      canReview={activeList==="inbox"&&selectedApproval?.state==="pending"} />:<section className="approval-notification-list">
      <div className="approval-side-heading"><h3>站内通知</h3><RareButton type="button" onClick={()=>setShowAllNotes(v=>!v)}>{showAllNotes?"收起":"全部"}</RareButton></div>
      {noticeError&&<p role="alert" className="notice error">{noticeError}</p>}
      {notifications.length===0&&<p className="empty">暂无通知</p>}
      {(showAllNotes?notifications:notifications.slice(0,5)).map(n=><div key={n.id} className={"approval-note"+(n.read?"":" unread")}>
       <div className="approval-event-content">{n.fileName||"文件"} · {eventLabels[n.kind]||n.kind}
        <div className="approval-event-time">{new Date(n.createdAt).toLocaleString()}</div>
       </div>
       <RareButton type="button" onClick={()=>void readNote(n)}>{n.read?"查看":"查看并已读"}</RareButton>
      </div>)}
     </section>}
   </aside>
  </div>
  {decision&&<Dialog open title={decisionTitle} onClose={()=>{if(!busyId)setDecision(null);}}
   closeGuard={()=>!busyId} initialFocus={decision.action==="cancel"?undefined:"#approval-decision-comment"} className="approval-decision-dialog">
   <p className="approval-decision-file" title={decision.approval.fileName}>{decision.approval.fileName}</p>
   {decision.action!=="cancel"&&<label htmlFor="approval-decision-comment" className="approval-decision-label">
    审批意见{decision.action==="reject"?"（必填）":"（可选）"}
    <RareTextarea id="approval-decision-comment" rows={3} value={comment} disabled={!!busyId}
     placeholder={decision.action==="reject"?"请说明拒绝原因":"填写审批意见"} onChange={e=>{setComment(e.target.value);setDecisionError("");}}/>
   </label>}
   {decisionError&&<p className="approval-error" role="alert">{decisionError}</p>}
   <div className="dialog-actions">
    <RareButton type="button" disabled={!!busyId} onClick={()=>setDecision(null)}>取消</RareButton>
    <RareButton type="button" className={decision.action==="approve"?"primary":decision.action==="reject"?"danger":""}
     disabled={!!busyId||(decision.action==="reject"&&!comment.trim())} aria-busy={!!busyId} onClick={()=>void act(decision.approval.id,decision.action)}>
     {busyId?"处理中…":decisionTitle}</RareButton>
   </div>
  </Dialog>}
 </div>;
}
