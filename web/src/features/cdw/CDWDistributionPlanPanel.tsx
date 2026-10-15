import {useEffect,useRef,useState} from "react";
import {RareBadge,RareButton,RareNotice,RareSelect} from "../../shared/ui/rare";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {ApiError} from "../../shared/http";
import {toast} from "../../shared/ui/feedback";
import {errorCopy} from "../../shared/errors";
import {newIdempotencyKey} from "../../shared/ids";
import type {User} from "../../entities/user/model";
import {cdwApi,type CDWControlledRelease,type CDWDistributionPlan} from "./api";

type Department={id:string;name:string};
type Target={departmentId:string;receiverId:string};
const emptyTarget=():Target=>({departmentId:"",receiverId:""});

export function CDWDistributionPlanPanel({release,loadUsers,loadDepartments,isAdmin,currentUserId}:{
 release:CDWControlledRelease;loadUsers:()=>Promise<User[]>;
 loadDepartments:()=>Promise<Department[]>;isAdmin:boolean;currentUserId:string;
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
 useEffect(()=>{
  let active=true;setPlan(null);setTargets([emptyTarget()]);setLoading(true);setError("");
  Promise.all([
   cdwApi.distributionForRelease(release.id).catch(e=>{
    if(e instanceof ApiError&&e.httpStatus===404)return null;
    throw e;
   }),
   loadUsers(),loadDepartments()
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
 function update(index:number,field:"departmentId"|"receiverId",value:string){
  setTargets(old=>old.map((item,i)=>i!==index?item:field==="departmentId"?
   {departmentId:value,receiverId:""}:{...item,receiverId:value}));
  requestKey.current="";
 }
 const ready=targets.length>0&&targets.length<=30&&targets.every(t=>
  t.departmentId&&t.receiverId&&users.some(u=>u.id===t.receiverId&&u.departmentId===t.departmentId))&&
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
 return <section className="cdw-section">
  <div className="cdw-section-head"><h3>部门分发范围</h3>
   {plan&&<RareBadge tone={plan.state==="frozen"?"success":"neutral"}>{plan.state==="draft"?"草案待冻结":plan.state==="frozen"?"清单已冻结":"待分发审批"}</RareBadge>}
  </div>
  <p className="cdw-section-note">仅建立电子分发范围。每部门必须由指定负责人签收，另须配置相关人员阅读确认；冻结之后无法覆盖部门、接收人及要求。范围批准、发行和生效是后续独立步骤。</p>
  {loading&&<div className="cdw-message"><BrandLoadingLabel showContext>读取部门与可用分发计划</BrandLoadingLabel></div>}
  {error&&<RareNotice tone="danger">{error}</RareNotice>}
  {!loading&&!error&&<div className="cdw-form">
   <div className="cdw-control-recipients" role="table" aria-label="分发部门和指定接收人">
    <div className="cdw-control-recipient-head" role="row"><strong>部门</strong><strong>指定接收人</strong><span>操作</span></div>
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
   {plan?.digestSha256&&<div className="cdw-review-digest">
    <small>受控范围规范摘要 SHA-256</small><code title={plan.digestSha256}>{plan.digestSha256}</code>
   </div>}
  </div>}
 </section>;
}
