import {useEffect,useMemo,useState} from "react";
import {Link,useNavigate} from "react-router-dom";
import type {CDWInboxItem} from "../features/cdw/api";
import {request} from "../shared/http";
import {RareButton,RareNotice} from "../shared/ui/rare";
import {workNeedsAction,workNextStep,type HomeView} from "./CDWWorkbenchHome";
import "./workbenchNotion.css";

type PageLink={id:string;title:string;parentId:string|null;updatedAt?:string};
type Props={
 userName:string;items:CDWInboxItem[];appointmentCount:number;
 initiatedCount:number;initiatedHasMore:boolean;initiatedError:string;
 initiatedBusy:boolean;busy:boolean;error:string;canCreate:boolean;
 onCreate:()=>void;onRefresh:()=>void;onOpen:(item:CDWInboxItem)=>void;
 onView:(view:HomeView)=>void;
};
const keyOf=(item:CDWInboxItem)=>item.kind+":"+
 (item.obligationId??item.review?.gateId??item.formal?.id??item.candidate?.id??
 item.scope?.id??item.receipt?.targetId??item.reading?.id??item.taskId);

export function WorkbenchNotionHome({
 items,appointmentCount,initiatedCount,initiatedError,initiatedBusy,
 busy,error,onRefresh,onOpen,onView
}:Props){
 const [pages,setPages]=useState<PageLink[]>([]);
 const [creating,setCreating]=useState(false);
 const [pageError,setPageError]=useState("");
 const navigate=useNavigate();
 useEffect(()=>{
  let live=true;
  const load=()=>{
   void request<PageLink[]>("/knowledge/pages").then(result=>{
    if(live){setPages(result||[]);setPageError("");}
   }).catch(()=>{if(live)setPageError("知识页面暂时无法加载");});
  };
  load();
  window.addEventListener("filesmanage:knowledge-changed",load);
  return()=>{live=false;window.removeEventListener("filesmanage:knowledge-changed",load)};
 },[]);
 const todo=useMemo(()=>items.filter(workNeedsAction),[items]);
 const recentPages=useMemo(()=>[...pages]
  .sort((a,b)=>(Date.parse(b.updatedAt||"")||0)-(Date.parse(a.updatedAt||"")||0))
  .slice(0,7),[pages]);
 async function newPage(){
  if(creating)return;setCreating(true);
  try{
   const page=await request<PageLink>("/knowledge/pages",{
    method:"POST",body:JSON.stringify({title:"无标题"})
   });
   window.dispatchEvent(new Event("filesmanage:knowledge-changed"));
   navigate("/workbench?view=knowledge&page="+encodeURIComponent(page.id));
  }catch{setPageError("无法新建页面，请检查权限。");}
  finally{setCreating(false)}
 }
 return <section className="wbn-home" aria-label="工作台首页">
  <div className="wbn-home-page">
   <header className="wbn-home-toolbar">
    <span>工作空间　/　主页</span>
    <RareButton type="button" tone="ghost" disabled={busy} onClick={onRefresh}>刷新</RareButton>
   </header>
   <div className="wbn-home-content">
    <div className="wbn-home-overview">
     <div><h1>我的工作台</h1><p className="wbn-intro">从待处理事项开始，也可以继续编辑页面。</p></div>
     <RareButton type="button" tone="ghost" disabled={creating} onClick={()=>void newPage()}>＋ 新建页面</RareButton>
    </div>

    <section className="wbn-home-section wbn-section-pages" aria-label="最近页面">
     <div className="wbn-section-heading"><h2>最近页面</h2></div>
     <div className="wbn-page-links">
      {recentPages.map(page=><Link key={page.id}
       to={"/workbench?view=knowledge&page="+encodeURIComponent(page.id)}
       className="wbn-line"><span className="wbn-line-icon">▤</span><span>{page.title}</span><span className="wbn-line-arrow">›</span></Link>)}
      {pages.length===0&&!pageError?<p className="wbn-quiet">还没有页面。点击右上方「新建页面」即可开始输入。</p>:null}
      {pageError?<p role="status" className="wbn-page-error">{pageError}</p>:null}
     </div>
    </section>

    <section className={"wbn-home-section wbn-section-actions"+(todo.length+appointmentCount?" has-actions":"")} aria-label="我的待办">
     <div className="wbn-section-heading"><h2>待我处理</h2><span>{todo.length+appointmentCount} 项</span></div>
     {error||initiatedError?<RareNotice tone="warning">
       部分事项读取失败：{error||initiatedError}
      </RareNotice>:null}
     <div className="wbn-task-list">
      {todo.slice(0,8).map(item=><RareButton type="button" key={keyOf(item)}
       className="wbn-task-row" onClick={()=>onOpen(item)}>
       <span className="wbn-task-icon">☐</span>
       <span className="wbn-task-text"><strong>{item.title}</strong><small>{workNextStep(item)}</small></span>
       <span className="wbn-line-arrow">›</span>
      </RareButton>)}
      {appointmentCount>0?<RareButton type="button" className="wbn-task-row"
       onClick={()=>onView("appointments")}><span className="wbn-task-icon">☐</span>
       <span className="wbn-task-text"><strong>任命资格核验</strong><small>{appointmentCount} 项待确认</small></span>
       <span className="wbn-line-arrow">›</span></RareButton>:null}
      {!todo.length&&!appointmentCount&&!busy?<p className="wbn-quiet">当前没有待处理事项。</p>:null}
     </div>
     {todo.length>8?<RareButton type="button" tone="ghost" className="wbn-more"
      onClick={()=>onView("todo")}>查看其余 {todo.length-8} 项</RareButton>:null}
     <div className="wbn-work-links">
      <Link to="/workbench?view=approvals">审批</Link>
      <Link to="/workbench?view=dhf-operations">DHF 阶段任务</Link>
      <RareButton type="button" tone="ghost" onClick={()=>onView("initiated")}>
       我发起的 {initiatedBusy?"…":initiatedError?"—":initiatedCount}
      </RareButton>
     </div>
    </section>

    <section className="wbn-home-section wbn-section-projects" aria-label="项目空间">
     <div className="wbn-section-heading"><h2>项目</h2></div>
     <Link className="wbn-line" to="/workbench?view=projects">
      <span className="wbn-line-icon">▦</span><span>所有项目</span><span className="wbn-line-arrow">›</span>
     </Link>
    </section>
   </div>
  </div>
 </section>;
}
