import {useState} from "react";
import {Link} from "react-router-dom";
import {RareButton,RareNotice} from "../shared/ui/rare";
import {BrandLoadingLabel} from "../shared/ui/BrandLoader";
import type {CDWInboxItem} from "../features/cdw/api";
import {DHFHomeProjects} from "./DHFHomeProjects";

export type HomeView="todo"|"initiated"|"following"|"all"|"appointments"|"reviews"|"receipts"|"tasks"|"seals";
type Props={items:CDWInboxItem[];appointmentCount:number;initiatedCount:number;initiatedHasMore:boolean;initiatedError:string;initiatedBusy:boolean;busy:boolean;error:string;canCreate:boolean;
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
export function CDWWorkbenchHome({items,appointmentCount,initiatedCount,initiatedHasMore,initiatedError,initiatedBusy,busy,error,canCreate,onCreate,onRefresh,onOpen,onView}:Props){
 const[expanded,setExpanded]=useState(false);
 const[chooseKind,setChooseKind]=useState(false);
 const[activeCategory,setActiveCategory]=useState<"all"|"tasks"|"reviews"|"receipts">("all");
 const todo=items.filter(workNeedsAction);
 const following=items.filter(item=>!workNeedsAction(item));
 const returned=todo.filter(item=>item.state==="returned");
 const reviewTasks=todo.filter(item=>item.kind==="review"||item.kind==="formal"||item.kind==="scope");
 const workTasks=todo.filter(item=>item.kind==="task"||item.kind==="obligation");
 const receiptTasks=todo.filter(item=>item.kind==="receipt"||item.kind==="reading");
 const filteredTodo=activeCategory==="tasks"?workTasks:activeCategory==="reviews"?reviewTasks:activeCategory==="receipts"?receiptTasks:todo;
 const display=expanded?filteredTodo:filteredTodo.slice(0,8);

 return <section className="cdw-home" aria-label="工作首页">
  <header className="cdw-home-toolbar">
   <div className="cdw-home-identity">
    <div className="cdw-home-heading">
     <h2>工作台</h2>
     <span className="cdw-home-badge">中晟生物 · 协同中心</span>
    </div>
   </div>
   <div className="cdw-home-actions">
    <RareButton type="button" tone="ghost" disabled={busy} onClick={onRefresh}>刷新</RareButton>
    {canCreate&&<RareButton type="button" tone="primary" aria-expanded={chooseKind} onClick={()=>setChooseKind(v=>!v)}>+ 发起工作</RareButton>}
   </div>
  </header>
  {chooseKind&&canCreate&&<div className="cdw-home-chooser" role="region" aria-label="发起工作类型">
   <div className="cdw-home-chooser-intro">
    <strong>选择要发起的工作事项</strong>
    <small>依据质量管理体系程序文件（QP-01 / QP-09）开展业务</small>
   </div>
   <div className="cdw-home-chooser-options">
    <RareButton type="button" tone="neutral" onClick={()=>{setChooseKind(false);onCreate();}}>
     <strong>受控文件修订工作</strong>
     <small>选择 DOCX 文件建立工作分支，按受控流程管理</small>
    </RareButton>
    <Link to="/workbench/dhf?create=1" onClick={()=>setChooseKind(false)}>
     <strong>DHF 九阶段文件验收</strong>
     <small>按既定阶段大纲创建研发项目，指定独立验收人</small>
    </Link>
    <Link to="/workbench/customer-registrations" onClick={()=>setChooseKind(false)}>
     <strong>客户建档与登记审批</strong>
     <small>提交客户档案审核与资质登记</small>
    </Link>
   </div>
  </div>}
  <div className="cdw-home-scroll">
   <div className="cdw-home-stats" aria-label="工作概况">
    <RareButton type="button" className="cdw-home-stat is-todo" onClick={()=>onView("todo")}>
     <div className="cdw-stat-top">
      <span className="cdw-stat-dot dot-amber"/>
      <small>待我处理</small>
     </div>
     <strong>{todo.length+appointmentCount}</strong>
     <span className="cdw-stat-hint">待审批 / 验收 / 签收</span>
    </RareButton>
    <RareButton type="button" className="cdw-home-stat is-initiated" onClick={()=>onView("initiated")}>
     <div className="cdw-stat-top">
      <span className="cdw-stat-dot dot-blue"/>
      <small>我发起的</small>
     </div>
     <strong>{initiatedError?"—":initiatedBusy&&initiatedCount===0?"…":initiatedCount}{!initiatedError&&initiatedHasMore?"+":""}</strong>
     <span className="cdw-stat-hint">进行中的工作与流转</span>
    </RareButton>
    <RareButton type="button" className="cdw-home-stat is-following" onClick={()=>onView("following")}>
     <div className="cdw-stat-top">
      <span className="cdw-stat-dot dot-purple"/>
      <small>无需立即处理</small>
     </div>
     <strong>{following.length}</strong>
     <span className="cdw-stat-hint">已提交或观察中事项</span>
    </RareButton>
    <RareButton type="button" className="cdw-home-stat is-returned" onClick={()=>onView("todo")}>
     <div className="cdw-stat-top">
      <span className="cdw-stat-dot dot-rose"/>
      <small>退回需修订</small>
     </div>
     <strong>{returned.length}</strong>
     <span className="cdw-stat-hint">需重新修改提交</span>
    </RareButton>
   </div>
   {(error||initiatedError)&&<RareNotice tone="warning">部分工作数据暂时无法读取。{error||initiatedError} <RareButton type="button" onClick={onRefresh}>重试</RareButton></RareNotice>}
   <DHFHomeProjects canCreate={canCreate}/>
   <div className="cdw-home-content">
    <div className="cdw-home-primary">
     <div className="cdw-home-section-head">
      <div className="cdw-home-filter-tabs">
       <RareButton type="button" tone="ghost" className={activeCategory==="all"?"active":""} onClick={()=>setActiveCategory("all")}>
        全部待办 ({todo.length+appointmentCount})
       </RareButton>
       <RareButton type="button" tone="ghost" className={activeCategory==="reviews"?"active":""} onClick={()=>setActiveCategory("reviews")}>
        审查与审批 ({reviewTasks.length+appointmentCount})
       </RareButton>
       <RareButton type="button" tone="ghost" className={activeCategory==="tasks"?"active":""} onClick={()=>setActiveCategory("tasks")}>
        文件工作 ({workTasks.length})
       </RareButton>
       <RareButton type="button" tone="ghost" className={activeCategory==="receipts"?"active":""} onClick={()=>setActiveCategory("receipts")}>
        签收与阅读 ({receiptTasks.length})
       </RareButton>
      </div>
      <RareButton type="button" tone="ghost" onClick={()=>onView("todo")}>进入队列视图 →</RareButton>
     </div>
     {busy&&items.length===0?<div className="cdw-home-loading"><BrandLoadingLabel showContext>读取工作中</BrandLoadingLabel></div>:
     todo.length===0&&appointmentCount===0?<div className="cdw-home-empty-card">
      <div className="cdw-home-empty-icon" aria-hidden="true">✓</div>
      <div className="cdw-home-empty-text">
       <strong>当前待办事项均已处理完成</strong>
       <p>没有需要立即处理的审批或流转任务，可以从下方快捷发起业务事项</p>
      </div>
      <div className="cdw-home-quick-actions">
       {canCreate&&<RareButton type="button" tone="primary" onClick={onCreate}>发起文件修订工作</RareButton>}
       <Link to="/workbench/dhf?create=1" className="cdw-quick-link">创建 DHF 项目</Link>
       <RareButton type="button" tone="ghost" onClick={()=>onView("initiated")}>查看我发起的工作 ↗</RareButton>
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
      {!expanded&&filteredTodo.length>display.length&&<RareButton type="button" tone="ghost" className="cdw-home-more" onClick={()=>setExpanded(true)}>展开其余 {filteredTodo.length-display.length} 项</RareButton>}
     </div>}
    </div>
    <aside className="cdw-home-guide" aria-label="快捷入口">
     <div className="cdw-home-quick">
      <strong>常用业务入口</strong>
      <RareButton type="button" tone="ghost" onClick={()=>onView("initiated")}>我发起的 <span>↗</span></RareButton>
      <RareButton type="button" tone="ghost" onClick={()=>onView("tasks")}>文件工作 <span>↗</span></RareButton>
      <RareButton type="button" tone="ghost" onClick={()=>onView("reviews")}>交付验收 <span>↗</span></RareButton>
      <RareButton type="button" tone="ghost" onClick={()=>onView("receipts")}>部门签收 <span>↗</span></RareButton>
      <RareButton type="button" tone="ghost" onClick={()=>onView("seals")}>电子签章中心 <span>↗</span></RareButton>
      <Link to="/workbench/dhf">DHF 九阶段验收 <span>↗</span></Link>
      <Link to="/workbench/customer-registrations">客户登记审批 <span>↗</span></Link>
     </div>
    </aside>
   </div>
  </div>
 </section>;
}
