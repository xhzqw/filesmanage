import {useEffect,useRef,useState} from "react";
import {RareBadge,RareButton,RareInput,RareNotice,RareTextarea} from "../../shared/ui/rare";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {toast} from "../../shared/ui/feedback";
import {errorCopy} from "../../shared/errors";
import {ApiError} from "../../shared/http";
import {newIdempotencyKey} from "../../shared/ids";
import {cdwApi,type CDWApprovedCandidate,type CDWControlledRelease} from "./api";
import type {User} from "../../entities/user/model";
import {CDWDistributionPlanPanel} from "./CDWDistributionPlanPanel";

export function CDWControlPreparePanel({candidate,user,onPrepared,loadUsers,loadDepartments}:{
 candidate:CDWApprovedCandidate;user:User;onPrepared:()=>void;
 loadUsers:()=>Promise<User[]>;loadDepartments:()=>Promise<Array<{id:string;name:string}>>;
}){
 const [label,setLabel]=useState("");
 const [releases,setReleases]=useState<CDWControlledRelease[]>([]);
 const [loading,setLoading]=useState(true);
 const [busy,setBusy]=useState(false);
 const prepared=releases.some(r=>r.candidateId===candidate.id&&r.state!=="cancelled");
 const [message,setMessage]=useState("");
 const grantKey=useRef("");
 const prepareKey=useRef("");
 const [verifyId,setVerifyId]=useState("");
 const [justification,setJustification]=useState("");
 const [noSeal,setNoSeal]=useState(false);
 const [noConversion,setNoConversion]=useState(false);
 const [verifyBusy,setVerifyBusy]=useState(false);
 const verifyKey=useRef("");
 const [distributionID,setDistributionID]=useState("");
 const [historyRevision,setHistoryRevision]=useState(0);
 function refreshHistory(){setHistoryRevision(n=>n+1);onPrepared();}

 useEffect(()=>{
  let active=true;setLoading(true);setMessage("");setReleases([]);setLabel("");
  void cdwApi.controlList(candidate.fileId)
   .then(data=>{if(active)setReleases(data.items??[]);})
   .catch(error=>{if(active)setMessage(errorCopy(error,"无法查看受控版本历史"));})
   .finally(()=>{if(active)setLoading(false);});
  return()=>{active=false};
 },[candidate.id,candidate.fileId,historyRevision]);
 async function grant(){
  if(busy||!user.isAdmin)return;
  setBusy(true);
  if(!grantKey.current)grantKey.current=newIdempotencyKey();
  try{
   await toast.track(()=>cdwApi.controlGrant(candidate.fileId,user.id,grantKey.current),{
    loading:"正在登记文控角色授权…",success:"文件级文控权限已授予",error:e=>errorCopy(e,"授权失败")
   });
   grantKey.current="";setMessage("");
  }catch(e){if(!(e instanceof ApiError&&e.httpStatus===0))grantKey.current="";}
  finally{setBusy(false)}
 }
 async function prepare(){
  if(busy||!label.trim())return;
  setBusy(true);
  if(!prepareKey.current)prepareKey.current=newIdempotencyKey();
  try{
   await toast.track(()=>cdwApi.controlPrepare(candidate.id,label.trim(),undefined,prepareKey.current),{
    loading:"正在锁定正式发行来源…",success:"发行准备记录已创建；尚未发行或生效",
    error:e=>errorCopy(e,"创建发行准备失败")
   });
   prepareKey.current="";setLabel("");refreshHistory();
  }catch(e){if(!(e instanceof ApiError&&e.httpStatus===0))prepareKey.current="";}
  finally{setBusy(false)}
 }
 async function verify(release:CDWControlledRelease){
  if(!noSeal||!noConversion||justification.trim().length<24||verifyBusy)return;
  if(!verifyKey.current)verifyKey.current=newIdempotencyKey();
  setVerifyBusy(true);
  try{
   await toast.track(()=>cdwApi.controlVerify(release.id,release.revision,justification.trim(),verifyKey.current),{
    loading:"正在核验正式发行物…",success:"发行物已核验冻结，尚未发行或生效",
    error:e=>errorCopy(e,"正式发行物核验失败")
   });
   verifyKey.current="";setVerifyId("");setJustification("");setNoSeal(false);setNoConversion(false);
   refreshHistory();
  }catch(e){if(!(e instanceof ApiError&&e.httpStatus===0))verifyKey.current="";}
  finally{setVerifyBusy(false);}
 }
 function openVerify(id:string){
  setVerifyId(previous=>previous===id?"":id);setJustification("");
  setNoSeal(false);setNoConversion(false);verifyKey.current="";
 }
 return <div className="cdw-detail-inner">
  <div className="cdw-detail-header">
   <div><small>G8 · 正式受控版次准备</small><h2>{candidate.fileName}</h2></div>
   <RareBadge tone="info">批准候选版</RareBadge>
  </div>
  <div className="cdw-detail-facts">
   <div><span>审批结果</span><strong>正式批准已完成</strong></div>
   <div><span>发行状态</span><strong>尚未发行</strong></div>
   <div><span>批准时间</span><strong>{new Date(candidate.approvedAt).toLocaleString("zh-CN")}</strong></div>
  </div>
  <section className="cdw-section">
   <h3>受控内容快照</h3>
   <p className="cdw-section-note">只引用正式批准的不可变 SHA-256/Blob。不得直接使用文件夹内的最新上传版本替代受控发行物。</p>
   <div className="cdw-review-digest"><small>已批准内容 SHA-256</small><code title={candidate.sha256}>{candidate.sha256}</code></div>
  </section>
  {user.isAdmin&&<section className="cdw-section">
   <div className="cdw-section-head"><h3>文控授权</h3></div>
   <p className="cdw-section-note">必须明确授予文件级文控角色才能执行发行准备。管理员身份本身不具有自动发行权。</p>
   <RareButton type="button" tone="neutral" loading={busy} disabled={busy} onClick={()=>void grant()}>为当前账号登记文件级文控权限</RareButton>
  </section>}
  <section className="cdw-section">
   <h3>受控发行准备</h3>
   <p className="cdw-section-note">准备仅建立待核验发行对象和来源副本。正式发行须另行完成发行物校验、分发范围审批和签收条件；此操作绝不更改当前有效版。</p>
   <div className="cdw-form">
    <label>正式版次标识
     <RareInput value={label} maxLength={60} placeholder="例如 A/0、A/1、B/0" onChange={e=>setLabel(e.target.value)}/>
    </label>
    <RareButton type="button" tone={prepared?"neutral":"primary"} loading={busy} disabled={busy||prepared||!label.trim()} onClick={()=>void prepare()}>{prepared?"该批准稿已进入发行台账":"创建发行准备记录"}</RareButton>
   </div>
  </section>
  <section className="cdw-section">
   <h3>本文件受控版次台账</h3>
   {loading&&<div className="cdw-message"><BrandLoadingLabel showContext>加载历史版本</BrandLoadingLabel></div>}
   {message&&<RareNotice tone="warning">{message}</RareNotice>}
   {!loading&&releases.length===0&&<p className="cdw-section-note">该文件尚无受控发行记录。</p>}
   {releases.map(item=><div className="cdw-control-release-item" key={item.id}>
    <div className="cdw-branch-row">
     <span className="cdw-branch-text"><strong>{item.revisionLabel}</strong>
      <small>{item.state==="preparing"?"发行物待核验":item.state==="ready"?"发行物已冻结 · 待分发范围审批":item.state} · 内容指纹 {item.sha256.slice(0,16)}…</small>
     </span>
     {item.state==="preparing"?<RareButton type="button" tone="neutral" disabled={busy||verifyBusy}
      onClick={()=>openVerify(item.id)}>核验分发稿</RareButton>:
      (item.state==="ready"||item.state==="issued_pending"||item.state==="withdrawn")?<RareButton type="button" tone="neutral" onClick={()=>setDistributionID(v=>v===item.id?"":item.id)}>
       {distributionID===item.id?"收起部门记录":item.state==="withdrawn"?"查看撤销台账":"配置部门范围"}</RareButton>:
      <RareBadge tone={item.state==="effective"?"success":"neutral"}>{item.state==="effective"?"当前生效":item.state}</RareBadge>}
    </div>
    {distributionID===item.id&&(item.state==="ready"||item.state==="issued_pending"||item.state==="withdrawn")&&
     <CDWDistributionPlanPanel release={item} loadUsers={loadUsers} loadDepartments={loadDepartments}
      isAdmin={user.isAdmin} currentUserId={user.id} onChanged={refreshHistory}/>}
    {verifyId===item.id&&item.state==="preparing"&&<div className="cdw-review-form">
     <RareNotice tone="warning">仅适用于经制度核验后确定<strong>无需额外签章且无需格式转换</strong>的原批准 DOCX。需要盖章或转换的文件不能用此入口。</RareNotice>
     <div className="cdw-review-actions">
      <RareButton type="button" tone={noSeal?"primary":"neutral"} aria-pressed={noSeal}
       disabled={verifyBusy} onClick={()=>{setNoSeal(v=>!v);verifyKey.current="";}}>
       {noSeal?"✓ 已核验无需追加签章":"确认无需追加签章"}
      </RareButton>
      <RareButton type="button" tone={noConversion?"primary":"neutral"} aria-pressed={noConversion}
       disabled={verifyBusy} onClick={()=>{setNoConversion(v=>!v);verifyKey.current="";}}>
       {noConversion?"✓ 已核验无需转换":"确认无需格式转换"}
      </RareButton>
     </div>
     <label>文控制度核验依据（至少 24 字）
      <RareTextarea value={justification} maxLength={3000} rows={3} disabled={verifyBusy}
       onChange={e=>{setJustification(e.target.value);verifyKey.current="";}}
       placeholder="写明文件类别、制度依据、批准源版本和无需追加签章/转换的理由"/>
     </label>
     <div className="cdw-review-actions">
      <RareButton type="button" tone="primary" loading={verifyBusy}
       disabled={!noSeal||!noConversion||justification.trim().length<24||verifyBusy}
       onClick={()=>void verify(item)}>核验并冻结发行物</RareButton>
      <RareButton type="button" tone="ghost" disabled={verifyBusy} onClick={()=>openVerify("")}>取消</RareButton>
     </div>
    </div>}
   </div>)}
  </section>
 </div>;
}
