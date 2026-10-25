import {useState} from "react";
import {Link,useSearchParams} from "react-router-dom";
import {BrandLogo} from "../shared/ui/AppShell";
import type {Approval} from "../features/workflow/api";
import {RareButton} from "../shared/ui/rare";
import {SealLibrary} from "../features/seals/SealLibrary";
import {ApprovalReviewDialog} from "./ApprovalReviewDialog";
import type {User} from "../entities/user/model";
import {ApprovalInbox,type ApprovalView} from "../features/workflow/ApprovalInbox";
import {AppShell} from "../shared/ui/AppShell";
import {DHFPilotInbox} from "../features/workflow/DHFPilotInbox";
import {DHFRemediationInbox} from "../features/workflow/DHFRemediationInbox";
import {DHFReviewAttestationInbox} from "../features/workflow/DHFReviewAttestationInbox";
import {DHFCredentialManagement} from "../features/workflow/DHFCredentialManagement";
import {DHFGateDecisionReviewInbox} from "../features/workflow/DHFGateDecisionReviewInbox";
import {DHFConditionalRemediationPlans} from "../features/workflow/DHFConditionalRemediationPlans";
import {DHFVerificationInbox} from "../features/workflow/DHFVerificationInbox";


type DHFPilotSection="dhf_pilot"|"dhf_returns"|"dhf_attestations"|"dhf_verification"|"dhf_credentials"|"dhf_gate_decisions"|"dhf_condition_plans";
type Section=ApprovalView|"seals"|DHFPilotSection;
const PILOT_TABS=new Set<string>(["dhf_pilot","dhf_returns","dhf_attestations","dhf_verification","dhf_credentials","dhf_gate_decisions","dhf_condition_plans"]);

export function Approvals({user,onLogout}:{user:User;onLogout:()=>void}){
 const[review,setReview]=useState<Approval|null>(null);
 const[params,setParams]=useSearchParams();
 const requested=params.get("tab");
 const section:Section=requested==="mine"||requested==="notifications"||requested==="seals"||(user.isAdmin&&requested==="all_pending")||PILOT_TABS.has(requested??"")?requested as Section:"inbox";
 function changeSection(next:Section){
  setParams(previous=>{
   const updated=new URLSearchParams(previous);
   if(next==="inbox")updated.delete("tab");else updated.set("tab",next);
   updated.delete("item");
   return updated;
  });
 }
 const[counts,setCounts]=useState({pending:0,unread:0});
 const navigation:{id:Section;label:string;count?:number}[]=[
  {id:"inbox",label:"待我审批",count:counts.pending},
  ...(user.isAdmin?[{id:"all_pending" as const,label:"全部待审批"}]:[]),
  {id:"mine",label:"我发起的"},
  {id:"notifications",label:"通知",count:counts.unread},
  {id:"seals",label:user.isAdmin?"签章管理":"我的签章"},
  {id:"dhf_pilot",label:"DHF 阶段签审"},
  {id:"dhf_returns",label:"DHF 退回整改"},
  {id:"dhf_attestations",label:"DHF 签审确认"},
  {id:"dhf_verification",label:"DHF 整改复验"},
  {id:"dhf_credentials",label:"DHF 凭证治理"},
  {id:"dhf_gate_decisions",label:"独立 Gate 复核"},
  {id:"dhf_condition_plans",label:"条件整改预案"},
 ];
 return <AppShell user={user} onLogout={onLogout} finderSidebarWidth={240}>
  <div className="panels document-explorer approval-panels">
   <aside className="sidebar finder-sidebar" style={{width: "240px"}}>
    <Link to="/doc" className="finder-sidebar-home" aria-label="中晟生物 · 返回文档首页">
     <BrandLogo size={27} className="finder-sidebar-logo" transparent/><span>中晟生物</span>
    </Link>
    <div className="sidebar-scroll">
     <nav className="finder-navigation" aria-label="审批分类导航">
      <div className="approval-nav finder-nav-section">
       <div className="finder-nav-label">审批与经办</div>
       {navigation.map(item=><RareButton type="button" key={item.id}
        className={"approval-nav-item finder-nav-item"+(section===item.id?" is-current":"")}
        aria-current={section===item.id?"page":undefined}
        onClick={()=>changeSection(item.id)}>
        <span>{item.label}</span>
        {item.count ? <span className="finder-nav-count">{item.count}</span> : null}
       </RareButton>)}
      </div>
     </nav>
    </div>
    <div className="sidebar-resizer" role="separator" aria-orientation="vertical" tabIndex={-1}/>
   </aside>
   <main className="work approval-work">
    <div className="approval-stage">
     {section==="seals"?<SealLibrary isAdmin={user.isAdmin}/>:
      section==="dhf_pilot"?<DHFPilotInbox/>:
      section==="dhf_returns"?<DHFRemediationInbox/>:
      section==="dhf_attestations"?<DHFReviewAttestationInbox/>:
      section==="dhf_verification"?<DHFVerificationInbox/>:
      section==="dhf_credentials"?<DHFCredentialManagement/>:
      section==="dhf_gate_decisions"?<DHFGateDecisionReviewInbox/>:
      section==="dhf_condition_plans"?<DHFConditionalRemediationPlans/>:
      <ApprovalInbox currentUser={user} view={section} onCounts={setCounts} onReview={setReview}/>}
    </div>
    {review&&<ApprovalReviewDialog approval={review} onClose={()=>setReview(null)}/>}
   </main>
  </div>
 </AppShell>;
}
