import {useEffect,useState} from "react";
import {cdwApi,type CDWTraceEvent} from "../features/cdw/api";
import {RareButton,RareNotice} from "../shared/ui/rare";
import {errorCopy} from "../shared/errors";

const names:Record<string,string>={
 "task.create":"工作已发起","task.accept":"负责人已接收","task.delegate":"已派发下级工作",
 "created":"工作编辑分支已创建","revision.persisted":"工作修订已保存","delivery.frozen":"交付稿已冻结并提交",
 "review.accept":"交付验收通过","review.return":"交付验收退回","review.resume":"退回稿已恢复修订",
 "review.grant":"已授权代验收","review.revoke":"代验收授权已撤销","fulfilled":"责任履行完成"
};
const dateText=(v:string)=>{
 const d=new Date(v);
 return Number.isNaN(d.getTime())?"时间待核验":d.toLocaleString("zh-CN",{
  timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false})+"（北京时间）";
};
export function CDWInitiatedEventTimeline({taskId}:{taskId:string}){
 const [events,setEvents]=useState<CDWTraceEvent[]>([]);
 const [before,setBefore]=useState(0);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [revision,setRevision]=useState(0);
 useEffect(()=>{
  const controller=new AbortController();let active=true;
  setEvents([]);setBefore(0);setBusy(true);setError("");
  cdwApi.initiatedEvents(taskId,0,30,controller.signal).then(page=>{
   if(active){setEvents(page.items??[]);setBefore(page.nextBefore??0);}
  }).catch(err=>{if(active&&!(err instanceof DOMException&&err.name==="AbortError"))setError(errorCopy(err,"无法加载工作流转记录"));})
  .finally(()=>{if(active)setBusy(false)});
  return()=>{active=false;controller.abort()};
 },[taskId,revision]);
 async function more(){
  if(busy||!before)return;
  setBusy(true);setError("");
  try{
   const page=await cdwApi.initiatedEvents(taskId,before);
   setEvents(old=>[...old,...(page.items??[]).filter(item=>!old.some(v=>v.id===item.id))]);
   setBefore(page.nextBefore??0);
  }catch(err){setError(errorCopy(err,"无法继续读取审计记录"))}
  finally{setBusy(false)}
 }
 return <section className="cdw-initiated-timeline" aria-label="实际工作流转记录">
  <div className="cdw-timeline-head"><h3>实际工作流转</h3><RareButton type="button" tone="ghost" disabled={busy} onClick={()=>setRevision(x=>x+1)}>刷新记录</RareButton></div>
  <small className="cdw-timeline-note">记录来自不可变审计事件。这里仅跟踪本项工作；文件正式审批、发行和生效需分别核验。</small>
  {error&&<RareNotice tone="warning">{error}</RareNotice>}
  {busy&&events.length===0&&<p className="cdw-timeline-muted">正在读取审计记录…</p>}
  {!busy&&events.length===0&&!error&&<p className="cdw-timeline-muted">本项工作暂无可展示的流转记录。</p>}
  <div className="cdw-timeline-list">
   {events.map(item=><div className="cdw-timeline-item" key={item.id}>
    <span className="cdw-timeline-marker" aria-hidden="true"/>
    <div className="cdw-timeline-copy"><strong>{names[item.event]??"业务流程记录"}</strong>
     <span>{item.actorName||"系统"} · {dateText(item.occurredAt)}</span>
     <small>审计事件 #{item.id} · 关联类型：{item.kind==="review_gate"?"验收":item.kind==="branch"?"工作修订":item.kind==="obligation"?"责任":"工作"}</small></div>
   </div>)}
  </div>
  {before>0&&<RareButton type="button" tone="ghost" disabled={busy} onClick={()=>void more()}>{busy?"正在读取…":"查看更早的记录"}</RareButton>}
 </section>;
}
