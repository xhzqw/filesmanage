import {useEffect,useRef,useState} from "react";
import {RareButton,RareNotice,RareSelect} from "../../shared/ui/rare";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {toast} from "../../shared/ui/feedback";
import {errorCopy} from "../../shared/errors";
import {ApiError} from "../../shared/http";
import {newIdempotencyKey} from "../../shared/ids";
import {cdwApi,type CDWReceiptTarget,type CDWReadingRoster} from "./api";

export function CDWReadingRosterPanel({target,onCreated}:{
 target:CDWReceiptTarget;onCreated:()=>void;
}){
 const [roster,setRoster]=useState<CDWReadingRoster|null>(null);
 const [people,setPeople]=useState<Array<{id:string;displayName:string}>>([]);
 const [readers,setReaders]=useState<string[]>([""]);
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState("");
 const [busy,setBusy]=useState(false);
 const key=useRef("");
 useEffect(()=>{
  let live=true;setLoading(true);setError("");
  Promise.all([
   cdwApi.readingRosterRead(target.targetId).catch(e=>{
    if(e instanceof ApiError&&e.httpStatus===404)return null;
    throw e;
   }),
   cdwApi.readingEligible(target.targetId)
  ]).then(([existing,eligible])=>{
   if(!live)return;
   setRoster(existing);setPeople(eligible.items);
  }).catch(e=>{if(live)setError(errorCopy(e,"读取指定阅读人员失败"));})
   .finally(()=>{if(live)setLoading(false)});
  return()=>{live=false};
 },[target.targetId]);
 const valid=readers.length>0&&readers.length<=100&&readers.every(id=>id&&people.some(u=>u.id===id))
  &&new Set(readers).size===readers.length;
 async function create(){
  if(!valid||busy||roster)return;
  if(!key.current)key.current=newIdempotencyKey();
  setBusy(true);
  try{
   const result=await toast.track(()=>cdwApi.readingRoster(target.targetId,readers,key.current),{
    loading:"正在冻结本部门指定阅读人员名册…",
    success:"阅读名册已冻结，指定人员需逐一确认",
    error:e=>errorCopy(e,"创建阅读名册失败")
   });
   key.current="";setRoster(result);onCreated();
  }catch(e){if(!(e instanceof ApiError&&e.httpStatus===0))key.current="";}
  finally{setBusy(false);}
 }
 return <section className="cdw-section">
  <div className="cdw-section-head"><h3>指定人员阅读确认</h3></div>
  <p className="cdw-section-note">部门签收后须另外指定应阅读人员。名册与本次受控发行稿关联，所有人各自确认；不计入培训完成。</p>
  {loading&&<BrandLoadingLabel showContext>正在读取部门阅读名册</BrandLoadingLabel>}
  {error&&<RareNotice tone="danger">{error}</RareNotice>}
  {!loading&&!error&&roster&&<div className="cdw-form">
   <RareNotice tone="success">阅读名册已冻结：应确认 {roster.assignedCount} 人，等待人员独立确认。</RareNotice>
   <div className="cdw-review-digest"><small>阅读名册 SHA-256</small><code>{roster.digestSha256}</code></div>
  </div>}
  {!loading&&!error&&!roster&&<div className="cdw-form">
   <div className="cdw-control-recipients" aria-label="阅读人员名册">
    {readers.map((person,i)=><div key={i} className="cdw-control-recipient-row">
     <RareSelect aria-label={"指定阅读人员 "+(i+1)} searchable value={person} disabled={busy}
      onChange={e=>{
       setReaders(current=>current.map((item,j)=>j===i?e.target.value:item));
       key.current="";
      }}>
      <option value="">选择本部门阅读人员</option>
      {people.map(user=><option key={user.id} value={user.id}>{user.displayName}</option>)}
     </RareSelect>
     <span>独立阅读</span>
     <RareButton type="button" tone="ghost" disabled={busy||readers.length===1}
      onClick={()=>{setReaders(x=>x.filter((_,j)=>j!==i));key.current="";}}>移除</RareButton>
    </div>)}
   </div>
   <div className="cdw-review-actions">
    <RareButton type="button" tone="neutral" disabled={busy||readers.length>=100}
     onClick={()=>{setReaders(x=>[...x,""]);key.current="";}}>添加人员</RareButton>
    <RareButton type="button" tone="primary" loading={busy} disabled={!valid||busy}
     onClick={()=>void create()}>创建并冻结阅读名册</RareButton>
   </div>
  </div>}
 </section>;
}
