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

const dateFormatter=new Intl.DateTimeFormat("zh-CN",{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"});
const shortFormatter=new Intl.DateTimeFormat("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"});
function dateTime(value:string):string{
 const date=new Date(value);
 return Number.isFinite(date.getTime())?dateFormatter.format(date):"未记录";
}
function shortTime(value:string):string{
 const date=new Date(value);
 return Number.isFinite(date.getTime())?shortFormatter.format(date):"未记录";
}
function networkValue(value?:string){return value?.trim()||"未获取";}
function sessionKey(row:DeviceSession){return JSON.stringify([row.device||"",row.address||"",row.macAddress||""]);}
function DeviceIcon({device}:{device:string}){
 const mobile=/iphone|ipad|android|ios/i.test(device);
 return <span className="sessions-device-icon" aria-hidden="true">
  {mobile?<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
   <rect x="7.2" y="2.6" width="9.6" height="18.8" rx="2.2"/><path d="M10.4 18.3h3.2"/>
  </svg>:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
   <rect x="3" y="4" width="18" height="13.5" rx="2"/><path d="M8 21h8M12 17.5V21"/>
  </svg>}
 </span>;
}
function Chevron({open=false}:{open?:boolean}){
 return <svg className={"sessions-chevron"+(open?" is-open":"")} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <path d="m9 18 6-6-6-6"/>
 </svg>;
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
function activityTitle(event:AuthActivity){
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
 const [view,setView]=useState<"sessions"|"activity">("sessions");
 const [currentDetails,setCurrentDetails]=useState(false);
 const [expanded,setExpanded]=useState<Record<string,boolean>>({});
 const [allRows,setAllRows]=useState<Record<string,boolean>>({});
 const [auditLimit,setAuditLimit]=useState(10);

 const refresh=useCallback(async()=>{
  setRefreshing(true);
  try{
   const [sessionResult,activityResult]=await Promise.allSettled([sessionApi.list(),sessionApi.activity()]);
   if(sessionResult.status==="fulfilled"){setSessions(sessionResult.value);setError("");}
   else setError("无法获取登录会话，请检查网络后重试。");
   if(activityResult.status==="fulfilled"){setActivity(activityResult.value);setActivityError(false);}
   else setActivityError(true);
  }finally{setLoading(false);setRefreshing(false);}
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
   const key=sessionKey(session),group=map.get(key);
   if(group){group.items.push(session);}
   else map.set(key,{key,device:session.device||"未知浏览器",address:session.address,
    mac:session.macAddress||"",items:[session]});
  }
  return [...map.values()];
 },[others]);
 const target=confirm&&confirm!=="others"?others.find(row=>row.id===confirm):undefined;

 async function revoke(){
  if(!confirm||busy)return;
  setBusy(true);setError("");
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
       <p>管理当前会话、其他登录与安全记录</p>
      </div>
      <div className="sessions-heading-actions">
       <Link to="/doc" className="sessions-back">返回文档</Link>
       <RareButton className="sessions-refresh" aria-label="刷新登录会话与安全记录" title="刷新" onClick={()=>void refresh()} disabled={refreshing||busy}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
         <path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M5.7 9a7 7 0 0 1 12.3-1.4L20 12M4 12l2 4.4A7 7 0 0 0 18.3 15"/>
        </svg>
       </RareButton>
      </div>
     </header>
     {error&&<p className="sessions-alert" role="alert">{error}</p>}

     <section className="sessions-current" aria-labelledby="sessions-current-title">
      <div className="sessions-current-main">
       <div className="sessions-current-icon"><DeviceIcon device={current?.device??""}/></div>
       <div className="sessions-current-copy">
        <div className="sessions-current-title">
         <h2 id="sessions-current-title">当前会话</h2>
         {current&&<span className="sessions-live-dot" aria-label="正在使用"/>}
        </div>
        {loading?<p>正在获取设备信息…</p>:
         current?<p><strong>{current.device||"未知浏览器"}</strong><span className="sessions-inline-dot">·</span> IP {networkValue(current.address)}
          <span className="sessions-inline-dot">·</span> MAC {networkValue(current.macAddress)}</p>:
         <p>{error?"无法确认当前会话":"当前会话暂未显示，请刷新核对。"}</p>}
       </div>
       {current&&<RareButton type="button" className="sessions-current-details-trigger" aria-expanded={currentDetails}
        onClick={()=>setCurrentDetails(v=>!v)}>
        {currentDetails?"收起":"详情"}<Chevron open={currentDetails}/>
       </RareButton>}
      </div>
      {current&&currentDetails&&<div className="sessions-current-details"><SessionFacts session={current}/></div>}
     </section>

     <div className="sessions-toolbar">
      <div className="sessions-segmented" role="tablist" aria-label="账号安全视图">
       <RareButton type="button" role="tab" id="sessions-tab-list" aria-controls="sessions-tabpanel-list"
        aria-selected={view==="sessions"} className={"sessions-tab"+(view==="sessions"?" is-active":"")}
        onClick={()=>setView("sessions")}>登录会话 <span className="sessions-tab-count">{others.length}</span></RareButton>
       <RareButton type="button" role="tab" id="sessions-tab-activity" aria-controls="sessions-tabpanel-activity"
        aria-selected={view==="activity"} className={"sessions-tab"+(view==="activity"?" is-active":"")}
        onClick={()=>setView("activity")}>安全记录 <span className="sessions-tab-count">{activity.length}</span></RareButton>
      </div>
      {view==="sessions"&&<RareButton type="button" tone="danger" className="sessions-revoke-all"
       disabled={busy||refreshing||others.length===0} onClick={()=>setConfirm("others")}>退出其他全部会话</RareButton>}
     </div>

     <section className="sessions-content" role="tabpanel" id="sessions-tabpanel-list" aria-labelledby="sessions-tab-list" hidden={view!=="sessions"}>
      <div className="sessions-content-intro">
       <span>{groups.length} 组来源 · {others.length} 个其他会话</span>
       <span>相同来源不代表同一实体设备</span>
      </div>
      {loading?<p className="sessions-empty">正在获取会话…</p>:
       others.length===0?<div className="sessions-zero">
        <span className="sessions-zero-icon" aria-hidden="true">✓</span>
        <strong>没有其他登录会话</strong><p>只有当前连接处于登录状态</p>
       </div>:
       <div className="sessions-groups">{groups.map(group=>{
        const open=expanded[group.key]??false;
        const showAll=allRows[group.key]??false;
        const shown=open?(showAll?group.items:group.items.slice(0,5)):[];
        return <div className={"sessions-group"+(open?" is-expanded":"")} key={group.key}>
         <RareButton type="button" className="sessions-group-toggle" aria-expanded={open}
          onClick={()=>setExpanded(prev=>({...prev,[group.key]:!open}))}>
          <DeviceIcon device={group.device}/>
          <span className="sessions-group-copy">
           <span className="sessions-group-title">{group.device}<span className="sessions-group-count">{group.items.length} 个会话</span></span>
           <span className="sessions-group-meta">IP {networkValue(group.address)} <span>·</span> MAC {networkValue(group.mac)}</span>
          </span>
          <span className="sessions-group-recent">最近 {shortTime(group.items[0]?.lastSeenAt??"")}</span>
          <Chevron open={open}/>
         </RareButton>
         {open&&<div className="sessions-expand-content">
          <ul className="sessions-detail-list">{shown.map(row=><li key={row.id} className="sessions-detail-item">
           <div className="sessions-detail-top">
            <span className="sessions-detail-time">登录于 {dateTime(row.createdAt)}</span>
            <RareButton type="button" tone="danger" className="sessions-row-revoke" disabled={busy||refreshing}
             onClick={()=>setConfirm(row.id)}>退出此会话</RareButton>
           </div>
           <SessionFacts session={row}/>
          </li>)}</ul>
          {group.items.length>5&&<RareButton type="button" className="sessions-show-more"
           onClick={()=>setAllRows(prev=>({...prev,[group.key]:!showAll}))}>
           {showAll?"收起其余记录":"查看剩余 "+(group.items.length-5)+" 条会话"} <Chevron open={showAll}/>
          </RareButton>}
         </div>}
        </div>;
       })}</div>}
     </section>
     <section className="sessions-content sessions-audit-content" role="tabpanel" id="sessions-tabpanel-activity" aria-labelledby="sessions-tab-activity" hidden={view!=="activity"}>
      <div className="sessions-content-intro"><span>最近安全操作</span><span>保留最近 30 条记录</span></div>
      {activityError?<p className="sessions-audit-error" role="status">记录获取失败，请刷新后重试。</p>:
       activity.length===0?<div className="sessions-zero"><strong>暂无安全记录</strong><p>登录及会话撤销记录会显示在这里</p></div>:
       <ol className="sessions-audit">{activity.slice(0,auditLimit).map((event,i)=><li key={event.occurredAt+"-"+i}>
        <div className={"sessions-audit-mark"+(event.outcome==="denied"?" is-danger":"")} aria-hidden="true"/>
        <div className="sessions-audit-content">
         <div className="sessions-audit-head">
          <strong>{activityTitle(event)}{typeof event.count==="number"&&event.count>0?" · "+event.count+" 个会话":""}</strong>
          <time dateTime={event.occurredAt}>{dateTime(event.occurredAt)}</time>
         </div>
         {(event.device||event.address||event.macAddress)&&<p>
          {[event.device,event.address?"IP "+event.address:"",event.macAddress?"MAC "+event.macAddress:""].filter(Boolean).join(" · ")}
         </p>}
        </div>
       </li>)}</ol>}
      {activity.length>auditLimit&&<RareButton className="sessions-audit-more" onClick={()=>setAuditLimit(x=>x+10)}>
       再显示 {Math.min(10,activity.length-auditLimit)} 条 <Chevron open/>
      </RareButton>}
     </section>
     <p className="sessions-footnote">MAC 仅在服务器能识别局域网邻居时记录，无法获取时不会推测设备身份。</p>
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
