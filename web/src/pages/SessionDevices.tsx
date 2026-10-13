import {RareButton} from "../shared/ui/rare";
import {toast} from "../shared/ui/feedback";
import {useCallback,useEffect,useMemo,useState} from "react";
import {Link} from "react-router-dom";
import type {User} from "../entities/user/model";
import {AppShell} from "../shared/ui/AppShell";
import {Dialog} from "../shared/ui/Dialog";
import {sessionApi,type DeviceSession,type AuthActivity} from "../features/auth/sessionsApi";
import {errorCode,errorCopy} from "../shared/errors";
import "./SessionDevices.css";

const dateFormatter=new Intl.DateTimeFormat("zh-CN",{
 year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"
});
function dateTime(value:string):string{
 const date=new Date(value);
 return Number.isFinite(date.getTime())?dateFormatter.format(date):"未记录";
}
function networkValue(value?:string):string{return value?.trim()||"未获取";}
function sessionKey(row:DeviceSession):string{
 // A group represents matching recorded metadata, NOT verified physical identity.
 return JSON.stringify([row.device||"",row.address||"",row.macAddress||""]);
}
function deviceSymbol(device:string):string{
 if(/iphone|ipad|android|ios/i.test(device))return "▯";
 return "▣";
}
function SessionFacts({session}:{session:DeviceSession}){
 return <dl className="sessions-facts">
  <div><dt>IP 地址</dt><dd>{networkValue(session.address)}</dd></div>
  <div><dt>MAC 地址</dt><dd>{networkValue(session.macAddress)}</dd></div>
  <div><dt>登录时间</dt><dd>{dateTime(session.createdAt)}</dd></div>
  <div><dt>最近活动</dt><dd>{dateTime(session.lastSeenAt)}</dd></div>
  <div><dt>过期时间</dt><dd>{dateTime(session.expiresAt)}</dd></div>
  <div><dt>会话编号</dt><dd>{session.id.slice(0,12)}</dd></div>
 </dl>;
}
const activityLabels:Record<string,string>={
 "auth.login":"登录成功","auth.logout":"退出登录",
 "auth.session_revoke":"退出指定会话","auth.sessions_revoke":"退出其他会话"
};
function activityTitle(event:AuthActivity):string{
 if(event.type==="auth.login"&&event.outcome==="denied")return "登录失败";
 return activityLabels[event.type]??"安全操作";
}

export function SessionDevices({user,onLogout}:{user:User;onLogout:()=>void}){
 const [sessions,setSessions]=useState<DeviceSession[]>([]);
 const [activity,setActivity]=useState<AuthActivity[]>([]);
 const [loading,setLoading]=useState(true);
 const [refreshing,setRefreshing]=useState(false);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [activityError,setActivityError]=useState(false);
 const [confirm,setConfirm]=useState<string|null>(null);
 const [expanded,setExpanded]=useState<Record<string,boolean>>({});

 const refresh=useCallback(async()=>{
  setRefreshing(true);
  try{
   const [sessionResult,activityResult]=await Promise.allSettled([sessionApi.list(),sessionApi.activity()]);
   if(sessionResult.status==="fulfilled"){
    setSessions(sessionResult.value);
    setError("");
   }else{
    setError("无法获取登录会话，请检查网络后刷新。");
   }
   if(activityResult.status==="fulfilled"){
    setActivity(activityResult.value);
    setActivityError(false);
   }else{
    setActivityError(true);
   }
  }finally{
   setLoading(false);
   setRefreshing(false);
  }
 },[]);
 useEffect(()=>{
  void refresh();
  const onChange=()=>{void refresh();};
  window.addEventListener("filesmanage:sessions-changed",onChange);
  return ()=>window.removeEventListener("filesmanage:sessions-changed",onChange);
 },[refresh]);

 const current=sessions.find(row=>row.current);
 const others=useMemo(()=>sessions.filter(row=>!row.current).sort(
  (a,b)=>new Date(b.lastSeenAt).getTime()-new Date(a.lastSeenAt).getTime()
 ),[sessions]);
 const groups=useMemo(()=>{
  const map=new Map<string,{key:string;device:string;address:string;mac:string;items:DeviceSession[]}>();
  for(const session of others){
   const key=sessionKey(session);
   const group=map.get(key);
   if(group){group.items.push(session);}
   else map.set(key,{key,device:session.device||"未知浏览器",address:session.address,
    mac:session.macAddress||"",items:[session]});
  }
  return [...map.values()];
 },[others]);
 const target=confirm&&confirm!=="others"?others.find(row=>row.id===confirm):undefined;

 async function revoke(){
  if(!confirm||busy)return;
  setBusy(true);
  setError("");
  try{
   if(confirm==="others"){
    const result=await sessionApi.revokeOthers();
    toast.success("已退出 "+result.revoked+" 个其他会话");
   }else{
    await sessionApi.revoke(confirm);
    toast.success("该会话已退出");
   }
   setConfirm(null);
   await refresh();
  }catch(cause){
   setError(errorCode(cause)==="E_NETWORK"
    ?"网络中断，操作结果无法确认，请刷新列表核对。"
    :errorCopy(cause,"操作失败，请刷新后重试。"));
  }finally{setBusy(false);}
 }

 return <AppShell user={user} onLogout={onLogout} product="账号安全">
  <div className="panels sessions-layout">
   <main className="work sessions-work">
    <div className="sessions-page">
     <header className="sessions-heading">
      <div className="sessions-heading-copy">
       <h1>登录设备与安全</h1>
       <p>查看当前会话、管理其他登录及安全记录</p>
      </div>
      <div className="sessions-heading-actions">
       <Link to="/doc" className="sessions-btn sessions-back">返回文档</Link>
       <RareButton className="sessions-btn" onClick={()=>void refresh()} disabled={refreshing||busy}>
        {refreshing?"刷新中…":"刷新"}
       </RareButton>
      </div>
     </header>
     {error&&<p className="sessions-alert" role="alert">{error}</p>}
     <div className="sessions-grid">
      <div className="sessions-primary">
       <section className="sessions-panel sessions-current-panel" aria-labelledby="sessions-current-title">
        <div className="sessions-panel-heading">
         <div><h2 id="sessions-current-title">当前会话</h2><p>你正在使用的浏览器连接</p></div>
         {current&&<span className="sessions-current-pill">正在使用</span>}
        </div>
        {loading?<div className="sessions-empty">正在加载会话…</div>:
         current?<div className="sessions-current-body">
          <div className="sessions-device-lead">
           <span className="sessions-device-icon" aria-hidden="true">{deviceSymbol(current.device)}</span>
           <strong>{current.device||"未知浏览器"}</strong>
          </div>
          <SessionFacts session={current}/>
         </div>:<div className="sessions-empty">
          {error?"无法确认当前会话":"当前会话未出现在列表中，请刷新核对。"}
         </div>}
       </section>
       <section className="sessions-panel sessions-others-panel" aria-labelledby="sessions-other-title">
        <div className="sessions-panel-heading sessions-other-heading">
         <div>
          <h2 id="sessions-other-title">其他登录会话 <span className="sessions-count">{others.length}</span></h2>
          <p>同来源会话归为一组，可展开查看并逐条退出</p>
         </div>
         <RareButton tone="danger" className="sessions-btn sessions-danger"
          disabled={busy||refreshing||others.length===0} onClick={()=>setConfirm("others")}>
          退出其他全部会话
         </RareButton>
        </div>
        <div className="sessions-groups-scroll">
         {loading?<div className="sessions-empty">正在加载…</div>:
          others.length===0?<div className="sessions-empty">没有其他登录会话</div>:
          groups.map(group=>{
           const open=expanded[group.key]??group.items.length===1;
           return <section className="sessions-group" key={group.key}>
            <RareButton type="button" className="sessions-group-toggle" aria-expanded={open}
             onClick={()=>setExpanded(prev=>({...prev,[group.key]:!open}))}>
             <span className="sessions-device-icon" aria-hidden="true">{deviceSymbol(group.device)}</span>
             <span className="sessions-group-info">
              <span className="sessions-group-title">{group.device}<span className="sessions-group-count">{group.items.length} 个会话</span></span>
              <span className="sessions-group-subtitle">IP {networkValue(group.address)} · MAC {networkValue(group.mac)}</span>
             </span>
             <span className={"sessions-chevron"+(open?" is-open":"")} aria-hidden="true">⌄</span>
            </RareButton>
            {open&&<ul className="sessions-detail-list">
             {group.items.map(item=><li key={item.id} className="sessions-detail-item">
              <div className="sessions-detail-head">
               <span>登录于 {dateTime(item.createdAt)}</span>
               <RareButton tone="danger" className="sessions-btn sessions-danger sessions-revoke"
                disabled={busy||refreshing} onClick={()=>setConfirm(item.id)}>退出此会话</RareButton>
              </div>
              <SessionFacts session={item}/>
             </li>)}
            </ul>}
           </section>;
          })}
        </div>
       </section>
      </div>
      <aside className="sessions-panel sessions-activity-panel" aria-labelledby="sessions-activity-title">
       <div className="sessions-panel-heading">
        <div><h2 id="sessions-activity-title">最近安全操作</h2><p>最近 30 条登录和退出记录</p></div>
       </div>
       <div className="sessions-audit-scroll">
        {activityError&&<p className="sessions-audit-error" role="status">记录获取失败，请刷新重试。</p>}
        {!activityError&&activity.length===0?<div className="sessions-empty">暂无安全操作记录</div>:
         <ol className="sessions-audit">
          {activity.map((event,i)=><li key={event.occurredAt+"-"+i}>
           <div className="sessions-event-line"><strong>{activityTitle(event)}</strong>
            {event.count!==undefined&&event.count>0?<span> · {event.count} 个</span>:null}</div>
           <time dateTime={event.occurredAt}>{dateTime(event.occurredAt)}</time>
           {(event.device||event.address||event.macAddress)&&<p>
            {[event.device,event.address?"IP "+event.address:"",event.macAddress?"MAC "+event.macAddress:""].filter(Boolean).join(" · ")}
           </p>}
          </li>)}
         </ol>}
       </div>
       <p className="sessions-activity-footnote">MAC 仅在服务器能识别局域网邻居时记录；相同来源不代表同一实体设备。</p>
      </aside>
     </div>
    </div>
   </main>
  </div>
  {confirm!==null&&<Dialog open title={confirm==="others"?"退出其他全部会话？":"退出此会话？"}
   className="sessions-confirm" onClose={()=>{if(!busy)setConfirm(null);}} closeGuard={()=>!busy}
   initialFocus=".sessions-confirm-cancel">
   <p>{confirm==="others"
    ?"其他全部登录会话将失效，当前会话保留。"
    :"该会话将失效，对方需重新登录。当前会话不受影响。"}</p>
   {target&&<div className="sessions-confirm-target">
    <strong>{target.device||"未知浏览器"}</strong>
    <span>{networkValue(target.address)} · {dateTime(target.createdAt)}</span>
   </div>}
   <div className="sessions-confirm-actions">
    <RareButton className="sessions-btn sessions-confirm-cancel" onClick={()=>setConfirm(null)} disabled={busy}>取消</RareButton>
    <RareButton tone="danger" className="sessions-btn sessions-danger" onClick={()=>void revoke()} loading={busy}>确认退出</RareButton>
   </div>
  </Dialog>}
 </AppShell>;
}
