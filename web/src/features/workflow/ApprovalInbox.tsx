import {RareButton,RareInput} from "../../shared/ui/rare";
import {useEffect,useState} from "react";
import {useLocation} from "react-router-dom";
import {workflowApi} from "./api";
import type {Approval} from "./api";
import {errorCode,errorCopy} from "../../shared/errors";
import type {User} from "../../entities/user/model";
import {approvalActivityApi,type ApprovalEvent,type ApprovalNotification} from "./activityApi";
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

export function ApprovalInbox({currentUser}:{currentUser:User}){
 const[inbox,setInbox]=useState<Approval[]>([]);
 const[mine,setMine]=useState<Approval[]>([]);
 const[status,setStatus]=useState("loading");
 const[message,setMessage]=useState("");
 const[drafts,setDrafts]=useState<Record<string,string>>({});
 const[busyId,setBusyId]=useState("");
 const[reloadToken,setReloadToken]=useState(0);
 const[activeList,setActiveList]=useState<"inbox"|"mine">("inbox");
 const[selected,setSelected]=useState("");
 const location=useLocation();
 useEffect(()=>{const id=new URLSearchParams(location.search).get("item");setSelected(id&&id.length<=128?id:"");},[location.search]);
 const[events,setEvents]=useState<ApprovalEvent[]>([]);
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
 },[reloadToken]);
 useEffect(()=>{
  if(!selected){setEvents([]);return;}
  let active=true;
  setEvents([]);setHistoryError("");
  approvalActivityApi.history(selected).then(items=>{if(active)setEvents(items);}).catch(()=>{if(active)setHistoryError("无法读取审批记录");});
  return()=>{active=false;};
 },[selected,reloadToken]);
 async function readNote(note:ApprovalNotification){
  setSelected(note.approvalId);
  if(!note.read){
   try{await approvalActivityApi.read(note.id);setNotifications(items=>items.map(item=>item.id===note.id?{...item,read:true}:item));window.dispatchEvent(new Event("filesmanage:approval-notifications-read"));}
   catch{setNoticeError("标记已读失败");}
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
  setMessage("");setBusyId(id);
  try{
   if(action==="approve"){
    const result=await workflowApi.approve(id,drafts[id]??"");
    setMessage(result.status==="committed"?"已通过并生成新版本":"本级审批已通过，已转交下一级；当前版本不变");
   }else if(action==="reject"){
    await workflowApi.reject(id,drafts[id]??"");
    setMessage("已拒绝，当前版本不变");
   }else{
    await workflowApi.cancel(id);
    setMessage("已撤回申请");
   }
   setReloadToken(token=>token+1);
  }catch(error){
   const code=errorCode(error);
   if(code==="E_VERSION_CONFLICT"||code==="E_APPROVAL_PENDING"){
    setMessage("审批状态已变化，请刷新");
    setReloadToken(token=>token+1);
   }else{
    setMessage(errorCopy(error,"操作失败"));
   }
  }finally{
   setBusyId("");
  }
 }

 if(status!=="ready")return <p className="empty">{status==="loading"?"正在加载审批…":"获取审批列表失败"}</p>;

 return <div className="work-body">
  <div className="toolbar approval-tabs" role="tablist" aria-label="审批分类">
   <RareButton type="button" role="tab" aria-selected={activeList==="inbox"} onClick={()=>setActiveList("inbox")}>待我审批 {inbox.length}</RareButton>
   <RareButton type="button" role="tab" aria-selected={activeList==="mine"} onClick={()=>setActiveList("mine")}>我发起的 {mine.length}</RareButton>
  </div>
  {message&&<p role="status" className="notice">{message}</p>}
  <div className="approval-workbench">
   <div className="approval-main">
  {activeList==="inbox"&&<section className="table">
   <h3>待我审批</h3>
   <table>
    <thead><tr><th scope="col">文件</th><th scope="col">申请人</th><th scope="col">类型</th><th scope="col">基准版本</th><th scope="col">申请时间</th><th scope="col">操作</th></tr></thead>
    <tbody>
     {inbox.length===0&&<tr><td colSpan={6} className="empty">没有待处理的审批。</td></tr>}
     {inbox.map(a=><tr key={a.id}>
      <td><a href={"/preview/"+a.fileId}>{a.fileName}</a></td>
      <td>{a.requesterName}</td>
      <td>{ACTION_LABELS[a.action]??a.action}{a.rollbackTargetSeq?` → v${a.rollbackTargetSeq}`:""}</td>
      <td>v{a.baseSeq} · 第 {a.stepIndex+1}/{a.stepTotal} 级</td>
      <td>{a.createdAt.replace("T"," ").slice(0,16)}</td>
      <td className="row-actions">
       <RareInput aria-label={`审批意见 — ${a.fileName}`} placeholder="审批意见（可选）" value={drafts[a.id]??""}
        style={{minWidth:"180px"}} disabled={busyId!==""}
        onChange={e=>setDrafts(prev=>({...prev,[a.id]:e.target.value}))}/>
       {busyId===a.id&&<span className="toolbar-hint">处理中…</span>}
       <RareButton type="button" onClick={()=>setSelected(a.id)}>历史</RareButton>
       <RareButton type="button" className="primary" disabled={busyId!==""} onClick={()=>act(a.id,"approve")}>通过</RareButton>
       <RareButton type="button" className="danger" disabled={busyId!==""} onClick={()=>act(a.id,"reject")}>拒绝</RareButton>
      </td>
     </tr>)}
    </tbody>
   </table>
  </section>}
  {activeList==="mine"&&<section className="table">
   <h3>我发起的</h3>
   <table>
    <thead><tr><th scope="col">文件</th><th scope="col">类型</th><th scope="col">状态</th><th scope="col">审批人</th><th scope="col">意见</th><th scope="col">操作</th></tr></thead>
    <tbody>
     {mine.length===0&&<tr><td colSpan={6} className="empty">没有发起过审批。</td></tr>}
     {mine.map(a=><tr key={a.id}>
      <td><a href={"/preview/"+a.fileId}>{a.fileName}</a></td>
      <td>{ACTION_LABELS[a.action]??a.action}</td>
      <td><span className="approval-status" data-state={a.state}>{STATE_LABELS[a.state]??a.state}</span></td>
      <td>{a.approverName} · {a.stepIndex+1}/{a.stepTotal} 级</td>
      <td>{a.decisionComment||"—"}</td>
      <td className="row-actions"><RareButton type="button" onClick={()=>setSelected(a.id)}>历史</RareButton>{a.state==="pending"&&<RareButton type="button" disabled={busyId!==""} onClick={()=>act(a.id,"cancel")}>撤回</RareButton>}</td>
     </tr>)}
    </tbody>
   </table>
  </section>}
   </div>
   <aside className="approval-side" aria-label="审批通知与时间线">
    {!selected&&<>
    <div className="approval-side-heading"><h3>站内通知 {unread>0?`（${unread} 未读）`:""}</h3><RareButton type="button" onClick={()=>setShowAllNotes(v=>!v)}>{showAllNotes?"收起":"更多"}</RareButton></div>
    {noticeError&&<p role="alert" className="notice error">{noticeError}</p>}
    {notifications.length===0&&<p className="empty">暂无通知</p>}
    {(showAllNotes?notifications:notifications.slice(0,5)).map(n=><div key={n.id} className={"approval-note"+(n.read?"":" unread")}>
     <div className="approval-event-content">{n.fileName||"文件"} · {eventLabels[n.kind]||n.kind}
      <div className="approval-event-time">{new Date(n.createdAt).toLocaleString()}</div>
     </div>
     <RareButton type="button" onClick={()=>void readNote(n)}>{n.read?"查看":"查看并已读"}</RareButton>
    </div>)}
    </>}
    {selected&&<section aria-label="审批时间线">
     <div className="approval-side-heading"><h3>审批时间线</h3><RareButton type="button" onClick={()=>setSelected("")}>关闭</RareButton></div>
     {historyError&&<p role="alert" className="notice error">{historyError}</p>}
     {events.length===0&&!historyError&&<p className="empty">正在读取…</p>}
     {events.map(e=><div className="approval-event" key={e.id}><div className="approval-event-content">
      <strong>{eventLabels[e.kind]||e.kind}</strong> · 第 {e.stepIndex+1} 级 · {e.actorName||e.actorId}
      <div className="approval-event-time">{new Date(e.createdAt).toLocaleString()}</div>
      {e.comment&&<div className="approval-event-comment">{e.comment}</div>}
     </div></div>)}
    </section>}
   </aside>
  </div>
 </div>;
}
