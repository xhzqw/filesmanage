import {useEffect,useRef,useState} from "react";
import {observeWorkspaceChange} from "../../shared/resourceSync";
import {useNavigate} from "react-router-dom";
import {RareButton,NotificationBell} from "../../shared/ui/rare";
import {toast} from "../../shared/ui/feedback";
import {errorCode} from "../../shared/errors";
import {approvalActivityApi,type ApprovalNotification} from "./activityApi";
import {lifecycleNotificationApi,type LifecycleNotice} from "./lifecycleNotificationApi";
import {favoriteNotificationApi,type FavoriteChangeNotice} from "./favoriteNotificationApi";
import {reviewNotificationApi,type ReviewNotice} from "./reviewNotificationApi";
import {lifecycleWorkspaceEnabled} from "../../shared/featureFlags";
import "./notificationCenter.css";

const eventLabel:Record<string,string>={submitted:"待你审批",advanced:"审批已流转",approved:"审批已通过",rejected:"审批被拒绝",cancelled:"申请已撤回",conflicted:"审批冲突"};

export function NotificationCenter(){
 const[notes,setNotes]=useState<ApprovalNotification[]>([]);
 const[approvalUnread,setApprovalUnread]=useState(0);
 const[lifecycleNotes,setLifecycleNotes]=useState<LifecycleNotice[]>([]);
 const[favoriteNotes,setFavoriteNotes]=useState<FavoriteChangeNotice[]>([]);
 const[favoriteUnread,setFavoriteUnread]=useState(0);
 const[reviewNotes,setReviewNotes]=useState<ReviewNotice[]>([]);
 const[reviewUnread,setReviewUnread]=useState(0);
 const[open,setOpen]=useState(false);
 const[loading,setLoading]=useState(false);
 const[error,setError]=useState("");
 const[showUnread,setShowUnread]=useState(false);
 const box=useRef<HTMLDivElement>(null);
 const navigate=useNavigate();
 const unread=approvalUnread+reviewUnread+favoriteUnread+lifecycleNotes.filter(n=>!n.read).length;
 useEffect(()=>{
  let valid=true;
  async function refresh(){
   try{
    const [page,due,favorite,reviews]=await Promise.all([approvalActivityApi.notificationsPage(0,50),lifecycleWorkspaceEnabled?lifecycleNotificationApi.notifications():Promise.resolve([] as LifecycleNotice[]),favoriteNotificationApi.list().catch(error=>{
     if(errorCode(error)==="E_NOT_FOUND")return {items:[],unreadCount:0};
     throw error;
    }),reviewNotificationApi.list()]);
    if(valid){setNotes(page.items);setApprovalUnread(page.unreadCount);setLifecycleNotes(due);setFavoriteNotes(favorite.items);setFavoriteUnread(favorite.unreadCount);setReviewNotes(reviews.items);setReviewUnread(reviews.unreadCount);setError("");}
   }catch{if(valid)setError("通知暂时不可用");}
  }
  void refresh();
  const interval=window.setInterval(()=>void refresh(),30000);
  const onUpdate=()=>void refresh();
  const onWorkspace=observeWorkspaceChange(onUpdate,["lifecycle","review","collaboration"]);
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
    setApprovalUnread(current=>Math.max(0,current-1));
    window.dispatchEvent(new Event("filesmanage:approval-notifications-read"));
   }catch{setError("标记已读失败，可重试");toast.error("标记已读失败，可重试");setLoading(false);return;}
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
   }catch{setError("标记已读失败，可重试");toast.error("标记已读失败，可重试");setLoading(false);return;}
  }
  setOpen(false);setLoading(false);
  navigate("/preview/"+encodeURIComponent(note.fileId));
 }
 async function viewFavorite(note:FavoriteChangeNotice){
  if(loading)return;
  setLoading(true);
  if(!note.read){
   try{
    await favoriteNotificationApi.read(note.id);
    setFavoriteNotes(current=>current.map(item=>item.id===note.id?{...item,read:true}:item));
    setFavoriteUnread(current=>Math.max(0,current-1));
   }catch{setError("标记已读失败，可重试");toast.error("标记已读失败，可重试");setLoading(false);return;}
  }
  setOpen(false);setLoading(false);
  navigate("/doc?view=favorites");
 }
 async function viewReview(note:ReviewNotice){
  if(loading)return;
  setLoading(true);
  if(!note.read){
   try{
    await reviewNotificationApi.read(note.id);
    setReviewNotes(old=>old.map(n=>n.id===note.id?{...n,read:true}:n));
    setReviewUnread(old=>Math.max(0,old-1));
   }catch{setError("标记批注已读失败");toast.error("标记已读失败");setLoading(false);return}
  }
  setOpen(false);setLoading(false);
  if(!note.fileId){toast.error("该文件已无法访问，通知已标为已读");return}
  navigate("/preview/"+encodeURIComponent(note.fileId)+"?tab=review");
 }
 const visible=showUnread?notes.filter(n=>!n.read):notes.slice(0,12);
 const visibleLife=showUnread?lifecycleNotes.filter(n=>!n.read):lifecycleNotes.slice(0,12);
 const visibleFavorites=showUnread?favoriteNotes.filter(n=>!n.read):favoriteNotes.slice(0,12);
 const visibleReviews=showUnread?reviewNotes.filter(n=>!n.read):reviewNotes.slice(0,12);
 return <div className="notification-center" ref={box}>
  <NotificationBell className="notification-trigger" title="消息通知" count={unread} max={99}
    aria-label={`消息通知，未读 ${unread} 条`} aria-haspopup="dialog" aria-expanded={open} onClick={()=>setOpen(v=>!v)}/>
  {open&&<div className="notification-popover" role="dialog" aria-label="消息通知">
   <div className="notification-head"><strong>消息通知</strong><RareButton type="button" onClick={()=>setShowUnread(v=>!v)}>{showUnread?"全部":"未读"}</RareButton></div>
   {error&&<p className="notification-error" role="alert">{error}</p>}
   <div className="notification-scroll">
    {visible.length===0&&visibleLife.length===0&&visibleFavorites.length===0&&visibleReviews.length===0&&<p className="notification-empty">{showUnread?"暂无未读通知":"暂无通知"}</p>}
    {visibleReviews.map(n=><RareButton type="button" key={"review-"+n.id} disabled={loading} className={"notification-row"+(n.read?"":" is-unread")} onClick={()=>void viewReview(n)}>
      <span className="notification-row-main"><span>{n.kind==="access_revoked"?"无权限查看的历史通知":(n.fileName||"文档")+" · "+(n.kind==="created"||n.kind==="assign"?"批注待你处理":n.kind==="submit-resolution"||n.kind==="update-resolution"?"处理结果待验收":n.kind==="reject"?"批注已退回":n.kind==="approve"?"批注已验收":"批注状态更新")}</span>
      <small>{new Date(n.createdAt).toLocaleString("zh-CN")}</small></span>
     {!n.read&&<span className="notification-dot" aria-label="未读"/>}
    </RareButton>)}
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
    {visibleFavorites.map(n=><RareButton type="button" key={"favorite-"+n.id} disabled={loading} className={"notification-row"+(n.read?"":" is-unread")} onClick={()=>void viewFavorite(n)}>
      <span className="notification-row-main">
       <span>你关注的 {n.affectedCount} 项资源发生变化</span>
       <small>{new Date(n.createdAt).toLocaleString("zh-CN")}</small>
      </span>
      {!n.read&&<span className="notification-dot" aria-label="未读"/>}
     </RareButton>)}
   </div>
   <div className="notification-footer">{lifecycleWorkspaceEnabled&&<RareButton type="button" onClick={()=>{setOpen(false);navigate("/lifecycle");}}>生命周期台账</RareButton>}<RareButton type="button" onClick={()=>{setOpen(false);navigate("/approvals?tab=notifications");}}>查看全部通知</RareButton></div>
  </div>}
 </div>;
}
