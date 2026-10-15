import {useRef,useState} from "react";
import {RareBadge,RareButton,RareNotice,RareTextarea} from "../../shared/ui/rare";
import {toast} from "../../shared/ui/feedback";
import {errorCopy} from "../../shared/errors";
import {newIdempotencyKey} from "../../shared/ids";
import {ApiError} from "../../shared/http";
import {cdwApi,type CDWReceiptTarget} from "./api";

export function CDWDepartmentReceiptPanel({target,onSigned}:{
 target:CDWReceiptTarget;onSigned:()=>void;
}){
 const [statement,setStatement]=useState("");
 const [busy,setBusy]=useState(false);
 const key=useRef("");
 async function acknowledge(){
  if(target.state!=="awaiting"||statement.trim().length<12||busy)return;
  if(!key.current)key.current=newIdempotencyKey();
  setBusy(true);
  try{
   await toast.track(()=>cdwApi.receiptAcknowledge(target.targetId,target.revision,statement.trim(),key.current),{
    loading:"正在核验身份、批次及受控版本…",
    success:"部门接收凭证已签署，人员阅读仍需单独确认",
    error:e=>errorCopy(e,"部门签收失败")
   });
   key.current="";setStatement("");onSigned();
  }catch(e){if(!(e instanceof ApiError&&e.httpStatus===0))key.current="";}
  finally{setBusy(false);}
 }
 return <div className="cdw-detail-inner">
  <div className="cdw-detail-header">
   <div><small>G9 · 部门受控发行签收</small><h2>{target.fileName}</h2></div>
   <RareBadge tone={target.state==="received"?"success":"warning"}>
    {target.state==="received"?"本部门已签收":"等待部门签收"}
   </RareBadge>
  </div>
  <div className="cdw-detail-facts">
   <div><span>正式版次</span><strong>{target.revisionLabel}</strong></div>
   <div><span>签收状态</span><strong>{target.state==="received"?"已签收":"待签收"}</strong></div>
   <div><span>发行部门</span><strong>{target.departmentId}</strong></div>
  </div>
  <section className="cdw-section">
   <h3>冻结发行凭据</h3>
   <div className="cdw-review-digest"><small>发行清单 SHA-256</small><code>{target.manifestSha256}</code></div>
   <div className="cdw-review-digest"><small>本次受控发行文件 SHA-256</small><code>{target.artifactSha256}</code></div>
  </section>
  {target.state==="awaiting"&&<section className="cdw-section">
   <RareNotice tone="info">请确认实际收到了以上正式版次。点击签收会形成不可变的个人身份与时间证据；该动作不代表其他人员已经阅读，不代表培训完成，也不会自动让文件生效。</RareNotice>
   <div className="cdw-review-form">
    <label>接收声明（至少 12 字）
     <RareTextarea rows={4} maxLength={2000} value={statement}
      onChange={e=>{setStatement(e.target.value);key.current="";}}
      placeholder="记录实际接收的文件版本、核验结果及部门确认情况"/>
    </label>
    <div className="cdw-review-actions">
     <RareButton type="button" tone="primary" disabled={busy||statement.trim().length<12}
      loading={busy} onClick={()=>void acknowledge()}>确认部门签收并留存凭证</RareButton>
    </div>
   </div>
  </section>}
  {target.state==="received"&&<RareNotice tone="success">本部门签收已完成。指定人员阅读确认、正式生效和旧版回收仍属于独立业务环节。</RareNotice>}
 </div>;
}
