import {useState} from "react";
import type {Approval} from "../features/workflow/api";
import {GooeyNav} from "../shared/ui/rare";
import {useSearchParams} from "react-router-dom";
import {SealLibrary} from "../features/seals/SealLibrary";
import {ApprovalReviewDialog} from "./ApprovalReviewDialog";
import type{User}from "../entities/user/model";
import{ApprovalInbox}from "../features/workflow/ApprovalInbox";
import{AppShell}from "../shared/ui/AppShell";
import "./approvalsWorkbench.css";

export function Approvals({user,onLogout}:{user:User;onLogout:()=>void}){
 const[review,setReview]=useState<Approval|null>(null);
 const[params,setParams]=useSearchParams();
 const screen=params.get("tab")==="seals"?"seals":"approvals";
 return <AppShell user={user} onLogout={onLogout}>
  <div className="panels">
   <main className="work approval-root">
    <div className="approval-root-switch">
     <GooeyNav className="approval-root-nav" aria-label="审批与签章视图" size="sm" radius={8} separation={12}
      items={["审批工作台",user.isAdmin?"签章管理":"我的签章"]}
      value={screen==="seals"?1:0} activeColor="var(--brand-blue)" activeLabelColor="var(--text-inverse)"
      onChange={index=>setParams(old=>{
       const next=new URLSearchParams(old);
       if(index===0)next.delete("tab");else next.set("tab","seals");
       return next;
      })}/>
    </div>
    <div className="approval-root-stage">
     {screen==="approvals"?<ApprovalInbox currentUser={user} onReview={setReview}/>:<SealLibrary isAdmin={user.isAdmin}/>}
    </div>
    {review&&<ApprovalReviewDialog approval={review} onClose={()=>setReview(null)}/>}
   </main>
  </div>
 </AppShell>;
}
