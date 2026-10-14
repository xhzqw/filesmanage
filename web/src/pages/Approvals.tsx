import {useState} from "react";
import {useSearchParams} from "react-router-dom";
import type {Approval} from "../features/workflow/api";
import {RareButton} from "../shared/ui/rare";
import {SealLibrary} from "../features/seals/SealLibrary";
import {ApprovalReviewDialog} from "./ApprovalReviewDialog";
import type {User} from "../entities/user/model";
import {ApprovalInbox,type ApprovalView} from "../features/workflow/ApprovalInbox";
import {AppShell} from "../shared/ui/AppShell";

type Section=ApprovalView|"seals";

export function Approvals({user,onLogout}:{user:User;onLogout:()=>void}){
 const[review,setReview]=useState<Approval|null>(null);
 const[params,setParams]=useSearchParams();
 const requested=params.get("tab");
 const section:Section=requested==="mine"||requested==="notifications"||requested==="seals"||(user.isAdmin&&requested==="all_pending")?requested:"inbox";
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
 ];
 return <AppShell user={user} onLogout={onLogout}>
  <div className="panels">
   <main className="work approval-work">
    <div className="approval-shell">
     <nav className="approval-nav" aria-label="审批工作区">
      <div className="approval-nav-heading">审批</div>
      {navigation.map(item=><RareButton type="button" key={item.id}
       className="approval-nav-item" aria-current={section===item.id?"page":undefined}
       onClick={()=>changeSection(item.id)}>
       <span>{item.label}</span>{item.count? <span className="approval-nav-count">{item.count}</span>:null}
      </RareButton>)}
     </nav>
     <div className="approval-stage">
      {section==="seals"?<SealLibrary isAdmin={user.isAdmin}/>:
       <ApprovalInbox currentUser={user} view={section} onCounts={setCounts} onReview={setReview}/>}
     </div>
    </div>
    {review&&<ApprovalReviewDialog approval={review} onClose={()=>setReview(null)}/>}
   </main>
  </div>
 </AppShell>;
}
