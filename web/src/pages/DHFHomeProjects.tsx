import {useEffect,useState} from "react";
import {Link} from "react-router-dom";
import {dhfApi,type DHFProject} from "../features/dhf/api";
import {RareButton} from "../shared/ui/rare";

export function DHFHomeProjects({canCreate}:{canCreate:boolean}){
 const [projects,setProjects]=useState<DHFProject[]>([]);
 const [busy,setBusy]=useState(true);
 const [error,setError]=useState("");
 const [more,setMore]=useState(false);
 useEffect(()=>{
  let alive=true;
  dhfApi.projects().then(items=>{if(alive)setProjects(items)})
   .catch(e=>{if(alive)setError(e instanceof Error?e.message:"无法载入DHF项目")})
   .finally(()=>{if(alive)setBusy(false)});
  return()=>{alive=false};
 },[]);
 return <section className="cdw-home-dhf" aria-label="DHF阶段项目">
  <div className="cdw-home-dhf-head">
   <strong>DHF 研发项目</strong>
   <Link to="/workbench/dhf">进入 DHF 工作台 →</Link>
  </div>
  {error?<p className="cdw-home-dhf-empty">{error}</p>:
   busy?<p className="cdw-home-dhf-empty">正在加载…</p>:
   projects.length===0?<div className="cdw-home-dhf-empty">
    <span>暂无进行中的研发项目</span>
    {canCreate&&<Link to="/workbench/dhf?create=1">+ 创建项目</Link>}
   </div>:<div className="cdw-home-dhf-list">
    {(more?projects:projects.slice(0,3)).map(project=><Link key={project.id} to={"/workbench/dhf?project="+encodeURIComponent(project.id)}
     className="cdw-home-dhf-row">
     <div className="cdw-home-dhf-main">
      <span className="cdw-home-dhf-no">DHF</span>
      <span className="cdw-home-dhf-copy">
       <strong title={project.title}>{project.title}</strong>
       <small>已验收 {project.acceptedStages}/9 阶段</small>
      </span>
     </div>
     <div className="cdw-dhf-stages-bar" aria-label={`进度 ${project.acceptedStages} / 9`}>
      {Array.from({length:9},(_,i)=><span key={i} className={"cdw-dhf-stage-dot"+(i<project.acceptedStages?" is-accepted":"")}/>)}
     </div>
    </Link>)}
    {!more&&projects.length>3&&<RareButton type="button" tone="ghost" onClick={()=>setMore(true)}>查看其余 {projects.length-3} 个项目</RareButton>}
   </div>}
 </section>;
}
