import {useEffect,useMemo,useState} from "react";
import {Link,useNavigate} from "react-router-dom";
import type {CDWInboxItem} from "../features/cdw/api";
import {request} from "../shared/http";
import {RareButton,RareNotice} from "../shared/ui/rare";
import {workNeedsAction,workNextStep,type HomeView} from "./CDWWorkbenchHome";
import {readWorkSources,type WorkSource} from "../features/workbench/actionSources";
import "./workbenchNotion.css";

type PageLink={id:string;title:string;parentId:string|null;updatedAt?:string};
type Props={
 userName:string;items:CDWInboxItem[];appointmentCount:number;
 initiatedCount:number;initiatedHasMore:boolean;initiatedError:string;
 initiatedBusy:boolean;busy:boolean;error:string;canCreate:boolean;
 refreshToken:number;
 onCreate:()=>void;onRefresh:()=>void;onOpen:(item:CDWInboxItem)=>void;
 onView:(view:HomeView)=>void;
};
const keyOf=(item:CDWInboxItem)=>item.kind+":"+
 (item.obligationId??item.review?.gateId??item.formal?.id??item.candidate?.id??
 item.scope?.id??item.receipt?.targetId??item.reading?.id??item.taskId);

export function WorkbenchNotionHome({
 items,appointmentCount,initiatedCount,initiatedError,initiatedBusy,
 busy,error,onRefresh,onOpen,onView,refreshToken
}:Props){
 const [pages,setPages]=useState<PageLink[]>([]);
 const [workSources,setWorkSources]=useState<WorkSource[]|null>(null);
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
 useEffect(()=>{
  let active=true;
  void readWorkSources().then(sources=>{if(active)setWorkSources(sources)});
  return()=>{active=false};
 },[refreshToken]);
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
     <div><h1>工作台</h1><p className="wbn-intro">待处理、项目与知识页面</p></div>
     <RareButton type="button" tone="ghost" disabled={creating} onClick={()=>void newPage()}>＋ 新建页面</RareButton>
    </div>
    <div className="wbn-home-columns">
     <div className="wbn-home-primary">
    <section className={"wbn-home-section wbn-section-actions"+(todo.length+appointmentCount?" has-actions":"")} aria-label="CDW 文件工作待办">
     <div className="wbn-section-heading"><h2>文件工作待办</h2>
      <RareButton type="button" tone="ghost" onClick={()=>onView("todo")}>{todo.length+appointmentCount} 项 · 查看文件工作</RareButton>
     </div>
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
      {!todo.length&&!appointmentCount&&!busy?<p className="wbn-quiet">当前没有待处理的 CDW 文件事项；审批与 DHF 任务请分别查看对应队列。</p>:null}
     </div>
     {todo.length>8?<RareButton type="button" tone="ghost" className="wbn-more"
      onClick={()=>onView("todo")}>查看其余 {todo.length-8} 项</RareButton>:null}
     <div className="wbn-work-links">
      <Link to="/workbench?view=approvals">查看通用审批（独立队列）</Link>
      <Link to="/workbench?view=dhf-operations">查看 DHF 签审（独立队列）</Link>
      <RareButton type="button" tone="ghost" onClick={()=>onView("initiated")}>
       我发起的 {initiatedBusy?"…":initiatedError?"—":initiatedCount}
      </RareButton>
     </div>
    </section>
    <section className="wbn-home-section wbn-source-section" aria-label="其他受控工作来源">
     <div className="wbn-section-heading"><h2>其他工作来源</h2><span>来自独立受控业务队列</span></div>
     <div className="wbn-source-list">
      {!workSources?<p className="wbn-quiet">正在读取审批和 DHF 事项…</p>:
       workSources.map(source=><Link key={source.key} to={source.href} className="wbn-source-row">
        <span>{source.label}</span>
        <span className={source.error?"wbn-source-error":"wbn-source-count"}>
         {source.error?"读取失败":source.truncated?"至少 "+source.count+" 项":source.count+" 项"}
        </span>
       </Link>)}
     </div>
     <p className="wbn-source-note">仅显示当前权限范围的数据。试点 DHF 意见不是正式 Gate 批准。</p>
    </section>
     </div>
     <div className="wbn-home-secondary">
    <section className="wbn-home-section wbn-section-pages" aria-label="最近页面">
     <div className="wbn-section-heading"><h2>最近页面</h2><Link to="/workbench?view=knowledge">所有页面</Link></div>
     <div className="wbn-page-links">
      {recentPages.map(page=><Link key={page.id}
       to={"/workbench?view=knowledge&page="+encodeURIComponent(page.id)}
       className="wbn-line"><span className="wbn-line-icon">▤</span><span>{page.title}</span><span className="wbn-line-arrow">›</span></Link>)}
      {pages.length===0&&!pageError?<p className="wbn-quiet">还没有页面，点击右上方新建。</p>:null}
      {pageError?<p role="status" className="wbn-page-error">{pageError}</p>:null}
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
   </div>
  </div>
 </section>;
}
