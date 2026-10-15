import {useState} from "react";
import {RareButton,RareNotice,RareTextarea} from "../../shared/ui/rare";
import type {CDWInboxItem} from "./api";

const prerequisites:Record<string,string>={
 manage:"完成下级交付验收、核对其工作结果，并确认下级任务链已无未完成交付。",
 integrate:"下级完成验收、上级整合稿完成验收，并且本项管理责任已被独立履行。",
 report:"管理和整合责任已履行，且上级整合稿完成验收。请记录实际汇报内容与结论。",
};

export function CDWObligationPanel({item,busy,onFulfill}:{
 item:CDWInboxItem;busy:boolean;onFulfill:(statement:string)=>Promise<boolean>;
}){
 const [statement,setStatement]=useState("");
 const [submitting,setSubmitting]=useState(false);
 const kind=item.obligationKind??"manage";
 const allowed=kind==="manage"||kind==="integrate"||kind==="report";
 async function submit(){
  if(!item.obligationId||!allowed||statement.trim().length<12||busy||submitting)return;
  setSubmitting(true);
  try{if(await onFulfill(statement.trim()))setStatement("");}
  finally{setSubmitting(false);}
 }
 return <section className="cdw-section">
  <h3>{kind==="manage"?"管理责任履行":kind==="integrate"?"成果整合确认":kind==="report"?"逐级上报确认":"越级介入知会"}</h3>
  <RareNotice tone="info">
   责任独立于下级交付验收。{prerequisites[kind]??"必须按越级授权和知会规则处理。"}
  </RareNotice>
  {allowed?<div className="cdw-review-form">
   <label>实际履行说明（至少 12 个字）
    <RareTextarea value={statement} rows={4} maxLength={3000}
     onChange={e=>setStatement(e.target.value)} placeholder="记录实际审查、整合或上报的内容、结果及依据，供审计追溯"/>
   </label>
   <div className="cdw-review-actions">
    <RareButton type="button" tone="primary" loading={submitting||busy}
     disabled={busy||submitting||statement.trim().length<12}
     onClick={()=>void submit()}>确认履行并留存证据</RareButton>
   </div>
  </div>:<p className="cdw-section-note">此项授权知会责任仍需单独的知会凭证，不允许通过通用核销入口跳过。</p>}
 </section>;
}
