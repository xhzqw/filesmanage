import {useEffect,useState} from "react";
import {request} from "../../shared/http";
import {RareButton,RareInput,RareTextarea} from "../../shared/ui/rare";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {errorCopy} from "../../shared/errors";
import "./dhfPilotInbox.css";

type DHFTask={
 id:string;projectId:string;stageId:string;submissionId:string;
 reviewKey:string;status:string;gateReady:boolean;assignedAt:string;
};
type TaskResponse={items:DHFTask[];trialOnly:boolean};
const displayStage:Record<string,string>={
 G5:"G5 · 设计开发输出",G6:"G6 · 首次设计开发转移",
};
const specialtyNames:Record<string,string>={
 "__gate__":"阶段总验收",
 "G5-SW":"软件专业复核","G5-MF":"生产工艺复核",
 "G5-HW":"硬件专业复核","G5-STRUCT":"结构专业复核",
 "G5-PKG":"包装专业复核","G5-USE":"可用性复核",
 "G5-QA":"综合资料复核",
};

export function DHFPilotInbox(){
 const [tasks,setTasks]=useState<DHFTask[]>([]);
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState("");
 const [refresh,setRefresh]=useState(0);
 const [query,setQuery]=useState("");
 const [selected,setSelected]=useState<string|null>(null);
 const [comment,setComment]=useState("");
 const [busy,setBusy]=useState(false);
 const [feedback,setFeedback]=useState("");
 const [recommendError,setRecommendError]=useState("");
 useEffect(()=>{
  let alive=true;
  setLoading(true);
  setError("");
  request<TaskResponse>("/workbench/dhf/tasks")
   .then(result=>{if(alive)setTasks(result.items??[]);})
   .catch(err=>{if(alive)setError(errorCopy(err,"DHF 审核任务加载失败"));})
   .finally(()=>{if(alive)setLoading(false);});
  return()=>{alive=false};
 },[refresh]);
 const visible=tasks.filter(task=>[task.stageId,task.reviewKey,task.projectId,task.submissionId].some(value=>value.toLowerCase().includes(query.trim().toLowerCase())));
 const active=visible.find(task=>task.id===selected)??visible[0];
 useEffect(()=>{setComment("");setRecommendError("");},[active?.id]);
 async function recommend(outcome:"recommend_pass"|"recommend_return"){
  if(!active||busy)return;
  setBusy(true);setRecommendError("");setFeedback("");
  try{
   const bytes=crypto.getRandomValues(new Uint8Array(16));
   const idempotencyKey=Array.from(bytes,n=>n.toString(16).padStart(2,"0")).join("");
   await request<{taskId:string;decisionId:string;status:string;trialOnly:boolean}>(
    "/workbench/dhf/tasks/"+encodeURIComponent(active.id)+"/recommendation",
    {method:"POST",body:JSON.stringify({outcome,comment,idempotencyKey})});
   setTasks(items=>items.filter(item=>item.id!==active.id));
   setSelected(null);
   setFeedback("试点复核意见已记录，不代表正式阶段批准。");
  }catch(err){setRecommendError(errorCopy(err,"试点复核意见提交失败，请刷新并核对任务状态。"))}
  finally{setBusy(false)}
 }
 return <div className="dhf-pilot-shell">
  <section className="dhf-pilot-list" aria-label="DHF 阶段审核队列">
   <div className="dhf-pilot-toolbar">
    <strong>研发阶段审核</strong>
    <RareButton type="button" className="dhf-pilot-refresh" onClick={()=>setRefresh(i=>i+1)}>刷新</RareButton>
   </div>
   <div className="dhf-pilot-filter">
    <RareInput type="search" aria-label="筛选 DHF 审核任务" placeholder="搜索项目、阶段或提交" value={query} onChange={e=>setQuery(e.target.value)}/>
   </div>
   {loading?<div className="dhf-pilot-empty"><BrandLoadingLabel>正在加载</BrandLoadingLabel></div>:
    error?<div className="dhf-pilot-empty" role="alert">{error}</div>:
    visible.length===0?<div className="dhf-pilot-empty">暂无指派给我的阶段审核任务</div>:
    <div className="dhf-pilot-scroll">{visible.map(task=><button type="button" key={task.id}
      className={"dhf-pilot-task"+(active?.id===task.id?" is-selected":"")}
      aria-pressed={active?.id===task.id} onClick={()=>setSelected(task.id)}>
      <span className="dhf-pilot-task-title">{specialtyNames[task.reviewKey]??task.reviewKey}</span>
      <span className="dhf-pilot-task-meta">{displayStage[task.stageId]??task.stageId} · {task.projectId}</span>
      <span className="dhf-pilot-task-date">{new Date(task.assignedAt).toLocaleString("zh-CN")}</span>
    </button>)}</div>}
  </section>
  <section className="dhf-pilot-detail" aria-label="阶段审核详情">
   {feedback?<div className="dhf-pilot-feedback" role="status">{feedback}</div>:null}
   {active?<div className="dhf-pilot-content">
     <span className="dhf-pilot-overline">DHF / {active.stageId}</span>
     <h2>{specialtyNames[active.reviewKey]??active.reviewKey}</h2>
     <dl><div><dt>项目</dt><dd>{active.projectId}</dd></div>
       <div><dt>提交批次</dt><dd>{active.submissionId}</dd></div>
       <div><dt>当前状态</dt><dd>待专业核验</dd></div>
       <div><dt>派发时间</dt><dd>{new Date(active.assignedAt).toLocaleString("zh-CN")}</dd></div>
     </dl>
     {active.reviewKey==="__gate__"&&!active.gateReady?<p className="dhf-pilot-gate-wait">该阶段的专业复核尚未全部完成，暂不能提出总 Gate 通过建议。</p>:null}
     <div className="dhf-pilot-opinion">
      <RareTextarea aria-label="试点复核意见" value={comment} onChange={e=>setComment(e.target.value)}
       placeholder="记录复核说明；建议退回时必须填写原因" rows={3}/>
      {recommendError?<p role="alert" className="dhf-pilot-opinion-error">{recommendError}</p>:null}
      <div className="dhf-pilot-actions">
       <RareButton type="button" disabled={busy||(active.reviewKey==="__gate__"&&!active.gateReady)}
        onClick={()=>void recommend("recommend_pass")}>{busy?"处理中…":"记录通过建议"}</RareButton>
       <RareButton type="button" disabled={busy||!comment.trim()}
        onClick={()=>void recommend("recommend_return")}>记录退回建议</RareButton>
      </div>
     </div>
     <p className="dhf-pilot-disclaimer">本操作仅保存试点复核意见；普通预览默认不是冻结版本，须先核验对应受控文件的准确版本和内容。正式电子签署、阶段批准和文件发行均未启用。</p>
   </div>:<div className="dhf-pilot-empty">选择左侧任务，查看阶段与提交信息</div>}
  </section>
 </div>
}
