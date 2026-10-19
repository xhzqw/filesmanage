import {useEffect,useMemo,useState} from "react";
import {RareButton,RareNotice} from "../shared/ui/rare";
import {errorCopy} from "../shared/errors";
import {cdwApi,type CDWFlowMilestone,type CDWFlowSnapshot} from "../features/cdw/api";

const steps=[
 {kind:"delivery",title:"交付冻结",hint:"文件正式提交前必须形成独立冻结稿"},
 {kind:"review",title:"逐级交付验收",hint:"验收通过不等于正式审批"},
 {kind:"formal",title:"正式审批",hint:"独立的审批责任和批准决定"},
 {kind:"release",title:"受控文件发行准备",hint:"必须关联获批候选稿"},
 {kind:"plan",title:"分发范围审批",hint:"各部门范围和发行物"},
 {kind:"dispatch",title:"部门受控分发",hint:"实际分发批次"},
 {kind:"receipt",title:"部门签收",hint:"仅按本发行物的有效签收计数"},
 {kind:"reading",title:"人员阅读确认",hint:"不能用部门签收代替"},
 {kind:"effective",title:"受控版本当前生效",hint:"以当前生效指针为准"}
] as const;
const states:Record<string,string>={
 draft:"草稿",assigned:"待接收",accepted:"已接收",in_progress:"修订中",submitted:"已提交",accepted_delivery:"交付已验收",
 returned:"已退回",declined:"已拒绝",closed:"已关闭",cancelled:"已取消",
 awaiting:"待验收",substituted:"授权替代验收",approved:"已批准",rejected:"已驳回",pending:"审批中",conflicted:"审批冲突",
 preparing:"准备中",ready:"发行准备就绪",issued_pending:"待生效",effective:"已生效",superseded:"已被替代",
 withdrawn:"已撤回",frozen:"已冻结",dispatched:"已分发",partial:"部分已完成",complete:"全部已确认",active:"当前生效"
};
const isCompleted=(kind:string,state:string)=>(
 kind==="delivery"&&state==="submitted" ||
 kind==="review"&&state==="accepted" ||
 kind==="formal"&&state==="approved" ||
 kind==="release"&&["effective","issued_pending","superseded"].includes(state) ||
 kind==="plan"&&["approved","dispatched"].includes(state) ||
 kind==="dispatch"&&state==="dispatched" ||
 (kind==="receipt"||kind==="reading")&&state==="complete" ||
 kind==="effective"&&state==="active"
);
const isProblem=(s:string)=>["returned","rejected","declined","conflicted","withdrawn","cancelled"].includes(s);
function localTime(value:string){
 const d=new Date(value);
 return Number.isNaN(d.valueOf())?"时间待核验":d.toLocaleString("zh-CN",{
  timeZone:"Asia/Shanghai",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false})+"（北京时间）";
}
export function CDWInitiatedFlowPanel({taskId}:{taskId:string}){
 const [data,setData]=useState<CDWFlowSnapshot|null>(null);
 const [error,setError]=useState("");
 const [busy,setBusy]=useState(true);
 const [reload,setReload]=useState(0);
 useEffect(()=>{
  const controller=new AbortController();let alive=true;
  setData(null);setBusy(true);setError("");
  cdwApi.initiatedFlow(taskId,controller.signal).then(result=>{if(alive)setData(result)})
   .catch(err=>{if(alive&&!(err instanceof DOMException&&err.name==="AbortError"))setError(errorCopy(err,"流程与责任信息加载失败"))})
   .finally(()=>{if(alive)setBusy(false)});
  return()=>{alive=false;controller.abort()};
 },[taskId,reload]);
 const taskDepths=useMemo(()=>{
  const map=new Map(data?.works.map(v=>[v.id,v])??[]);
  const depth=(id:string)=>{
   let d=0,p=map.get(id)?.parentId;
   while(p&&map.has(p)&&d<10){d++;p=map.get(p)?.parentId}
   return d;
  };
  return new Map((data?.works??[]).map(v=>[v.id,depth(v.id)]));
 },[data]);
 return <section className="cdw-flow" aria-label="工作责任与发行流程">
  <div className="cdw-flow-toolbar"><div><strong>责任链与受控文件流转</strong><small>仅显示服务端已经形成的业务事实</small></div>
   <RareButton type="button" tone="ghost" disabled={busy} onClick={()=>setReload(n=>n+1)}>刷新流程</RareButton>
  </div>
  {error&&<RareNotice tone="warning">{error}<RareButton type="button" tone="ghost" onClick={()=>setReload(n=>n+1)}>重试</RareButton></RareNotice>}
  {busy&&<div className="cdw-flow-loading">正在核对责任链和发行证据…</div>}
  {data&&<>
   <div className="cdw-flow-tree">
    <div className="cdw-flow-section-title"><strong>逐级工作责任链</strong><small>{data.works.length} 个关联工作节点</small></div>
    <div className="cdw-flow-tree-nodes">
     {data.works.map(w=><div key={w.id} className="cdw-flow-work" style={{paddingInlineStart:12+(taskDepths.get(w.id)??0)*14}}>
      <span className="cdw-flow-work-glyph" aria-hidden="true">{w.parentId?"↳":"●"}</span>
      <div className="cdw-flow-work-copy"><strong title={w.title}>{w.title}</strong>
       <small>负责人：{w.responsibleName||"尚无在任负责人"} · {w.createdByName}派发</small></div>
      <span className={"cdw-flow-state"+(isProblem(w.state)?" is-risk":"")}>{states[w.state]??"状态待核验"}</span>
     </div>)}
    </div>
    {data.truncated&&<p className="cdw-flow-caution">关联工作超过 100 项，仅展示前 100 项，请到专项工作记录中继续查证。</p>}
   </div>
   <div className="cdw-flow-stages">
    <div className="cdw-flow-section-title"><strong>本项工作的受控流程证据</strong><small>按具体冻结交付稿及后续发行物关联</small></div>
    <div className="cdw-flow-step-list">
     {steps.map((step,index)=>{
      const records=data.milestones.filter(m=>m.kind===step.kind);
      return <div className={"cdw-flow-step"+(records.length?" has-evidence":" is-unstarted")} key={step.kind}>
       <div className="cdw-flow-step-num">{index+1}</div>
       <div className="cdw-flow-step-body">
        <div className="cdw-flow-step-heading"><strong>{step.title}</strong><small>{records.length?records.length+" 条记录":"尚无关联记录"}</small></div>
        {records.length?records.map((m:CDWFlowMilestone,i)=><div className="cdw-flow-evidence" key={m.reference+":"+m.state+":"+i}>
         <span className={"cdw-flow-evidence-state"+(isProblem(m.state)?" is-risk":isCompleted(m.kind,m.state)?" is-complete":"")}>{states[m.state]??"状态待核验"}</span>
         <div className="cdw-flow-evidence-detail"><span>{m.detail||step.hint}{m.round?" · 第"+m.round+"轮":""}</span>
          <small>{m.actorName||"责任人依对应记录核验"} · {localTime(m.recordedAt)}</small>
          <details><summary>查看溯源编号</summary><code>{m.reference}</code></details>
         </div>
        </div>):<p className="cdw-flow-stage-empty">{step.hint} · 尚无该节点的证据，不能推定已执行</p>}
       </div>
      </div>;
     })}
    </div>
   </div>
   <div className="cdw-flow-scope">本页只显示当前所选工作的交付及与其精确关联的后续记录；不会把同文件其他工作或其他发行版的审批、签收及生效算入本流程。</div>
  </>}
 </section>;
}
