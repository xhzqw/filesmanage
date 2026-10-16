import {useEffect,useRef,useState} from "react";
import {RareBadge,RareButton,RareNotice,RareSelect,RareTextarea,RareInput} from "../../shared/ui/rare";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {ApiError} from "../../shared/http";
import {toast} from "../../shared/ui/feedback";
import {errorCopy} from "../../shared/errors";
import {newIdempotencyKey} from "../../shared/ids";
import type {User} from "../../entities/user/model";
import {cdwApi,type CDWControlledRelease,type CDWDistributionPlan,type CDWActivationDecision} from "./api";
import {CDWDistributionLedgerPanel} from "./CDWDistributionLedgerPanel";

type Department={id:string;name:string};
type Target={departmentId:string;receiverId:string;channel:string;paperQuantity:number};
const emptyTarget=():Target=>({departmentId:"",receiverId:"",channel:"electronic",paperQuantity:0});

export function CDWDistributionPlanPanel({release,loadUsers,loadDepartments,isAdmin,currentUserId,onChanged}:{
 release:CDWControlledRelease;loadUsers:()=>Promise<User[]>;
 loadDepartments:()=>Promise<Department[]>;isAdmin:boolean;currentUserId:string;onChanged:()=>void;
}){
 const [plan,setPlan]=useState<CDWDistributionPlan|null>(null);
 const [targets,setTargets]=useState<Target[]>([emptyTarget()]);
 const [departments,setDepartments]=useState<Department[]>([]);
 const [users,setUsers]=useState<User[]>([]);
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState("");
 const [busy,setBusy]=useState(false);
 const requestKey=useRef("");
 const freezeKey=useRef("");
 const [approverId,setApproverId]=useState("");
 const [grantBusy,setGrantBusy]=useState(false);
 const grantKey=useRef("");
 const issueKey=useRef("");
 const dispatchKey=useRef("");
 const [withdrawOpen,setWithdrawOpen]=useState(false);
 const [withdrawReason,setWithdrawReason]=useState("");
 const withdrawKey=useRef("");
 const activateKey=useRef("");
 const [activation,setActivation]=useState<CDWActivationDecision|null>(null);
 const blockerText:Record<string,string>={
  unsupported_activation_policy:"生效策略未获系统支持",
  planned_effective_time_not_reached:"尚未到达计划生效时间",
  verified_dispatched_manifest_missing:"缺少已核验的发行物或已批准发行清单",
  distribution_not_dispatched:"发行批次未完成分发",
  distribution_targets_invalid:"存在已撤销或异常分发目标",
  department_receipts_incomplete:"相关部门尚未全部签收",
  required_readings_incomplete:"相关人员尚未全部阅读确认或确认授权已失效",
  paper_issue_not_frozen:"纸质发放数量尚未逐份编号并冻结",
  supersession_lineage_mismatch:"候选版本不符合当前有效版的替代关系",
  previous_paper_copies_outstanding:"旧版纸质副本尚有未回收或遗失项",
  supersession_pointer_missing:"待替换的有效版本不存在"
 };
 async function activate(){
  if(release.state!=="issued_pending"||plan?.state!=="dispatched"||busy)return;
  if(!activateKey.current)activateKey.current=newIdempotencyKey();
  setBusy(true);setActivation(null);
  try{
   const decision=await toast.track(()=>cdwApi.controlActivate(release.id,release.revision,activateKey.current),{
    loading:"正在独立核验生效条件与版本指针…",
    success:"生效条件校验已完成，请查看判定结果",
    error:e=>errorCopy(e,"受控文件生效判定失败")
   });
   activateKey.current="";setActivation(decision);
   if(decision.outcome==="activated")onChanged();
  }catch(e){if(!(e instanceof ApiError&&e.httpStatus===0))activateKey.current="";}
  finally{setBusy(false);}
 }
 useEffect(()=>{
  let active=true;setPlan(null);setTargets([emptyTarget()]);setLoading(true);setError("");
  Promise.all([
   cdwApi.distributionForRelease(release.id).catch(e=>{
    if(e instanceof ApiError&&e.httpStatus===404)return null;
    throw e;
   }),
   loadUsers().catch(()=>[]),loadDepartments().catch(()=>[])
  ]).then(([existing,people,depts])=>{
   if(!active)return;
   setPlan(existing);
   setDepartments(depts);
   setUsers(people.filter(u=>!u.disabled));
   if(existing?.targets?.length)setTargets(existing.targets);
  }).catch(e=>{if(active)setError(errorCopy(e,"无法读取分发计划或组织接收人"));})
   .finally(()=>{if(active)setLoading(false)});
  return()=>{active=false};
 },[release.id,loadUsers,loadDepartments]);
 function update(index:number,field:"departmentId"|"receiverId"|"channel"|"paperQuantity",value:string){
  setTargets(old=>old.map((item,i)=>i!==index?item:
   field==="departmentId"?{...item,departmentId:value,receiverId:""}:
   field==="channel"?{...item,channel:value,paperQuantity:value==="electronic"?0:Math.max(1,item.paperQuantity)}:
   field==="paperQuantity"?{...item,paperQuantity:Number(value)}:{...item,receiverId:value}));
  requestKey.current="";
 }
 const ready=targets.length>0&&targets.length<=30&&targets.every(t=>
  t.departmentId&&t.receiverId&&users.some(u=>u.id===t.receiverId&&u.departmentId===t.departmentId)&&
  (t.channel==="electronic"?t.paperQuantity===0:
   (t.channel==="paper"||t.channel==="mixed")&&Number.isInteger(t.paperQuantity)&&t.paperQuantity>=1&&t.paperQuantity<=100))&&
  new Set(targets.map(t=>t.departmentId)).size===targets.length;
 async function create(){
  if(busy||!ready||plan)return;
  setBusy(true);
  if(!requestKey.current)requestKey.current=newIdempotencyKey();
  try{
   const result=await toast.track(()=>cdwApi.distributionCreate(release.id,targets,requestKey.current),{
    loading:"正在建立部门受控分发计划…",
    success:"分发范围草案已持久化，尚未发送",
    error:e=>errorCopy(e,"建立部门分发范围失败")
   });
   requestKey.current="";setPlan(await cdwApi.distributionRead(result.id));
  }catch(e){if(!(e instanceof ApiError&&e.httpStatus===0))requestKey.current="";}
  finally{setBusy(false);}
 }
 async function freeze(){
  if(!plan||plan.state!=="draft"||busy)return;
  setBusy(true);
  if(!freezeKey.current)freezeKey.current=newIdempotencyKey();
  try{
   const frozen=await toast.track(()=>cdwApi.distributionFreeze(plan.id,plan.revision,freezeKey.current),{
    loading:"正在校验并冻结分发清单…",
    success:"分发清单已冻结，等待独立范围批准",
    error:e=>errorCopy(e,"冻结分发范围失败")
   });
   freezeKey.current="";setPlan(await cdwApi.distributionRead(frozen.id));
  }catch(e){if(!(e instanceof ApiError&&e.httpStatus===0))freezeKey.current="";}
  finally{setBusy(false);}
 }
 async function grantApprover(){
  if(grantBusy||!approverId||!plan||!isAdmin||approverId===currentUserId)return;
  if(!grantKey.current)grantKey.current=newIdempotencyKey();
  setGrantBusy(true);
  try{
   await toast.track(()=>cdwApi.scopeGrant(plan.fileId,approverId,grantKey.current),{
    loading:"正在登记独立范围批准人员…",
    success:"审批授权已登记；需由该人员登录完成批准",
    error:e=>errorCopy(e,"范围审批授权失败")
   });
   grantKey.current="";
   setApproverId("");
  }catch(e){if(!(e instanceof ApiError&&e.httpStatus===0))grantKey.current="";}
  finally{setGrantBusy(false);}
 }
 async function issue(){
  if(!plan||plan.state!=="approved"||release.state!=="ready"||busy)return;
  if(!issueKey.current)issueKey.current=newIdempotencyKey();
  setBusy(true);
  try{
   await toast.track(()=>cdwApi.controlIssue(release.id,release.revision,issueKey.current),{
    loading:"正在正式签发批准版本…",success:"受控文件已签发，尚未分发或生效",
    error:e=>errorCopy(e,"正式签发失败")
   });
   issueKey.current="";onChanged();
  }catch(e){if(!(e instanceof ApiError&&e.httpStatus===0))issueKey.current="";}
  finally{setBusy(false);}
 }
 async function dispatch(){
  if(!plan||plan.state!=="approved"||release.state!=="issued_pending"||busy)return;
  if(!dispatchKey.current)dispatchKey.current=newIdempotencyKey();
  setBusy(true);
  try{
   await toast.track(()=>cdwApi.distributionDispatch(plan.id,plan.revision,dispatchKey.current),{
    loading:"正在形成受控批次并分发到指定部门…",
    success:"发行批次已创建，等待部门签收及人员阅读确认",
    error:e=>errorCopy(e,"部门受控分发失败")
   });
   dispatchKey.current="";onChanged();
  }catch(e){if(!(e instanceof ApiError&&e.httpStatus===0))dispatchKey.current="";}
  finally{setBusy(false);}
 }
 async function withdraw(){
  if(!plan||plan.state!=="dispatched"||release.state!=="issued_pending"||
   busy||withdrawReason.trim().length<12)return;
  if(!withdrawKey.current)withdrawKey.current=newIdempotencyKey();
  setBusy(true);
  try{
   await toast.track(()=>cdwApi.distributionWithdraw(plan.id,plan.revision,withdrawReason.trim(),withdrawKey.current),{
    loading:"正在撤销发行并实时终止相关人员的访问…",
    success:"发行已撤销；历史签收及阅读凭证已保留",
    error:e=>errorCopy(e,"撤销受控发行失败")
   });
   withdrawKey.current="";setWithdrawReason("");setWithdrawOpen(false);
   onChanged();
  }catch(e){if(!(e instanceof ApiError&&e.httpStatus===0))withdrawKey.current="";}
  finally{setBusy(false);}
 }
 return <section className="cdw-section">
  <div className="cdw-section-head"><h3>部门分发范围</h3>
   {plan&&<RareBadge tone={plan.state==="frozen"?"success":plan.state==="cancelled"?"warning":"neutral"}>{
    plan.state==="draft"?"草案待冻结":plan.state==="frozen"?"清单已冻结":
    plan.state==="approved"?"待签发分发":plan.state==="dispatched"?"已分发":"发行已撤销"
   }</RareBadge>}
  </div>
  <p className="cdw-section-note">支持电子、纸质和混合发行。纸质数量在冻结清单中确定，后续须逐份登记唯一编号并单独跟踪回收，不能用电子阅读确认代替。</p>
  {loading&&<div className="cdw-message"><BrandLoadingLabel showContext>读取部门与可用分发计划</BrandLoadingLabel></div>}
  {error&&<RareNotice tone="danger">{error}</RareNotice>}
  {!loading&&!error&&<div className="cdw-form">
   <div className="cdw-control-recipients cdw-paper-recipients" role="table" aria-label="分发部门和指定接收人">
    <div className="cdw-control-recipient-head" role="row"><strong>部门</strong><strong>指定接收人</strong><strong>渠道</strong><strong>纸质份数</strong><span>操作</span></div>
    {targets.map((t,i)=><div className="cdw-control-recipient-row" role="row" key={i}>
     <RareSelect aria-label={"部门 "+(i+1)} value={t.departmentId}
      disabled={Boolean(plan)||busy} onChange={e=>update(i,"departmentId",e.target.value)}>
      <option value="">选择部门</option>
      {departments.map(d=><option value={d.id} key={d.id}>{d.name}</option>)}
     </RareSelect>
     <RareSelect aria-label={"部门接收人 "+(i+1)} value={t.receiverId}
      disabled={Boolean(plan)||busy||!t.departmentId} onChange={e=>update(i,"receiverId",e.target.value)}>
      <option value="">选择接收人</option>
     {users.filter(u=>u.departmentId===t.departmentId).map(u=>
       <option key={u.id} value={u.id}>{u.displayName}</option>)}
     </RareSelect>
     <RareSelect aria-label={"发行渠道 "+(i+1)} value={t.channel} disabled={Boolean(plan)||busy}
      onChange={e=>update(i,"channel",e.target.value)}>
      <option value="electronic">电子</option><option value="paper">纸质</option><option value="mixed">混合</option>
     </RareSelect>
     <RareInput aria-label={"纸质份数 "+(i+1)} type="number" min={0} max={100}
      value={String(t.paperQuantity)} disabled={Boolean(plan)||busy||t.channel==="electronic"}
      onChange={e=>update(i,"paperQuantity",e.target.value)}/>
     <RareButton type="button" tone="ghost" disabled={Boolean(plan)||busy||targets.length<2}
      onClick={()=>{setTargets(rows=>rows.filter((_,j)=>i!==j));requestKey.current="";}}>移除</RareButton>
    </div>)}
   </div>
   {!plan&&<div className="cdw-review-actions">
    <RareButton type="button" tone="neutral" disabled={busy||targets.length>=30}
     onClick={()=>{setTargets(rows=>[...rows,emptyTarget()]);requestKey.current="";}}>添加部门</RareButton>
    <RareButton type="button" tone="primary" disabled={!ready||busy} loading={busy}
     onClick={()=>void create()}>创建分发范围草案</RareButton>
   </div>}
   {plan?.state==="draft"&&<div className="cdw-review-actions">
    <RareButton type="button" tone="primary" disabled={busy} loading={busy}
     onClick={()=>void freeze()}>核对并冻结部门清单</RareButton>
   </div>}
   {plan?.state==="frozen"&&isAdmin&&<div className="cdw-review-form">
    <label>独立范围审批授权
     <RareSelect searchable value={approverId} disabled={grantBusy}
      onChange={e=>{setApproverId(e.target.value);grantKey.current="";}}>
      <option value="">选择另一位审批人</option>
      {users.filter(u=>u.id!==currentUserId).map(person=>
       <option key={person.id} value={person.id}>{person.displayName}</option>)}
     </RareSelect>
    </label>
    <div className="cdw-review-actions">
     <RareButton type="button" tone="neutral" loading={grantBusy}
      disabled={!approverId||grantBusy} onClick={()=>void grantApprover()}>授予范围批准权限</RareButton>
    </div>
    <p className="cdw-section-note">这只是授予资格；被授权人员仍须在自己的“范围审批”待办中独立批准冻结摘要。</p>
   </div>}
   {plan?.state==="approved"&&release.state==="ready"&&
    <div className="cdw-review-actions">
     <RareButton type="button" tone="primary" loading={busy} disabled={busy}
      onClick={()=>void issue()}>正式签发已批准版本</RareButton>
    </div>}
   {plan?.state==="approved"&&release.state==="issued_pending"&&
    <div className="cdw-review-actions">
     <RareButton type="button" tone="primary" loading={busy} disabled={busy}
      onClick={()=>void dispatch()}>分发至 {plan.departmentCount} 个部门</RareButton>
    </div>}
   {plan?.state==="dispatched"&&
    <RareNotice tone="info">正式发行批次已生成。部门签收、人员阅读确认及文件生效分别独立办理，不会由分发自动完成。</RareNotice>}
   {plan?.state==="dispatched"&&release.state==="issued_pending"&&<div className="cdw-review-form">
    <div className="cdw-review-actions"><RareButton type="button" tone="primary" loading={busy} disabled={busy}
     onClick={()=>void activate()}>核验条件并办理正式生效</RareButton></div>
    {activation?.outcome==="blocked"&&<RareNotice tone="warning">
     该版本尚未生效。须先完成以下条件：{activation.blockers.map(code=>blockerText[code]??code).join("；")}
    </RareNotice>}
    {activation?.outcome==="activated"&&<RareNotice tone="info">正式版本已生效，操作与有效版本指针已记录。</RareNotice>}
   </div>}
   {plan?.state==="dispatched"&&release.state==="issued_pending"&&<div className="cdw-review-form">
    <RareButton type="button" tone="neutral" aria-pressed={withdrawOpen} disabled={busy}
     onClick={()=>setWithdrawOpen(v=>!v)}>{withdrawOpen?"收起撤销操作":"撤销本次未生效发行"}</RareButton>
    {withdrawOpen&&<>
     <RareNotice tone="warning">撤销会立刻失效本批次受控访问授权，并取消未完成阅读任务。原批次、已签收及已确认的证据不会删除。当前有效文件不能从这里撤销。</RareNotice>
     <label>撤销依据（至少 12 字）
      <RareTextarea rows={3} maxLength={3000} value={withdrawReason} disabled={busy}
       onChange={e=>{setWithdrawReason(e.target.value);withdrawKey.current="";}}
       placeholder="记录范围错误、文件作废或其他受控制度依据"/>
     </label>
     <div className="cdw-review-actions">
      <RareButton type="button" tone="primary" loading={busy}
       disabled={busy||withdrawReason.trim().length<12} onClick={()=>void withdraw()}>确认撤销并撤回访问权限</RareButton>
     </div>
    </>}
   </div>}
   {plan?.state==="cancelled"&&<RareNotice tone="warning">
    本次发行已撤销，后续访问授权失效。原始批次、部门签收和个人阅读凭证仅供授权审计查询。
   </RareNotice>}
   {plan?.digestSha256&&<div className="cdw-review-digest">
    <small>受控范围规范摘要 SHA-256</small><code title={plan.digestSha256}>{plan.digestSha256}</code>
   </div>}
   {(plan?.state==="dispatched"||plan?.state==="cancelled")&&<CDWDistributionLedgerPanel planId={plan.id}/>}
  </div>}
 </section>;
}
