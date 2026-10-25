import {useMemo,useState} from "react";
import {Link} from "react-router-dom";
import {RareButton,RareNotice} from "../shared/ui/rare";
import {BrandLoadingLabel} from "../shared/ui/BrandLoader";
import type {CDWInboxItem} from "../features/cdw/api";
import {DHFHomeProjects} from "./DHFHomeProjects";
import {workNeedsAction,workNextStep,type HomeView} from "./CDWWorkbenchHome";
import "./workbenchV2.css";

type Props={
 userName:string;items:CDWInboxItem[];appointmentCount:number;
 initiatedCount:number;initiatedHasMore:boolean;initiatedError:string;
 initiatedBusy:boolean;busy:boolean;error:string;canCreate:boolean;
 onCreate:()=>void;onRefresh:()=>void;onOpen:(item:CDWInboxItem)=>void;
 onView:(view:HomeView)=>void;
};
type Lane="all"|"reviews"|"tasks"|"receipts";
const kindNames:Record<CDWInboxItem["kind"],string>={
 task:"文件工作",obligation:"责任履行",review:"交付验收",formal:"正式审批",
 control:"发行准备",scope:"范围审批",receipt:"部门签收",reading:"阅读确认"
};
const stateNames:Record<string,string>={
 assigned:"待接收",accepted:"已接收",in_progress:"进行中",
 returned:"已退回",awaiting:"待核对",pending:"待处理",
 open:"处理中",frozen:"待审批",submitted:"待验收",opened:"待确认"
};
const itemKey=(item:CDWInboxItem)=>
 item.kind+":"+(item.obligationId??item.review?.gateId??item.formal?.id??
 item.candidate?.id??item.scope?.id??item.receipt?.targetId??
 item.reading?.id??item.taskId);
function laneOf(item:CDWInboxItem):Lane{
 if(item.kind==="review"||item.kind==="formal"||item.kind==="scope")return "reviews";
 if(item.kind==="receipt"||item.kind==="reading")return "receipts";
 return "tasks";
}
const urgentRank=(item:CDWInboxItem)=>item.state==="returned"?0:
 item.state==="awaiting"||item.state==="pending"?1:2;

export function WorkbenchCommandCenter({userName,items,appointmentCount,initiatedCount,
 initiatedHasMore,initiatedError,initiatedBusy,busy,error,canCreate,
 onCreate,onRefresh,onOpen,onView}:Props){
 const [lane,setLane]=useState<Lane>("all");
 const [showAll,setShowAll]=useState(false);
 const [createOpen,setCreateOpen]=useState(false);
 const todo=useMemo(()=>items.filter(workNeedsAction).sort((a,b)=>urgentRank(a)-urgentRank(b)),[items]);
 const following=items.filter(i=>!workNeedsAction(i));
 const returned=todo.filter(x=>x.state==="returned");
 const reviews=todo.filter(x=>laneOf(x)==="reviews");
 const tasks=todo.filter(x=>laneOf(x)==="tasks");
 const receipts=todo.filter(x=>laneOf(x)==="receipts");
 const shown=lane==="all"?todo:lane==="reviews"?reviews:lane==="tasks"?tasks:receipts;
 const visible=showAll?shown:shown.slice(0,10);
 const total=todo.length+appointmentCount;
 const categories:[Lane,string,number][]=[
  ["all","全部待办",total],["reviews","审批与验收",reviews.length+appointmentCount],
  ["tasks","工作与整改",tasks.length],["receipts","签收与阅读",receipts.length]
 ];
 const heading=lane==="all"?"今天需要处理的事项":categories.find(x=>x[0]===lane)?.[1]??"待处理事项";
 return <section className="wbv2-home" aria-label="工作台指挥中心">
  <header className="wbv2-hero">
   <div>
    <p className="wbv2-eyebrow">WORKBENCH / 个人工作空间</p>
    <h1>工作台 <span>· {userName}</span></h1>
    <p className="wbv2-hero-description">聚焦当前责任、验收阻断与正在推进的项目。每件事项直接进入办理流程。</p>
   </div>
   <div className="wbv2-hero-actions">
    <RareButton type="button" tone="ghost" disabled={busy} onClick={onRefresh}>刷新工作状态</RareButton>
    {canCreate?<RareButton type="button" tone="primary" aria-expanded={createOpen} onClick={()=>setCreateOpen(x=>!x)}>＋ 发起工作</RareButton>:null}
   </div>
  </header>
  {createOpen&&canCreate?<div className="wbv2-create-menu" role="region" aria-label="选择发起工作类型">
   <RareButton type="button" onClick={()=>{setCreateOpen(false);onCreate()}}>受控文件修订 <span>建立修订分支</span></RareButton>
   <Link to="/workbench/dhf?create=1" onClick={()=>setCreateOpen(false)}>DHF 研发项目 <span>创建阶段验收项目</span></Link>
   <Link to="/workbench/customer-registrations" onClick={()=>setCreateOpen(false)}>客户登记 <span>发起资质审批</span></Link>
  </div>:null}
  <div className="wbv2-metrics" aria-label="工作状态汇总">
   <RareButton type="button" className="wbv2-metric is-priority" onClick={()=>onView("todo")}>
    <span>待我处理</span><strong>{busy&&items.length===0?"…":total}</strong><small>进入我的工作队列</small>
   </RareButton>
   <RareButton type="button" className="wbv2-metric" onClick={()=>onView("initiated")}>
    <span>我发起的</span><strong>{initiatedError?"—":initiatedBusy&&initiatedCount===0?"…":initiatedCount}{initiatedHasMore&&!initiatedError?"+":""}</strong><small>查看流转和反馈</small>
   </RareButton>
   <RareButton type="button" className={"wbv2-metric"+(returned.length?" is-attention":"")} onClick={()=>{setLane("tasks");setShowAll(true);}}>
    <span>退回需整改</span><strong>{returned.length}</strong><small>优先处理退回事项</small>
   </RareButton>
   <RareButton type="button" className="wbv2-metric" onClick={()=>onView("following")}>
    <span>待其他人处理</span><strong>{following.length}</strong><small>观察进度与结果</small>
   </RareButton>
  </div>
  {(error||initiatedError)?<RareNotice tone="warning">
   部分工作信息未能载入：{error||initiatedError} <RareButton type="button" tone="ghost" onClick={onRefresh}>重试</RareButton>
  </RareNotice>:null}
  <div className="wbv2-dashboard">
   <main className="wbv2-primary">
    <div className="wbv2-section-heading">
     <div><p className="wbv2-eyebrow">ACTION CENTER</p><h2>{heading}</h2></div>
     <RareButton type="button" tone="ghost" onClick={()=>onView("todo")}>完整工作队列 →</RareButton>
    </div>
    <div className="wbv2-tabs" role="group" aria-label="待办任务分类">
     {categories.map(([key,label,count])=><RareButton key={key} type="button" tone="ghost"
      className={"wbv2-tab"+(lane===key?" is-active":"")} aria-pressed={lane===key}
      onClick={()=>{setLane(key);setShowAll(false)}}>{label}<span>{count}</span></RareButton>)}
    </div>
    {busy&&items.length===0?<div className="wbv2-loading"><BrandLoadingLabel showContext>读取工作中</BrandLoadingLabel></div>:
     shown.length===0&&(appointmentCount===0||lane==="tasks"||lane==="receipts")?
     <div className="wbv2-empty">
      <div className="wbv2-empty-check">✓</div>
      <h3>当前分类暂无待办</h3>
      <p>事项会在工作流派发、审批或验收后自动进入这里。</p>
      <div><RareButton type="button" tone="ghost" onClick={()=>onView("initiated")}>查看我发起的</RareButton>
       <Link to="/workbench/dhf">进入 DHF 项目</Link></div>
     </div>:
     <div className="wbv2-work-list" aria-live="polite">
      {visible.map(item=><RareButton type="button" key={itemKey(item)} className="wbv2-work-item" onClick={()=>onOpen(item)}>
       <span className={"wbv2-work-marker kind-"+item.kind}/>
       <span className="wbv2-work-description">
        <span className="wbv2-work-title">{item.title}</span>
        <span className="wbv2-work-next">{workNextStep(item)}</span>
       </span>
       <span className="wbv2-work-kind">{kindNames[item.kind]}</span>
       <span className={"wbv2-work-state"+(item.state==="returned"?" is-returned":"")}>{stateNames[item.state]??"查看状态"}</span>
       <span className="wbv2-work-arrow" aria-hidden="true">›</span>
      </RareButton>)}
      {appointmentCount>0&&(lane==="all"||lane==="reviews")?
       <RareButton type="button" className="wbv2-work-item" onClick={()=>onView("appointments")}>
        <span className="wbv2-work-marker kind-formal"/>
        <span className="wbv2-work-description"><span className="wbv2-work-title">任命资格与授权核验</span>
         <span className="wbv2-work-next">核对任命、资格和知悉通知</span></span>
        <span className="wbv2-work-kind">专项核验</span>
        <span className="wbv2-work-state">{appointmentCount} 项待处理</span>
        <span className="wbv2-work-arrow" aria-hidden="true">›</span>
       </RareButton>:null}
      {!showAll&&shown.length>visible.length?<RareButton type="button" tone="ghost" className="wbv2-more" onClick={()=>setShowAll(true)}>展开另外 {shown.length-visible.length} 项</RareButton>:null}
     </div>}
    <section className="wbv2-next-section" aria-label="流程快捷入口">
     <div className="wbv2-section-heading"><div><p className="wbv2-eyebrow">PROCESSES</p><h2>流程与决策</h2></div></div>
     <div className="wbv2-shortcuts">
      <Link to="/workbench?view=dhf-operations&gateTab=review"><strong>阶段签审</strong><span>待签审 · 冻结证据</span></Link>
      <Link to="/workbench?view=dhf-operations&gateTab=verification"><strong>整改复验</strong><span>责任闭环 · 复核记录</span></Link>
      <Link to="/workbench?view=dhf-operations&gateTab=gate"><strong>独立 Gate 复核</strong><span>阶段阻断与建议</span></Link>
      <Link to="/workbench?view=dhf-operations&gateTab=conditional"><strong>条件整改预案</strong><span>申请不等于批准</span></Link>
     </div>
    </section>
   </main>
   <aside className="wbv2-right-rail">
    <section className="wbv2-side-module">
     <div className="wbv2-side-heading"><strong>研发项目</strong><Link to="/workbench/dhf">进入项目 →</Link></div>
     <DHFHomeProjects canCreate={canCreate}/>
    </section>
    <section className="wbv2-side-module">
     <div className="wbv2-side-heading"><strong>知识与协作</strong><Link to="/workbench?view=knowledge">打开知识页 →</Link></div>
     <p>项目说明、研发记录、会议纪要与文件引用都留在工作台，不改变 Finder 文件管理。</p>
     <Link className="wbv2-knowledge-entry" to="/workbench?view=knowledge"><span>▤</span><span><strong>项目知识页面</strong><small>页面树 · 内容块 · 修订历史</small></span><span>›</span></Link>
    </section>
    <section className="wbv2-side-module wbv2-guidance">
     <div className="wbv2-side-heading"><strong>我的处理原则</strong></div>
     <p>先处理明确分配给自己的工作，再跟踪提交后的审批和复验。独立复核不替代正式批准。</p>
     <RareButton type="button" tone="ghost" onClick={()=>onView("following")}>查看等待中的事项 →</RareButton>
    </section>
   </aside>
  </div>
 </section>;
}
