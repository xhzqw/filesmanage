import {useEffect,useMemo,useState} from "react";
import {RareButton,RareNotice,RareTextarea,RareInput,RareSelect} from "../../shared/ui/rare";
import {toast} from "../../shared/ui/feedback";
import {errorCopy} from "../../shared/errors";
import {newIdempotencyKey} from "../../shared/ids";
import {cdwApi,type CDWQMSSpecialAuthority,type CDWQMSSpecialAlert} from "./api";

type Scope={fileId:string;kind:"dhf"|"dmr";templateVersionId:string;policyReleaseId:string;
 nodes:Array<{nodeKey:string;label:string}>};

// Shared control: proposer in the existing formal initiation detail; independent
// document controller in the existing QMS review workspace.
export function CDWQMSSpecialAuthorityPanel({actorId,scope,onChange}:{
 actorId:string;scope?:Scope;onChange?:()=>void;
}){
 const [items,setItems]=useState<CDWQMSSpecialAuthority[]>([]);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [reason,setReason]=useState("");
 const [selectedId,setSelectedId]=useState("");
 const [statement,setStatement]=useState("");
 const [action,setAction]=useState<"verify"|"return"|"reject">("verify");
 const [nodeRefs,setNodeRefs]=useState<Record<string,{clauseRef:string;basisSummary:string}>>({});
 const [alerts,setAlerts]=useState<CDWQMSSpecialAlert[]>([]);
 const [refresh,setRefresh]=useState(0);
 useEffect(()=>{
  let live=true;
  cdwApi.qmsSpecialList().then(page=>{if(live)setItems(page.items??[]);})
   .catch(e=>{if(live)setError(errorCopy(e,"专项签批依据列表加载失败"));});
  return()=>{live=false;};
 },[refresh,actorId]);
 useEffect(()=>{
  let live=true;
  cdwApi.qmsSpecialAlerts().then(page=>{if(live)setAlerts(page.items??[]);})
   .catch(e=>{if(live)setError(errorCopy(e,"专项审批通知加载失败"));});
  return()=>{live=false;};
 },[refresh,actorId]);
 const shown=useMemo(()=>scope?
  items.filter(a=>a.fileId===scope.fileId&&a.templateVersionId===scope.templateVersionId):
  items.filter(a=>a.proposedBy!==actorId&&(a.status==="pending"||a.status==="verified")),
 [items,scope,actorId]);
 const active=shown.find(a=>a.id===selectedId)??shown[0];
 const verified=shown.some(a=>a.status==="verified"&&a.policyReleaseId===scope?.policyReleaseId);
 const canPropose=scope&&!shown.some(a=>a.status==="pending"||a.status==="verified");
 const claims=scope?.nodes.map(node=>({nodeKey:node.nodeKey,
  clauseRef:nodeRefs[node.nodeKey]?.clauseRef?.trim()||"",
  basisSummary:nodeRefs[node.nodeKey]?.basisSummary?.trim()||""}))||[];
 const completeClaims=claims.length>0&&new Set(claims.map(c=>c.nodeKey)).size===claims.length&&
  claims.every(c=>c.clauseRef.length>=2&&Array.from(c.basisSummary).length>=8);
 async function propose(){
  if(!scope||Array.from(reason.trim()).length<16||!completeClaims||busy)return;
  setBusy(true);setError("");
  try{
   await toast.track(()=>cdwApi.qmsSpecialPropose({fileId:scope.fileId,kind:scope.kind,
    templateVersionId:scope.templateVersionId,policyReleaseId:scope.policyReleaseId,
    reason:reason.trim(),nodeClaims:claims},newIdempotencyKey()),{
    loading:"正在登记专项签批依据…",success:"专项依据已登记，等待独立文控核验",
    error:e=>errorCopy(e,"专项签批依据登记失败")});
   setReason("");setNodeRefs({});setRefresh(v=>v+1);onChange?.();
  }catch(e){setError(errorCopy(e,"专项签批依据登记失败"));}
  finally{setBusy(false);}
 }
 async function review(){
  if(!active||active.proposedBy===actorId||Array.from(statement.trim()).length<16||busy)return;
  const selectedAction=active.status==="verified"?"revoke":action;
  setBusy(true);setError("");
  try{
   await toast.track(()=>cdwApi.qmsSpecialReview(active.id,selectedAction,statement.trim(),newIdempotencyKey()),{
    loading:selectedAction==="revoke"?"正在撤销专项依据…":"正在提交独立核验结论…",
    success:selectedAction==="revoke"?"专项签批依据已撤销":selectedAction==="return"?"已退回补充材料":selectedAction==="reject"?"已驳回依据":"已记录专项依据独立核验",
    error:e=>errorCopy(e,"无法完成专项文控处理")});
   setStatement("");setSelectedId("");setRefresh(v=>v+1);onChange?.();
  }catch(e){setError(errorCopy(e,"无法完成专项文控处理"));}
  finally{setBusy(false);}
 }
 async function acknowledge(id:string){
  try{
   await toast.track(()=>cdwApi.qmsSpecialAlertRead(id,newIdempotencyKey()),{
    loading:"正在确认通知…",success:"已知悉专项审批通知",
    error:e=>errorCopy(e,"确认通知失败")});
   setRefresh(v=>v+1);
  }catch(e){setError(errorCopy(e,"确认通知失败"));}
 }
 return <section className="cdw-section" aria-label="DHF DMR 专项签批依据">
  <div className="cdw-section-head"><h3>{scope?"专用签批规定核验":"DHF / DMR 专项签批依据待办"}</h3>
   <RareButton type="button" tone="ghost" disabled={busy} onClick={()=>setRefresh(v=>v+1)}>刷新</RareButton>
  </div>
  {scope?<p className="cdw-section-note">
   {scope.kind==="dhf"?"设计历史文档（DHF）":"器械主文档（DMR）"}必须依据公司正式发布的专属签批规定；
   仅绑定通用质量程序、岗位任命或管理员提交都不能解锁。
  </p>:<p className="cdw-section-note">
   核对原始专属规定、适用文件、精确受控发行版本和模板节点后才能独立确认。提报人不能自审。
  </p>}
  {error&&<RareNotice tone="danger">{error}</RareNotice>}
  {alerts.filter(a=>!a.readAt).length>0&&<div className="cdw-review-digest" aria-label="专项签批通知">
   <small>专项签批状态通知</small>
   {alerts.filter(a=>!a.readAt).map(a=><div className="cdw-review-digest" key={a.id}>
    <p className="cdw-section-note">{a.kind.toUpperCase()} 专项依据
     {a.eventKind==="revoked"?"已撤销，相关节点不得继续按原授权审批":
      a.eventKind==="returned"?"已退回补充材料，需要重新提交":"已被驳回，需要新的合法依据"}。</p>
    <RareButton type="button" tone="neutral" onClick={()=>void acknowledge(a.id)}>已知悉</RareButton>
   </div>)}
  </div>}
  {scope&&<div className="cdw-review-digest">
   <small>{verified?"已通过独立核验":"尚未满足专项解锁前置条件"}</small>
   <p className="cdw-section-note">仅核对已生效的专用制度（例如《产品设计历史文档管理规定》或《产品器械主文档管理规定》），并由不同人员签署核验。</p>
   {canPropose&&<>
    <label>专项签批依据及适用范围
     <RareTextarea aria-label="专项签批依据说明" rows={3} value={reason} disabled={busy}
      onChange={e=>setReason(e.target.value)}
      placeholder="注明专属制度中的签批权限、适用对象和具体条款（至少 16 字）"/>
    </label>
    <div className="cdw-review-digest" aria-label="审批节点条款对应">
     <small>每一签批节点须提供专用制度条款（不得共享一个笼统结论）</small>
     {scope.nodes.map(node=><div className="cdw-review-digest" key={node.nodeKey}>
      <small>{node.label}</small>
      <label>制度条款编号
       <RareInput aria-label={node.label+"制度条款"} disabled={busy}
        value={nodeRefs[node.nodeKey]?.clauseRef||""} placeholder="例如 §4.2.3"
        onChange={e=>setNodeRefs(v=>({...v,[node.nodeKey]:{
         clauseRef:e.target.value,basisSummary:v[node.nodeKey]?.basisSummary||""}}))}/>
      </label>
      <label>本岗位与条款的适用性说明
       <RareTextarea aria-label={node.label+"条款适用性"} disabled={busy} rows={2}
        value={nodeRefs[node.nodeKey]?.basisSummary||""}
        onChange={e=>setNodeRefs(v=>({...v,[node.nodeKey]:{
         clauseRef:v[node.nodeKey]?.clauseRef||"",basisSummary:e.target.value}}))}
        placeholder="说明条款如何规定本节点的批准资格和适用范围"/>
      </label>
     </div>)}
    </div>
    <RareButton type="button" loading={busy} disabled={busy||Array.from(reason.trim()).length<16||!completeClaims}
     onClick={()=>void propose()}>{shown.length?"重新登记新版专用规定":"登记专项规定供文控复核"}</RareButton>
   </>}
  </div>}
  {shown.length===0&&!scope&&<p className="cdw-section-note">暂无您有权核验的专项签批依据。</p>}
  {shown.map(item=><RareButton type="button" key={item.id}
   className={"cdw-task-row"+(active?.id===item.id?" is-selected":"")}
   onClick={()=>{setSelectedId(item.id);setStatement("");}}>
   <span className="cdw-task-copy"><strong>{item.fileName}</strong>
    <small>{item.kind.toUpperCase()} · {item.status==="pending"?"待独立核验":
     item.status==="verified"?"已核验，可撤销":item.status==="returned"?"已退回":
     item.status==="rejected"?"已驳回":"已撤销"}</small>
   </span>
  </RareButton>)}
  {active&&<div className="cdw-review-digest">
   <small>制度：{active.policyName}</small>
   <p className="cdw-section-note">{active.reason}</p>
   <p className="cdw-section-note">版本绑定：{active.policyReleaseId} · 审批模板：{active.templateVersionId}</p>
   <div className="cdw-review-digest">
    <small>逐节点条款核对记录</small>
    {active.nodeClaims.map(node=><p className="cdw-section-note" key={node.nodeKey}>
     {node.nodeKey.replaceAll("_"," ")} · {node.clauseRef} · {node.basisSummary}
    </p>)}
   </div>
   {active.reviewReason&&<RareNotice tone="warning">{active.status==="returned"?"退回":"驳回"}依据：{active.reviewReason}</RareNotice>}
   {!scope&&<><label>{active.status==="verified"?"撤销理由":"独立核验结论"}
    <RareTextarea aria-label="专用制度独立核验结论" rows={3} value={statement}
     disabled={busy} onChange={e=>setStatement(e.target.value)}
     placeholder="记录制度原件、适用范围、节点签批资格和有效发行版本的核查结论（至少 16 字）"/>
   </label>
   {active.status==="pending"&&<label>核验处理
    <RareSelect aria-label="专项核验处理方式" disabled={busy} value={action}
     onChange={e=>setAction(e.target.value as "verify"|"return"|"reject")}>
     <option value="verify">核验通过（全部条款适用）</option>
     <option value="return">退回补证（可重新提报）</option>
     <option value="reject">驳回依据（不可沿用）</option>
    </RareSelect>
   </label>}
   <RareButton type="button" tone="primary" loading={busy}
    disabled={busy||Array.from(statement.trim()).length<16}
    onClick={()=>void review()}>{active.status==="verified"?"确认撤销专项签批依据":
     action==="return"?"确认退回并通知提报人":action==="reject"?"确认驳回并通知提报人":"确认独立核验专项签批依据"}</RareButton></>}
  </div>}
 </section>;
}
