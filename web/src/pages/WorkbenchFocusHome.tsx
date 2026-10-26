import {useEffect,useMemo,useState} from "react";
import {Link} from "react-router-dom";
import type {CDWInboxItem} from "../features/cdw/api";
import {workflowApi} from "../features/workflow/api";
import {request} from "../shared/http";
import {RareButton,RareNotice} from "../shared/ui/rare";
import {BrandLoadingLabel} from "../shared/ui/BrandLoader";
import {workNeedsAction,workNextStep,type HomeView} from "./CDWWorkbenchHome";
import "./workbenchFocus.css";

type Props={
 userName:string;items:CDWInboxItem[];appointmentCount:number;
 initiatedCount:number;initiatedHasMore:boolean;initiatedError:string;
 initiatedBusy:boolean;busy:boolean;error:string;canCreate:boolean;
 onCreate:()=>void;onRefresh:()=>void;onOpen:(item:CDWInboxItem)=>void;
 onView:(view:HomeView)=>void;
};
type Scope="all"|"file"|"approval"|"dhf";
const keyOf=(item:CDWInboxItem)=>item.kind+":"+
 (item.obligationId??item.review?.gateId??item.formal?.id??item.candidate?.id??
 item.scope?.id??item.receipt?.targetId??item.reading?.id??item.taskId);
const rank=(item:CDWInboxItem)=>item.state==="returned"?0:
 item.state==="awaiting"||item.state==="pending"?1:2;

export function WorkbenchFocusHome(props:Props){
 const {items,appointmentCount,busy,error,initiatedError,initiatedCount,
  initiatedBusy,initiatedHasMore,onRefresh,onOpen,onView,onCreate,canCreate}=props;
 const [scope,setScope]=useState<Scope>("all");
 const [createOpen,setCreateOpen]=useState(false);
 const [reload,setReload]=useState(0);
 const [counts,setCounts]=useState<{approval:number|null;dhf:number|null}>({approval:null,dhf:null});
 useEffect(()=>{
  let active=true;
  void workflowApi.approvalsPage("inbox","",1)
   .then(data=>{if(active)setCounts(c=>({...c,approval:data.pendingCount}))})
   .catch(()=>{if(active)setCounts(c=>({...c,approval:null}))});
  void request<{items:Array<unknown>}>("/workbench/dhf/tasks")
   .then(data=>{if(active)setCounts(c=>({...c,dhf:data.items?.length??0}))})
   .catch(()=>{if(active)setCounts(c=>({...c,dhf:null}))});
  return()=>{active=false};
 },[reload]);
 const todo=useMemo(()=>items.filter(workNeedsAction).sort((a,b)=>rank(a)-rank(b)),[items]);
 const fileWork=todo.length+appointmentCount;
 const followUp=items.length-todo.length;
 const refresh=()=>{setReload(v=>v+1);onRefresh()};
 const scopes:{id:Scope;label:string;count:number|null}[]=[
  {id:"all",label:"全部",count:null},
  {id:"file",label:"文件工作",count:fileWork},
  {id:"approval",label:"审批",count:counts.approval},
  {id:"dhf",label:"DHF",count:counts.dhf}
 ];
 const showFile=scope==="all"||scope==="file";
 const showApproval=scope==="all"||scope==="approval";
 const showDHF=scope==="all"||scope==="dhf";
 const showApprovalRow=showApproval&&(scope==="approval"||counts.approval===null||counts.approval>0);
 const showDHFRow=showDHF&&(scope==="dhf"||counts.dhf===null||counts.dhf>0);
 const hasRows=(showFile&&(fileWork>0))||showApprovalRow||showDHFRow;
 return <section className="wbf-home" aria-label="我的工作">
  <header className="wbf-heading">
   <div><h1>我的工作</h1><span>需要你处理的事项，集中在这里。</span></div>
   <div className="wbf-heading-actions">
    <RareButton type="button" tone="ghost" onClick={refresh} disabled={busy}>刷新</RareButton>
    {canCreate?<RareButton type="button" tone="primary" aria-expanded={createOpen}
      onClick={()=>setCreateOpen(v=>!v)}>＋ 发起</RareButton>:null}
   </div>
  </header>
  {createOpen&&canCreate?<div className="wbf-create" aria-label="发起工作">
   <RareButton type="button" onClick={()=>{setCreateOpen(false);onCreate()}}>文件修订</RareButton>
   <Link to="/workbench/dhf?create=1">DHF 项目</Link>
   <Link to="/workbench/customer-registrations">客户登记</Link>
  </div>:null}
  <div className="wbf-worklist">
   <div className="wbf-controls">
    <div className="wbf-tabs" role="group" aria-label="业务来源">
     {scopes.map(item=><RareButton key={item.id} type="button" tone="ghost"
       className={"wbf-tab"+(scope===item.id?" is-active":"")}
       aria-pressed={scope===item.id} onClick={()=>setScope(item.id)}>
       {item.label}{item.count!==null?<span>{item.count}</span>:null}
     </RareButton>)}
    </div>
    <RareButton type="button" tone="ghost" onClick={()=>onView("todo")}>文件队列 ›</RareButton>
   </div>
   {error||initiatedError?<RareNotice tone="warning">部分信息未能加载：{error||initiatedError}
    <RareButton type="button" tone="ghost" onClick={refresh}>重试</RareButton></RareNotice>:null}
   <div className="wbf-list" aria-live="polite">
    {showApprovalRow?<Link className="wbf-row" to="/workbench?view=approvals">
     <span className="wbf-dot"/>
     <span className="wbf-main"><strong>待我审批</strong><small>进入审批队列，查看需要处理的申请</small></span>
     <span className="wbf-count">{counts.approval??"—"}</span><span className="wbf-arrow">›</span>
    </Link>:null}
    {showDHFRow?<Link className="wbf-row" to="/workbench?view=dhf-operations">
     <span className="wbf-dot"/>
     <span className="wbf-main"><strong>DHF 阶段任务</strong><small>签审、整改、复验及 Gate 复核</small></span>
     <span className="wbf-count">{counts.dhf??"—"}</span><span className="wbf-arrow">›</span>
    </Link>:null}
    {showFile&&appointmentCount>0?<RareButton type="button" className="wbf-row"
      onClick={()=>onView("appointments")}>
     <span className="wbf-dot"/>
     <span className="wbf-main"><strong>任命资格核验</strong><small>待确认的任命及授权信息</small></span>
     <span className="wbf-count">{appointmentCount}</span><span className="wbf-arrow">›</span>
    </RareButton>:null}
    {showFile?todo.slice(0,16).map(item=><RareButton type="button" className="wbf-row"
      key={keyOf(item)} onClick={()=>onOpen(item)}>
     <span className={"wbf-dot"+(item.state==="returned"?" is-returned":"")}/>
     <span className="wbf-main"><strong title={item.title}>{item.title}</strong>
      <small>{workNextStep(item)}</small></span>
     <span className="wbf-arrow">›</span>
    </RareButton>):null}
    {showFile&&busy&&items.length===0?<div className="wbf-loading"><BrandLoadingLabel showContext>加载工作</BrandLoadingLabel></div>:null}
    {!hasRows&&!busy?<div className="wbf-empty"><strong>暂无待处理事项</strong>
     <span>新任务会自动出现在这里。</span></div>:null}
    {showFile&&todo.length>16?<RareButton type="button" tone="ghost" className="wbf-more"
     onClick={()=>onView("todo")}>查看剩余 {todo.length-16} 项文件待办 ›</RareButton>:null}
   </div>
   <footer className="wbf-footer">
    <RareButton type="button" tone="ghost" onClick={()=>onView("initiated")}>
     我发起的 {initiatedBusy?"…":initiatedError?"—":initiatedCount}{initiatedHasMore?"+":""}
    </RareButton>
    <span>·</span>
    <RareButton type="button" tone="ghost" onClick={()=>onView("following")}>流转中 {followUp}</RareButton>
   </footer>
  </div>
 </section>;
}
