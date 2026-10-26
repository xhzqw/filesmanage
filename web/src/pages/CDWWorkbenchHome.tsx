import {useState} from "react";
import {Link} from "react-router-dom";
import {RareButton,RareNotice} from "../shared/ui/rare";
import {BrandLoadingLabel} from "../shared/ui/BrandLoader";
import type {CDWInboxItem} from "../features/cdw/api";
import type {Project} from "../features/projects/api";

export type HomeView="home"|"todo"|"initiated"|"following"|"tasks"|"obligations"|"reviews"|"formal"|"appointments"|"control"|"scope"|"receipts"|"reading"|"effective"|"all"|"seals";
type Props={items:CDWInboxItem[];projects:Project[];appointmentCount:number;initiatedCount:number;initiatedHasMore:boolean;initiatedError:string;initiatedBusy:boolean;busy:boolean;error:string;canCreate:boolean;
 onCreate:()=>void;onRefresh:()=>void;onOpen:(item:CDWInboxItem)=>void;onView:(view:HomeView)=>void};
export function workNeedsAction(item:CDWInboxItem):boolean{
 switch(item.kind){
  case "task":return ["assigned","accepted","in_progress","returned"].includes(item.state);
  case "obligation":return ["pending","open"].includes(item.state);
  case "review":return item.state==="awaiting";
  case "formal":return item.state==="pending";
  case "control":return true;
  case "scope":return item.state==="frozen";
  case "receipt":return item.state==="awaiting";
  case "reading":return ["assigned","opened"].includes(item.state);
 }
}
const kinds:Record<CDWInboxItem["kind"],string>={task:"文件工作",obligation:"责任履行",review:"交付验收",
 formal:"正式审批",control:"发行准备",scope:"范围审批",receipt:"部门签收",reading:"阅读确认"};
export function workNextStep(item:CDWInboxItem):string{
 switch(item.kind){
  case "task":
   if(item.state==="assigned")return "接收工作，确认交付要求";
   if(item.state==="returned")return "查看退回意见，继续修订";
   if(["accepted","in_progress"].includes(item.state))return "编辑工作分支，或派发下级工作";
   if(item.state==="submitted")return "已提交交付，等待上级验收";
   if(item.state==="accepted_delivery")return "交付已验收，后续审批独立进行";
   return "查看工作状态和交付记录";
  case "obligation":return "完成当前责任并留存履行凭据";
  case "review":return "核对冻结交付稿，决定验收或退回";
  case "formal":return "核查审批依据，处理当前审批";
  case "control":return "核对已批准稿，准备受控发行";
  case "scope":return "核对分发范围，作出审批决定";
  case "receipt":return "核对受控版本，主动完成部门签收";
  case "reading":return "阅读受控文件，主动确认";
 }
}
function itemKey(item:CDWInboxItem){
 return item.kind+":"+(item.obligationId??item.review?.gateId??item.formal?.id??item.candidate?.id??item.scope?.id??item.receipt?.targetId??item.reading?.id??item.taskId);
}
export function CDWWorkbenchHome({items,projects,appointmentCount,initiatedCount,initiatedHasMore,initiatedError,initiatedBusy,busy,error,canCreate,onCreate,onRefresh,onOpen,onView}:Props){
 const[expanded,setExpanded]=useState(false);
 const[chooseKind,setChooseKind]=useState(false);
 const todo=items.filter(workNeedsAction);
 const display=expanded?todo:todo.slice(0,8);
 const recentProjects=projects.filter(p=>!p.archived).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,6);

 return <section className="cdw-home" aria-label="工作首页">
  <header className="cdw-home-toolbar">
   <div className="cdw-home-identity">
    <div className="cdw-home-heading">
     <h2>工作台</h2>
    </div>
   </div>
   <div className="cdw-home-actions">
    <RareButton type="button" tone="ghost" disabled={busy} onClick={onRefresh}>刷新</RareButton>
    {canCreate&&<RareButton type="button" tone="primary" aria-expanded={chooseKind} onClick={()=>setChooseKind(v=>!v)}>+ 发起工作</RareButton>}
   </div>
  </header>
  {chooseKind&&canCreate&&<div className="cdw-home-chooser" role="region" aria-label="发起工作类型">
   <div className="cdw-home-chooser-intro">
    <strong>发起工作事项</strong>
   </div>
   <div className="cdw-home-chooser-options">
    <RareButton type="button" tone="neutral" onClick={()=>{setChooseKind(false);onCreate();}}>
     <strong>受控文件修订</strong>
     <small>建立 DOCX 修订分支</small>
    </RareButton>
    <Link to="/workbench/dhf?create=1" onClick={()=>setChooseKind(false)}>
     <strong>DHF 阶段项目</strong>
     <small>创建研发项目并指定验收人</small>
    </Link>
    <Link to="/workbench/customer-registrations" onClick={()=>setChooseKind(false)}>
     <strong>客户建档审批</strong>
     <small>提交客户资质审核</small>
    </Link>
   </div>
  </div>}
  <div className="cdw-home-scroll">
   <div className="cdw-home-stats cdw-home-stats-compact" aria-label="工作概况">
    <RareButton type="button" className="cdw-home-stat is-todo" onClick={()=>onView("todo")}>
     <div className="cdw-stat-top">
      <span className="cdw-stat-dot dot-amber"/>
      <small>待我处理</small>
     </div>
     <strong>{todo.length+appointmentCount}</strong>
    </RareButton>
    <RareButton type="button" className="cdw-home-stat is-initiated" onClick={()=>onView("initiated")}>
     <div className="cdw-stat-top">
      <span className="cdw-stat-dot dot-blue"/>
      <small>我发起的</small>
     </div>
     <strong>{initiatedError?"—":initiatedBusy&&initiatedCount===0?"…":initiatedCount}{!initiatedError&&initiatedHasMore?"+":""}</strong>
    </RareButton>
   </div>
   {(error||initiatedError)&&<RareNotice tone="warning">部分工作数据暂时无法读取。{error||initiatedError} <RareButton type="button" onClick={onRefresh}>重试</RareButton></RareNotice>}
   {recentProjects.length>0&&<section className="cdw-home-pages" aria-label="最近项目">
    <div className="cdw-home-pages-head"><strong>最近项目</strong><Link to="/workbench?view=projects">查看全部</Link></div>
    <div className="cdw-home-pages-list">
     {recentProjects.map(project=><Link key={project.id} className="cdw-home-page-link" to={"/workbench?view=projects&page="+project.id} title={project.name}>
      <span className="cdw-home-page-icon" aria-hidden="true">{project.icon}</span>
      <span className="cdw-home-page-name">{project.name}</span>
      <small>{project.status==="done"?"已完成":project.status==="progress"?"进行中":"未开始"}</small>
     </Link>)}
    </div>
   </section>}
   <div className="cdw-home-content">
    <div className="cdw-home-primary">
     <div className="cdw-home-section-head">
      <strong>待我处理</strong>
      <RareButton type="button" tone="ghost" onClick={()=>onView("todo")}>查看全部</RareButton>
     </div>
     {busy&&items.length===0?<div className="cdw-home-loading"><BrandLoadingLabel showContext>读取工作中</BrandLoadingLabel></div>:
     todo.length===0&&appointmentCount===0?<div className="cdw-home-empty-card">
      <div className="cdw-home-empty-top">
       <div className="cdw-home-empty-icon" aria-hidden="true">✓</div>
       <div className="cdw-home-empty-text">
        <strong>待办事项均已处理完成</strong>
        <p>当前暂无需要处理的审批或流转任务</p>
       </div>
      </div>
     </div>:<div className="cdw-home-work-list">
      {display.map(item=><RareButton type="button" key={itemKey(item)} className="cdw-home-work-row" onClick={()=>onOpen(item)}>
       <span className={"cdw-task-symbol cdw-kind-"+item.kind} aria-hidden="true"/>
       <span className="cdw-home-work-copy">
        <div className="cdw-home-work-title-row">
         <strong title={item.title}>{item.title}</strong>
         <span className="cdw-kind-badge">{kinds[item.kind]}</span>
         <span className={"cdw-status-badge state-"+item.state}>
          {item.state==="returned"?"已退回":item.state==="assigned"?"待接收":item.state==="awaiting"?"待验收":"待处理"}
         </span>
        </div>
        <span className="cdw-home-work-sub">{workNextStep(item)}</span>
       </span>
       <span className="cdw-home-work-go">办理 →</span>
      </RareButton>)}
      {appointmentCount>0&&<RareButton type="button" className="cdw-home-work-row" onClick={()=>onView("appointments")}>
       <span className="cdw-task-symbol cdw-kind-formal" aria-hidden="true"/>
       <span className="cdw-home-work-copy">
        <div className="cdw-home-work-title-row">
         <strong>岗位任命、授权与通知</strong>
         <span className="cdw-kind-badge">专项核验</span>
         <span className="cdw-status-badge state-awaiting">待核验</span>
        </div>
        <span className="cdw-home-work-sub">{appointmentCount} 项需核验资格或知悉通知</span>
       </span>
       <span className="cdw-home-work-go">办理 →</span>
      </RareButton>}
      {!expanded&&todo.length>display.length&&<RareButton type="button" tone="ghost" className="cdw-home-more" onClick={()=>setExpanded(true)}>展开其余 {todo.length-display.length} 项</RareButton>}
     </div>}
    </div>
   </div>
  </div>
 </section>;
}
