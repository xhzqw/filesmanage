import {useState} from "react";
import type {Approval} from "../features/workflow/api";
import {RareButton,RareTabs} from "../shared/ui/rare";
import {SealLibrary} from "../features/seals/SealLibrary";
import {ApprovalReviewDialog} from "./ApprovalReviewDialog";
import type{User}from "../entities/user/model";
import{ApprovalInbox}from "../features/workflow/ApprovalInbox";
import{AppShell}from "../shared/ui/AppShell";

export function Approvals({user,onLogout}:{user:User;onLogout:()=>void}){
 const[review,setReview]=useState<Approval|null>(null);
 const[screen,setScreen]=useState<"approvals"|"seals">(()=>new URLSearchParams(window.location.search).get("tab")==="seals"?"seals":"approvals");
 return <AppShell user={user} onLogout={onLogout}>
  <div className="panels">
   <main className="work">
    <div className="breadcrumb">审批工作台</div>
    <RareTabs className="approval-tabs" label="审批与签章">
     <RareButton role="tab" aria-selected={screen==="approvals"} onClick={()=>setScreen("approvals")}>审批工作台</RareButton>
     <RareButton role="tab" aria-selected={screen==="seals"} onClick={()=>setScreen("seals")}>{user.isAdmin?"签章管理":"我的签章"}</RareButton>
    </RareTabs>
    {screen==="approvals"?<ApprovalInbox currentUser={user} onReview={setReview}/>:<SealLibrary isAdmin={user.isAdmin}/>}
    {review&&<ApprovalReviewDialog approval={review} onClose={()=>setReview(null)}/>}
   </main>
  </div>
 </AppShell>;
}
