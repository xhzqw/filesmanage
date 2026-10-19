import {useMemo,useState} from "react";
import {Link} from "react-router-dom";
import {RareButton,RareInput,RareNotice,RareBadge} from "../shared/ui/rare";
import type {CDWInitiatedItem} from "../features/cdw/api";
import {CDWInitiatedEventTimeline} from "./CDWInitiatedEventTimeline";

const status:Record<string,string>={draft:"待派发",assigned:"待接收",accepted:"已接收",in_progress:"正在修订",submitted:"等待验收",accepted_delivery:"交付已验收",returned:"已退回",declined:"已拒绝",closed:"已关闭",cancelled:"已取消"};
const explanation:Record<string,string>={assigned:"等待负责人接收工作并确认交付范围。",accepted:"负责人已接收，正在准备工作分支。",in_progress:"负责人正在修订文件，尚未提交正式交付。",submitted:"冻结交付稿正在等待上级验收，并不代表正式批准。",accepted_delivery:"本轮交付已验收；正式审批、发行与生效是独立流程。",returned:"交付未通过验收，需要负责人根据退回意见修订。",cancelled:"本项工作已经取消。",closed:"本项工作已经关闭。"};
const localTime=(s:string)=>{const d=new Date(s);return Number.isNaN(d.getTime())?"时间待核验":d.toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false})+"（北京时间）"};
export function CDWInitiatedWorkspace({items,busy,error,nextCursor,onMore,onRefresh}:{items:CDWInitiatedItem[];busy:boolean;error:string;nextCursor:string;onMore:()=>void;onRefresh:()=>void}){
 const[query,setQuery]=useState("");
 const[chosen,setChosen]=useState("");
 const visible=useMemo(()=>items.filter(x=>[x.title,x.assigneeName,x.state].join(" ").toLowerCase().includes(query.trim().toLowerCase())),[items,query]);
 const selected=visible.find(x=>x.taskId===chosen)??visible[0];
 return <section className="cdw-initiated" aria-label="我发起的工作">
  <div className="cdw-initiated-list">
   <header className="cdw-initiated-head"><span><strong>我发起的工作</strong><small>按发起时间排序，包含已结束的工作</small></span>
    <RareButton type="button" tone="ghost" disabled={busy} onClick={onRefresh}>刷新</RareButton></header>
   <div className="cdw-initiated-search"><RareInput type="search" aria-label="筛选我发起的工作" placeholder="筛选已加载的工作…" value={query} onChange={e=>setQuery(e.target.value)}/></div>
   {error&&<RareNotice tone="warning">{error}<RareButton type="button" onClick={onRefresh}>重试</RareButton></RareNotice>}
   <div className="cdw-initiated-scroll">
    {visible.map(item=><RareButton key={item.taskId} type="button" className={"cdw-initiated-row"+(selected?.taskId===item.taskId?" is-selected":"")} onClick={()=>setChosen(item.taskId)}>
     <span className="cdw-initiated-row-copy"><small>{item.parentId?"下级工作":"主工作"} · {status[item.state]??"状态待确认"}</small><strong title={item.title}>{item.title}</strong>
     <span>负责人：{item.assigneeName||"暂无负责人"}</span></span><span aria-hidden="true">›</span></RareButton>)}
    {!busy&&visible.length===0&&<div className="cdw-initiated-empty"><strong>{query?"没有匹配的工作":"暂无可以查看的发起记录"}</strong>
     <p>{query?"筛选仅针对已加载的记录。":"失去文件查看权限的历史工作不会在此显示。"}</p></div>}
    {nextCursor&&<RareButton type="button" tone="ghost" className="cdw-initiated-more" disabled={busy} onClick={onMore}>{busy?"正在加载…":"加载更早的工作"}</RareButton>}
    <div className="cdw-initiated-summary">已加载 {items.length} 项{nextCursor?" · 更多记录可继续加载":""}</div>
   </div>
  </div>
  <div className="cdw-initiated-detail">{selected?<div className="cdw-initiated-detail-inner">
    <header className="cdw-initiated-detail-title"><small>发起工作跟进</small><h2>{selected.title}</h2>
     <RareBadge tone={selected.state==="returned"?"warning":selected.state==="accepted_delivery"?"success":"info"}>{status[selected.state]??"状态待确认"}</RareBadge></header>
    <section className="cdw-initiated-highlight"><strong>当前进度</strong><p>{explanation[selected.state]??"请结合工作记录核查当前处理进度。"}</p></section>
    <div className="cdw-initiated-facts"><div><span>当前负责人</span><strong>{selected.assigneeName||"暂无负责人"}</strong></div>
     <div><span>工作层级</span><strong>{selected.parentId?"下级派发":"主工作"}</strong></div>
     <div><span>发起时间</span><strong>{localTime(selected.createdAt)}</strong></div>
     <div><span>工作状态</span><strong>{status[selected.state]??"待核验"}</strong></div></div>
    <CDWInitiatedEventTimeline key={selected.taskId} taskId={selected.taskId}/>
    <div className="cdw-initiated-links"><Link to={"/preview/"+encodeURIComponent(selected.fileId)}>查看关联文件 →</Link>
     <span>查看发起进度不等于拥有编辑、验收或代签权限。</span></div>
   </div>:<div className="cdw-detail-empty"><strong>选择工作记录</strong><p>查看负责人和当前处理进度。</p></div>}</div>
 </section>;
}
