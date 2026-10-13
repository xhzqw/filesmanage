import {RareButton} from "../shared/ui/rare";
import {toast} from "../shared/ui/feedback";
import {useCallback,useEffect,useState} from "react";
import {Link} from "react-router-dom";
import type {User} from "../entities/user/model";
import {AppShell} from "../shared/ui/AppShell";
import {Dialog} from "../shared/ui/Dialog";
import {sessionApi,type DeviceSession,type AuthActivity} from "../features/auth/sessionsApi";
import {errorCode,errorCopy} from "../shared/errors";
import "./SessionDevices.css";

function dateTime(value:string):string{
 const when=new Date(value);
 return Number.isFinite(when.getTime())?new Intl.DateTimeFormat("zh-CN",{
  year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"
 }).format(when):"—";
}
const activityLabels:Record<string,string>={
 "auth.login":"登录成功",
 "auth.logout":"退出登录",
 "auth.session_revoke":"撤销一台设备",
 "auth.sessions_revoke":"退出其他全部设备",
};
export function SessionDevices({user,onLogout}:{user:User;onLogout:()=>void}){
 const [sessions,setSessions]=useState<DeviceSession[]>([]);
 const [activity,setActivity]=useState<AuthActivity[]>([]);
 const [loading,setLoading]=useState(true);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [notice,setNotice]=useState("");
 const [confirm,setConfirm]=useState<string|null>(null);

 const refresh=useCallback(async()=>{
  try{
   const [items,events]=await Promise.all([sessionApi.list(),sessionApi.activity()]);
   setSessions(items);setActivity(events);setError("");
  }catch{setError("无法读取登录设备，请检查网络并重试。")}
  finally{setLoading(false)}
 },[]);
 useEffect(()=>{
  void refresh();
  const onChange=()=>{void refresh()};
  window.addEventListener("filesmanage:sessions-changed",onChange);
  return ()=>window.removeEventListener("filesmanage:sessions-changed",onChange);
 },[refresh]);

 async function execute(){
  if(!confirm||busy)return;
  setBusy(true);setNotice("");setError("");
  try{
   if(confirm==="others"){
    const result=await sessionApi.revokeOthers();
    setNotice("已撤销 "+result.revoked+" 个其他登录会话。");
    toast.success("已撤销 "+result.revoked+" 个其他登录会话");
   }else{
    await sessionApi.revoke(confirm);
    setNotice("该设备已退出登录。");
    toast.success("该设备已退出登录");
   }
   setConfirm(null);
   await refresh();
  }catch(cause){
   setError(errorCode(cause)==="E_NETWORK"
    ?"网络中断，撤销结果未确认；请刷新设备列表核对后再重试"
    :errorCopy(cause,"撤销会话失败，请核对设备状态后重试"));
   // Local actionable error is authoritative; avoid a duplicate global alert.
  }
  finally{setBusy(false)}
 }
 const others=sessions.filter(row=>!row.current);
 return <AppShell user={user} onLogout={onLogout} product="账号安全">
  <div className="panels">
   <main className="work sessions-work">
    <div className="sessions-page">
     <div className="sessions-heading">
      <div><h1>登录设备与安全</h1><p>管理你自己的登录会话。撤销后，其他设备将通过实时通知或下次请求退出。</p></div>
      <div className="sessions-heading-actions">
       <Link to="/doc" className="sessions-btn sessions-back">返回文件列表</Link>
       <RareButton type="button" className="sessions-btn" onClick={()=>void refresh()} disabled={loading||busy}>刷新</RareButton>
      </div>
     </div>
     {error&&<p className="sessions-alert" role="alert">{error}</p>}
     {notice&&<p className="sessions-notice" role="status">{notice}</p>}
     <section className="sessions-panel" aria-labelledby="sessions-title">
      <div className="sessions-panel-heading">
       <div><h2 id="sessions-title">活跃登录会话</h2><p>最多显示最近 50 条；仅展示你自己的会话。</p></div>
       <RareButton type="button" className="sessions-btn sessions-danger" disabled={busy||others.length===0}
        onClick={()=>setConfirm("others")}>退出其他所有设备</RareButton>
      </div>
      {loading?<p className="sessions-empty">加载设备中…</p>:
       sessions.length===0?<p className="sessions-empty">暂无可用的登录会话。</p>:
       <ul className="sessions-list">{sessions.map(row=><li key={row.id} className="sessions-item">
        <div className="sessions-device-icon" aria-hidden="true">▣</div>
        <div className="sessions-device-info">
         <div className="sessions-device-name">{row.device||"未知浏览器"} {row.current&&<span className="sessions-current">当前设备</span>}</div>
         <div className="sessions-device-meta">来源 IP：{row.address||"未记录"} · 登录于 {dateTime(row.createdAt)}</div>
         <div className="sessions-device-meta">最近活动：{dateTime(row.lastSeenAt)} · 到期：{dateTime(row.expiresAt)}</div>
        </div>
        {!row.current&&<RareButton type="button" className="sessions-btn sessions-danger" disabled={busy}
          onClick={()=>setConfirm(row.id)}>退出此设备</RareButton>}
       </li>)}</ul>}
     </section>
     <section className="sessions-panel" aria-labelledby="sessions-activity">
      <div className="sessions-panel-heading"><div><h2 id="sessions-activity">最近安全操作</h2><p>保留在服务端的最近 30 条登录和会话撤销记录。</p></div></div>
      {activity.length===0?<p className="sessions-empty">暂无相关操作记录。</p>:
       <ul className="sessions-audit">{activity.map((event,i)=><li key={i}>
        <div><strong>{event.type==="auth.login"&&event.outcome==="denied"?"登录失败":(activityLabels[event.type]??"安全操作")}</strong>
        {event.count!==undefined&&event.count>0?<span> · {event.count} 个会话</span>:null}
        <p>{event.device||"账号操作"}{event.address?" · "+event.address:""}</p></div>
        <time>{dateTime(event.occurredAt)}</time>
       </li>)}</ul>}
     </section>
    </div>
   </main>
  </div>
  {confirm!==null&&<Dialog open title={confirm==="others"?"退出其他所有设备？":"退出这台设备？"}
    onClose={()=>{if(!busy)setConfirm(null);}} closeGuard={()=>!busy} className="sessions-confirm">
     <p>撤销操作会立即在服务器生效，受影响的设备需要重新登录。当前设备不会被退出。</p>
     <div className="sessions-confirm-actions">
      <RareButton type="button" className="sessions-btn" onClick={()=>setConfirm(null)} disabled={busy}>取消</RareButton>
      <RareButton type="button" tone="danger" className="sessions-btn sessions-danger" onClick={()=>void execute()} loading={busy}>
       确认退出
      </RareButton>
     </div>
   </Dialog>}
 </AppShell>;
}
