import {useEffect,useRef,useState} from "react";
import {RareButton,RareInput,RareSelect,RareNotice,RareTextarea} from "../../shared/ui/rare";
import {toast} from "../../shared/ui/feedback";
import {errorCopy} from "../../shared/errors";
import {ApiError} from "../../shared/http";
import {newIdempotencyKey} from "../../shared/ids";
import type {User} from "../../entities/user/model";
import {cdwApi,type CDWFormalReady,type CDWEffectiveSearchHit,type CDWDocumentClassification} from "./api";
import {CDWQMSAppointmentEvidence} from "./CDWQMSAppointmentEvidence";
import {CDWQMSSpecialAuthorityPanel} from "./CDWQMSSpecialAuthorityPanel";

const signerPositions=[
 {value:"management_representative",label:"管理者代表"},
 {value:"general_manager",label:"总经理"},
 {value:"department_head",label:"部门负责人"},
 {value:"independent_reviewer",label:"独立审查人"},
 {value:"design_reviewer",label:"设计审查人"},
 {value:"qa_reviewer",label:"质量审查人"},
 {value:"regulatory_officer",label:"法规负责人"},
 {value:"release_authority",label:"授权放行人"},
 {value:"clinical_authority",label:"临床评价授权人"},
];

// Three explicit steps deliberately avoid silently granting approval authority.
export function CDWFormalInitiate({onCreated,loadUsers,actorId}:{onCreated:()=>void;loadUsers:()=>Promise<User[]>;actorId:string}){
 const [ready,setReady]=useState<CDWFormalReady[]>([]);
 const [users,setUsers]=useState<User[]>([]);
 const [delivery,setDelivery]=useState("");
 const [reviewer1,setReviewer1]=useState("");
 const [reviewer2,setReviewer2]=useState("");
 const [parallel,setParallel]=useState(false);
 const [position1,setPosition1]=useState("management_representative");
 const [position2,setPosition2]=useState("general_manager");
 const [classification,setClassification]=useState<CDWDocumentClassification|null>(null);
 const [classLoading,setClassLoading]=useState(false);
 const [classChoice,setClassChoice]=useState<"general"|"qms">("general");
 const [classReason,setClassReason]=useState("");
 const [basisSearch,setBasisSearch]=useState("");
 const [basisResults,setBasisResults]=useState<CDWEffectiveSearchHit[]>([]);
 const [basisReleaseId,setBasisReleaseId]=useState("");
 const [basisBusy,setBasisBusy]=useState(false);
 const [authorized,setAuthorized]=useState(false);
 const [templateId,setTemplateId]=useState("");
 const [error,setError]=useState("");
 const [loading,setLoading]=useState(true);
 const [busy,setBusy]=useState(false);
 const keys=useRef(new Map<string,string>());
 const selected=ready.find(d=>d.deliveryId===delivery);
 const qms=classification?.approvalClass==="qms";
 const dedicatedSource=selected?.fileName.match(/产品设计历史文档管理规定|设计历史文档管理规定|产品器械主文档管理规定|器械主文档管理规定/);
 const specialKind=dedicatedSource?null:selected?.fileName.match(/(?:^|[^a-z])DHF(?:[^a-z]|$)|设计历史文档|设计历史文件/i)?"dhf":
  selected?.fileName.match(/(?:^|[^a-z])DMR(?:[^a-z]|$)|器械主文档/i)?"dmr":null;
 useEffect(()=>{
  let live=true;setClassification(null);setClassReason("");setBasisReleaseId("");
  if(!selected?.fileId)return;
  setClassLoading(true);
  cdwApi.formalClass(selected.fileId).then(info=>{
   if(live){setClassification(info);setClassChoice(info.requiresQms?"qms":"general");}
  }).catch(e=>{if(live)setError(errorCopy(e,"无法核验文控文件类别"));})
   .finally(()=>{if(live)setClassLoading(false);});
  return()=>{live=false;};
 },[selected?.fileId]);
 useEffect(()=>{
  let live=true;setLoading(true);setError("");
  Promise.all([cdwApi.formalReady(),loadUsers()])
   .then(([deliveries,people])=>{if(live){setReady(deliveries.items);setUsers(people.filter(u=>!u.disabled));}})
   .catch(e=>{if(live)setError(errorCopy(e,"无法读取可提交交付稿与审批人"));})
   .finally(()=>{if(live)setLoading(false);});
  return()=>{live=false};
 },[loadUsers]);
 function resetSteps(){
  setAuthorized(false);setTemplateId("");
  keys.current.clear();
 }
 const prepared=Boolean(selected&&!classLoading&&classification&&classification.approvalClass!=="pending"&&reviewer1&&reviewer2&&reviewer1!==reviewer2&&(!qms||basisReleaseId));
 const policyBasis=qms?basisReleaseId:undefined;
 async function classify(){
  if(!selected||!classification||classification.approvalClass!=="pending"||Array.from(classReason.trim()).length<16)return;
  const success=await step("classify:"+selected.fileId,key=>cdwApi.formalClassify(
   selected.fileId,classChoice,classReason.trim(),key),"文件类别已登记，后续正式审批按文控分类校验");
  if(success){
   try{setClassification(await cdwApi.formalClass(selected.fileId));resetSteps();}
   catch(e){setError(errorCopy(e,"无法重新核验文件类别"));}
  }
 }
 async function searchPolicy(){
  if(!basisSearch.trim()||basisBusy)return;
  setBasisBusy(true);
  try{
   const page=await cdwApi.controlEffectiveSearch(basisSearch.trim(),"",30);
   setBasisResults(page.items);setBasisReleaseId("");
  }catch(e){setBasisResults([]);setBasisReleaseId("");setError(errorCopy(e,"受控制度依据检索失败"));}
  finally{setBasisBusy(false);}
 }
 async function step(name:string,work:(key:string)=>Promise<unknown>,success:string){
  if(busy)return false;
  let key=keys.current.get(name);
  if(!key){key=newIdempotencyKey();keys.current.set(name,key);}
  setBusy(true);
  try{
   await toast.track(()=>work(key),{loading:"正在保存受控操作…",success,error:e=>errorCopy(e,"操作失败")});
   keys.current.delete(name);return true;
  }catch(e){if(!(e instanceof ApiError&&e.httpStatus===0))keys.current.delete(name);return false;}
  finally{setBusy(false);}
 }
 async function authorize(){
  if(!selected||!prepared)return;
  // Individual grants are explicit, auditable role assignment commands.
  const a=await step("grant:"+delivery+":"+reviewer1,key=>cdwApi.formalGrant(selected.fileId,reviewer1,key,policyBasis),"第一级正式审批权限已授予");
  if(!a)return;
  const b=await step("grant:"+delivery+":"+reviewer2,key=>cdwApi.formalGrant(selected.fileId,reviewer2,key,policyBasis),"第二级正式审批权限已授予");
  if(b)setAuthorized(true);
 }
 async function publish(){
  if(!selected||!authorized||!prepared)return;
  const name=(qms?"qms_":"cdw-formal-")+selected.deliveryId;
  const steps=[
   {nodeKey:qms?position1:"stage-one",sequence:1,approverId:reviewer1},
   {nodeKey:qms?position2:"stage-two",sequence:parallel?1:2,approverId:reviewer2},
  ];
  if(busy)return;
  let key=keys.current.get("publish");
  if(!key){key=newIdempotencyKey();keys.current.set("publish",key);}
  setBusy(true);
  try{
   const result=await toast.track(()=>cdwApi.formalPublish(name,steps,key,policyBasis),{
    loading:"正在发布只读审批模板…",success:"审批模板版本已发布",error:e=>errorCopy(e,"模板发布失败")
   });
   setTemplateId(result.id);keys.current.delete("publish");
  }catch(e){if(!(e instanceof ApiError&&e.httpStatus===0))keys.current.delete("publish");}
  finally{setBusy(false);}
 }
 async function submit(){
  if(!selected||!templateId)return;
  const success=await step("start",key=>cdwApi.formalStart(selected.deliveryId,templateId,key),"正式审批已发起，冻结稿已锁定");
  if(success)onCreated();
 }
 return <section className="cdw-detail-inner">
  <div className="cdw-detail-header"><div><small>文件正式审批 / 文控管理</small><h2>从已验收交付稿发起</h2></div></div>
  <p className="cdw-section-note">此流程必须使用已持久化并通过任务验收的冻结稿。角色授权、模板发布、正式提交分别留存证据；批准不等于生效。</p>
  {loading&&<p className="cdw-section-note">正在读取服务器数据…</p>}
  {error&&<RareNotice tone="danger">{error}</RareNotice>}
  {!loading&&!error&&ready.length===0&&<RareNotice tone="info">目前没有可发起审批的已验收根任务交付稿。</RareNotice>}
  <div className="cdw-form">
   <label>选择已冻结、已验收的文件
    <RareSelect aria-label="选择已验收交付" value={delivery} disabled={busy||loading}
     onChange={e=>{setDelivery(e.target.value);resetSteps();}}>
     <option value="">选择正式审批候选稿</option>
     {ready.map(r=><option key={r.deliveryId} value={r.deliveryId}>{r.fileName}</option>)}
    </RareSelect>
   </label>
   {selected&&<div className="cdw-review-digest"><small>冻结交付 SHA-256</small><code>{selected.sha256}</code></div>}
   {selected&&<section className="cdw-section">
    <p className="cdw-section-note">文控归类：{classLoading?"正在核验…":classification?.approvalClass==="qms"?"质量体系受控文件":classification?.approvalClass==="general"?"普通文件":"待核定，暂不可正式审批"}</p>
    {classification?.approvalClass==="pending"&&<>
     <RareNotice tone="info">先由有授权的文控人员登记文件类别。已确认类别不可随意更改；已识别的质量制度不允许归入普通文件。</RareNotice>
     <label>文件类别
      <RareSelect aria-label="文控文件类别" value={classification.requiresQms?"qms":classChoice}
       disabled={classification.requiresQms||busy} onChange={e=>setClassChoice(e.target.value as "general"|"qms")}>
       <option value="general">普通文件</option>
       <option value="qms">质量体系受控文件（含 DHF / DMR）</option>
      </RareSelect>
     </label>
     <label>分类核验依据
      <RareTextarea aria-label="文控分类核验依据" value={classReason} rows={2} disabled={busy}
       onChange={e=>setClassReason(e.target.value)}
       placeholder="说明原始制度、文控台账、适用文件类别和核对事实（至少 16 字）"/>
     </label>
     <RareButton type="button" loading={busy} disabled={busy||Array.from(classReason.trim()).length<16}
      onClick={()=>void classify()}>文控确认文件类别</RareButton>
    </>}
   </section>}
   {qms&&<>
    <RareNotice tone="info">质量体系审批必须使用已生效的受控文件作为制度依据。此项只能证明文件来源可追溯，实际签批资格仍须文控按制度核实。</RareNotice>
    <label>检索当前有效的制度依据
     <RareInput type="search" aria-label="检索审批制度依据" value={basisSearch}
      onChange={e=>{setBasisSearch(e.target.value);setBasisResults([]);setBasisReleaseId("");resetSteps();}}
      placeholder="例如 文件控制程序" disabled={busy||basisBusy}/>
    </label>
    <RareButton type="button" loading={basisBusy} disabled={busy||basisBusy||!basisSearch.trim()}
     onClick={()=>void searchPolicy()}>查找已生效受控文件</RareButton>
    {basisResults.length>0&&<label>选取制度依据的受控发行版本
     <RareSelect aria-label="选择生效依据" value={basisReleaseId} disabled={busy}
      onChange={e=>{setBasisReleaseId(e.target.value);resetSteps();}}>
      <option value="">选择当前有效的发行物</option>
      {basisResults.map(r=><option key={r.releaseId} value={r.releaseId}>{r.fileName} · {r.releaseId}</option>)}
     </RareSelect>
    </label>}
    {!basisReleaseId&&<p className="cdw-section-note">未核验依据前可继续准备文档任务，但正式审批角色授权及模板发布不会开放。</p>}
    {selected&&basisReleaseId&&<CDWQMSAppointmentEvidence fileId={selected.fileId}
     policyReleaseId={basisReleaseId} users={users} positions={signerPositions}/>}
   </>}
   <label>一级审批人
    <RareSelect aria-label="一级审批人" value={reviewer1} disabled={busy} onChange={e=>{setReviewer1(e.target.value);resetSteps();}}>
     <option value="">选择人员</option>{users.map(u=><option key={u.id} value={u.id}>{u.displayName}</option>)}
    </RareSelect>
   </label>
   {qms&&<label>一级岗位资格
    <RareSelect aria-label="一级审批岗位" value={position1} disabled={busy}
     onChange={e=>{setPosition1(e.target.value);resetSteps();}}>
     {signerPositions.map(p=><option key={p.value} value={p.value}>{p.label}</option>)}
    </RareSelect>
   </label>}
   <label>二级审批人 / 并行会签人
    <RareSelect aria-label="二级审批人" value={reviewer2} disabled={busy} onChange={e=>{setReviewer2(e.target.value);resetSteps();}}>
     <option value="">选择人员</option>{users.filter(u=>u.id!==reviewer1).map(u=><option key={u.id} value={u.id}>{u.displayName}</option>)}
    </RareSelect>
   </label>
   {qms&&<label>二级岗位资格
    <RareSelect aria-label="二级审批岗位" value={position2} disabled={busy}
     onChange={e=>{setPosition2(e.target.value);resetSteps();}}>
     {signerPositions.map(p=><option key={p.value} value={p.value}>{p.label}</option>)}
    </RareSelect>
   </label>}
   <label>审批执行方式
    <RareSelect aria-label="审批执行方式" value={parallel?"parallel":"serial"} disabled={busy} onChange={e=>{setParallel(e.target.value==="parallel");resetSteps();}}>
     <option value="serial">逐级审批 · 一级通过后流转二级</option>
     <option value="parallel">并行会签 · 两位均须批准</option>
    </RareSelect>
   </label>
  </div>
  <section className="cdw-section">
   <div className="cdw-section-head"><h3>1. 显式授予正式审批权限</h3></div>
   <p className="cdw-section-note">这会为所选文件建立两名人员的正式审批角色；不是赋予全部文件或生产发行权限。已存在授权可重用。</p>
   <RareButton type="button" tone={authorized?"neutral":"primary"} loading={busy} disabled={!prepared||busy||authorized}
    onClick={()=>void authorize()}>{authorized?"✓ 已确认角色授权":"授权两位审批人"}</RareButton>
  </section>
  <section className="cdw-section">
   <h3>2. 发布不可变审批模板版本</h3>
   <p className="cdw-section-note">当前审批次序与人员固化为独立模板版本，之后的编辑不会改变已提交节点。</p>
   <RareButton type="button" tone={templateId?"neutral":"primary"} loading={busy} disabled={!authorized||busy||Boolean(templateId)}
    onClick={()=>void publish()}>{templateId?"✓ 模板已发布":"发布审批模板"}</RareButton>
  </section>
  <section className="cdw-section">
   <h3>3. 冻结并提交正式审批</h3>
   {qms&&specialKind&&templateId&&basisReleaseId&&selected&&
    <CDWQMSSpecialAuthorityPanel actorId={actorId}
     scope={{fileId:selected.fileId,kind:specialKind,templateVersionId:templateId,policyReleaseId:basisReleaseId}}/>}
   {qms&&specialKind&&<RareNotice tone="warning">DHF/DMR 正式审批会在服务器再次核对专用受控规定、独立文控核验和逐节点岗位任命。登记后若仍待复核，提交会被拒绝。</RareNotice>}
   <p className="cdw-section-note">仅生成正式审批实例，待全部必需节点同意后生成已批准候选版本；不会自动分发或生效。</p>
   <RareButton type="button" tone="primary" loading={busy} disabled={!templateId||busy} onClick={()=>void submit()}>确认提交正式审批</RareButton>
  </section>
 </section>;
}
