import {useState} from "react";
import {Link,useSearchParams} from "react-router-dom";
import {RareButton} from "../shared/ui/rare";
import {DHFPilotInbox} from "../features/workflow/DHFPilotInbox";
import {DHFRemediationInbox} from "../features/workflow/DHFRemediationInbox";
import {DHFReviewAttestationInbox} from "../features/workflow/DHFReviewAttestationInbox";
import {DHFVerificationInbox} from "../features/workflow/DHFVerificationInbox";
import {DHFGateDecisionReviewInbox} from "../features/workflow/DHFGateDecisionReviewInbox";
import {DHFConditionalRemediationPlans} from "../features/workflow/DHFConditionalRemediationPlans";
import {DHFCredentialManagement} from "../features/workflow/DHFCredentialManagement";

const operations=[
 {key:"review",label:"阶段签审",group:"待处理",description:"查看需要签审的阶段任务"},
 {key:"attest",label:"签审确认",group:"待处理",description:"留存独立签审确认记录"},
 {key:"verification",label:"整改复验",group:"待处理",description:"核对整改结果和冻结证据"},
 {key:"gate",label:"独立 Gate 复核",group:"阶段决策",description:"提出退回或拒绝建议；不替代正式放行"},
 {key:"returns",label:"退回整改",group:"阶段决策",description:"查看退回责任和整改闭环"},
 {key:"conditional",label:"条件整改预案",group:"阶段决策",description:"申请有条件整改预案，不代表获得审批"},
 {key:"credentials",label:"凭证治理",group:"治理",description:"管理签审资格与个人凭证"},
] as const;
type Operation=typeof operations[number]["key"];
export function WorkbenchDHFOperations(){
 const [params,setParams]=useSearchParams();
 const [fallback]=useState<Operation>("review");
 const raw=params.get("gateTab");
 const active:Operation=operations.find(x=>x.key===raw)?.key??fallback;
 const selected=operations.find(x=>x.key===active)!;
 function pick(next:Operation){
  setParams(prev=>{const p=new URLSearchParams(prev);p.set("view","dhf-operations");p.set("gateTab",next);return p;});
 }
 return <section className="wbv2-operations" aria-label="DHF 阶段操作中心">
  <header className="wbv2-operations-head">
   <div><p className="wbv2-eyebrow">DHF / Gate 工作区</p>
    <h2>阶段操作中心</h2>
    <p>签审、退回、复验及独立复核集中办理。所有决策继续遵循原阶段状态机与权限。</p></div>
   <Link to="/workbench/dhf" className="wbv2-subtle-link">查看九阶段项目</Link>
  </header>
  <div className="wbv2-operations-layout">
   <nav aria-label="阶段操作分类" className="wbv2-operations-nav">
    {(["待处理","阶段决策","治理"] as const).map(group=><div key={group}>
     <p className="wbv2-nav-group-label">{group}</p>
     {operations.filter(op=>op.group===group).map(op=><RareButton key={op.key} type="button"
      className={"wbv2-op-nav-item"+(active===op.key?" is-current":"")}
      aria-current={active===op.key?"page":undefined} onClick={()=>pick(op.key)}>
      {op.label}</RareButton>)}</div>)}
   </nav>
   <div className="wbv2-operations-content">
    <div className="wbv2-operation-caption"><strong>{selected.label}</strong><span>{selected.description}</span></div>
    <div className="wbv2-operation-stage">
     {active==="review"?<DHFPilotInbox/>:
      active==="attest"?<DHFReviewAttestationInbox/>:
      active==="verification"?<DHFVerificationInbox/>:
      active==="gate"?<DHFGateDecisionReviewInbox/>:
      active==="returns"?<DHFRemediationInbox/>:
      active==="conditional"?<DHFConditionalRemediationPlans/>:
      <DHFCredentialManagement/>}
    </div>
   </div>
  </div>
 </section>;
}
