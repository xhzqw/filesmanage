import {useState} from "react";
import type {Approval} from "../features/workflow/api";
import {ApprovalReviewDialog} from "./ApprovalReviewDialog";
import type{User}from "../entities/user/model";
import{ApprovalInbox}from "../features/workflow/ApprovalInbox";
import{AppShell}from "../shared/ui/AppShell";

export function Approvals({user,onLogout}:{user:User;onLogout:()=>void}){
 const[review,setReview]=useState<Approval|null>(null);
 return <AppShell user={user} onLogout={onLogout}>
  <div className="panels">
   <main className="work">
    <div className="breadcrumb">审批工作台</div>
    <ApprovalInbox currentUser={user} onReview={setReview}/>
    {review&&<ApprovalReviewDialog approval={review} onClose={()=>setReview(null)}/>}
   </main>
  </div>
 </AppShell>;
}
