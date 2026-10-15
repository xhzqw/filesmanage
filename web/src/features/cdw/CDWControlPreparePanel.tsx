import {useEffect,useRef,useState} from "react";
import {RareBadge,RareButton,RareInput,RareNotice} from "../../shared/ui/rare";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {toast} from "../../shared/ui/feedback";
import {errorCopy} from "../../shared/errors";
import {ApiError} from "../../shared/http";
import {newIdempotencyKey} from "../../shared/ids";
import {cdwApi,type CDWApprovedCandidate,type CDWControlledRelease} from "./api";
import type {User} from "../../entities/user/model";

export function CDWControlPreparePanel({candidate,user,onPrepared}:{
 candidate:CDWApprovedCandidate;user:User;onPrepared:()=>void
}){
 const [label,setLabel]=useState("");
 const [releases,setReleases]=useState<CDWControlledRelease[]>([]);
 const [loading,setLoading]=useState(true);
 const [busy,setBusy]=useState(false);
 const prepared=releases.some(r=>r.candidateId===candidate.id&&r.state!=="cancelled");
 const [message,setMessage]=useState("");
 const grantKey=useRef("");
 const prepareKey=useRef("");
 useEffect(()=>{
  let active=true;setLoading(true);setMessage("");setReleases([]);setLabel("");
  void cdwApi.controlList(candidate.fileId)
   .then(data=>{if(active)setReleases(data.items??[]);})
   .catch(error=>{if(active)setMessage(errorCopy(error,"无法查看受控版本历史"));})
   .finally(()=>{if(active)setLoading(false);});
  return()=>{active=false};
 },[candidate.id,candidate.fileId]);
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
   prepareKey.current="";setLabel("");onPrepared();
  }catch(e){if(!(e instanceof ApiError&&e.httpStatus===0))prepareKey.current="";}
  finally{setBusy(false)}
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
   {releases.map(item=><div className="cdw-branch-row" key={item.id}>
    <span className="cdw-branch-text"><strong>{item.revisionLabel}</strong><small>{item.state==="preparing"?"发行准备中":item.state} · 内容指纹 {item.sha256.slice(0,16)}…</small></span>
    <RareBadge tone={item.state==="effective"?"success":"neutral"}>{item.state==="effective"?"当前生效":item.state==="preparing"?"待发行核验":item.state}</RareBadge>
   </div>)}
  </section>
 </div>;
}
