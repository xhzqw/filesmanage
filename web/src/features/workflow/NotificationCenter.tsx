import {useEffect,useRef,useState} from "react";
import {observeWorkspaceChange} from "../../shared/resourceSync";
import {useNavigate} from "react-router-dom";
import {RareButton} from "../../shared/ui/rare";
import {approvalActivityApi,type ApprovalNotification} from "./activityApi";
import {lifecycleNotificationApi,type LifecycleNotice} from "./lifecycleNotificationApi";
import "./notificationCenter.css";

const eventLabel:Record<string,string>={submitted:"待你审批",advanced:"审批已流转",approved:"审批已通过",rejected:"审批被拒绝",cancelled:"申请已撤回",conflicted:"审批冲突"};

export function NotificationCenter(){
 const[notes,setNotes]=useState<ApprovalNotification[]>([]);
 const[lifecycleNotes,setLifecycleNotes]=useState<LifecycleNotice[]>([]);
 const[open,setOpen]=useState(false);
 const[loading,setLoading]=useState(false);
 const[error,setError]=useState("");
 const[showUnread,setShowUnread]=useState(false);
 const box=useRef<HTMLDivElement>(null);
 const navigate=useNavigate();
 const unread=[...notes,...lifecycleNotes].reduce((sum,n)=>sum+(n.read?0:1),0);
 useEffect(()=>{
  let valid=true;
  async function refresh(){
   try{
    const [items,due]=await Promise.all([approvalActivityApi.notifications(),lifecycleNotificationApi.notifications()]);
    if(valid){setNotes(items);setLifecycleNotes(due);setError("");}
   }catch{if(valid)setError("通知暂时不可用");}
  }
  void refresh();
  const interval=window.setInterval(()=>void refresh(),30000);
  const onUpdate=()=>void refresh();
  const onWorkspace=observeWorkspaceChange(onUpdate,["lifecycle","review"]);
  window.addEventListener("filesmanage:approvals-changed",onUpdate);
  window.addEventListener("filesmanage:approval-notifications-read",onUpdate);
  window.addEventListener("filesmanage:lifecycle-notifications-read",onUpdate);
  return()=>{valid=false;window.clearInterval(interval);onWorkspace();window.removeEventListener("filesmanage:approvals-changed",onUpdate);window.removeEventListener("filesmanage:approval-notifications-read",onUpdate);window.removeEventListener("filesmanage:lifecycle-notifications-read",onUpdate);};
 },[]);
 useEffect(()=>{
  if(!open)return;
  const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!box.current?.contains(event.target))setOpen(false);};
  const escape=(event:KeyboardEvent)=>{if(event.key==="Escape")setOpen(false);};
  document.addEventListener("pointerdown",outside);
  document.addEventListener("keydown",escape);
  return()=>{document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",escape);};
 },[open]);
 async function view(note:ApprovalNotification){
  if(loading)return;
  setLoading(true);
  if(!note.read){
   try{
    await approvalActivityApi.read(note.id);
    setNotes(current=>current.map(n=>n.id===note.id?{...n,read:true}:n));
    window.dispatchEvent(new Event("filesmanage:approval-notifications-read"));
   }catch{setError("标记已读失败，可重试");setLoading(false);return;}
  }
  setOpen(false);
  setLoading(false);
  navigate("/approvals?item="+encodeURIComponent(note.approvalId));
 }
 async function viewLifecycle(note:LifecycleNotice){
  if(loading)return;
  setLoading(true);
  if(!note.read){
   try{
    await lifecycleNotificationApi.read(note.id);
    setLifecycleNotes(current=>current.map(n=>n.id===note.id?{...n,read:true}:n));
    window.dispatchEvent(new Event("filesmanage:lifecycle-notifications-read"));
   }catch{setError("标记已读失败，可重试");setLoading(false);return;}
  }
  setOpen(false);setLoading(false);
  navigate("/preview/"+encodeURIComponent(note.fileId));
 }
 const visible=showUnread?notes.filter(n=>!n.read):notes.slice(0,12);
 const visibleLife=showUnread?lifecycleNotes.filter(n=>!n.read):lifecycleNotes.slice(0,12);
 return <div className="notification-center" ref={box}>
  <RareButton type="button" className="notification-trigger" title="消息通知" aria-label={`消息通知，未读 ${unread} 条`} aria-haspopup="dialog" aria-expanded={open} onClick={()=>setOpen(v=>!v)}>
   <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4"/>
   </svg>
   {unread>0&&<span className="notification-count">{unread>99?"99+":unread}</span>}
  </RareButton>
  {open&&<div className="notification-popover" role="dialog" aria-label="消息通知">
   <div className="notification-head"><strong>消息通知</strong><RareButton type="button" onClick={()=>setShowUnread(v=>!v)}>{showUnread?"全部":"未读"}</RareButton></div>
   {error&&<p className="notification-error" role="alert">{error}</p>}
   <div className="notification-scroll">
    {visible.length===0&&visibleLife.length===0&&<p className="notification-empty">{showUnread?"暂无未读通知":"暂无通知"}</p>}
    {visible.map(n=><RareButton type="button" key={n.id} disabled={loading} className={"notification-row"+(n.read?"":" is-unread")} onClick={()=>void view(n)}>
      <span className="notification-row-main">
       <span>{n.fileName||"文档"} · {eventLabel[n.kind]??n.kind}</span>
       <small>{new Date(n.createdAt).toLocaleString("zh-CN")}</small>
      </span>
      {!n.read&&<span className="notification-dot" aria-label="未读"/>}
     </RareButton>)}
    {visibleLife.map(n=><RareButton type="button" key={"life-"+n.id} disabled={loading} className={"notification-row"+(n.read?"":" is-unread")} onClick={()=>void viewLifecycle(n)}>
      <span className="notification-row-main">
       <span>{n.fileName||"文档"} · {n.kind==="overdue"?"已到期":"7 天内到期"}</span>
       <small>到期日 {new Date(n.dueAt).toLocaleDateString("zh-CN")}</small>
      </span>
      {!n.read&&<span className="notification-dot" aria-label="未读"/>}
     </RareButton>)}
   </div>
   <div className="notification-footer"><RareButton type="button" onClick={()=>{setOpen(false);navigate("/lifecycle");}}>生命周期台账</RareButton><RareButton type="button" onClick={()=>{setOpen(false);navigate("/approvals");}}>进入审批工作台</RareButton></div>
  </div>}
 </div>;
}
