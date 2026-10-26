import {useState} from "react";
import {useSearchParams} from "react-router-dom";
import type {User} from "../entities/user/model";
import type {Approval} from "../features/workflow/api";
import {RareButton} from "../shared/ui/rare";
import {ApprovalInbox,type ApprovalView} from "../features/workflow/ApprovalInbox";
import {ApprovalReviewDialog} from "./ApprovalReviewDialog";

export function WorkbenchApprovals({user}:{user:User}){
 const [params,setParams]=useSearchParams();
 const [review,setReview]=useState<Approval|null>(null);
 const [counts,setCounts]=useState({pending:0,unread:0});
 const raw=params.get("approvalTab");
 const view:ApprovalView=raw==="mine"||raw==="notifications"||(raw==="all_pending"&&user.isAdmin)?raw:"inbox";
 const options:{key:ApprovalView;label:string;count?:number}[]=[
  {key:"inbox",label:"待我审批",count:counts.pending},
  {key:"mine",label:"我发起的"},
  {key:"notifications",label:"通知",count:counts.unread},
  ...(user.isAdmin?[{key:"all_pending" as const,label:"全部待审批"}]:[])
 ];
 function change(next:ApprovalView){
  setParams(prev=>{const p=new URLSearchParams(prev);p.set("view","approvals");p.set("approvalTab",next);return p;});
 }
 return <section className="wbv2-approvals" aria-label="审批与经办工作区">
  <div className="wbv2-approvals-head">
   <p className="wbv2-eyebrow">APPROVALS / 审批与经办</p>
   <h2>我的审批工作</h2>
   <p>审批依据、处理记录及申请进度均在原有受控审批流程中保留。</p>
  </div>
  <div className="wbv2-approvals-tabs" role="group" aria-label="审批队列筛选">
   {options.map(({key,label,count})=><RareButton key={key} type="button" tone="ghost"
    className={view===key?"is-current":""} aria-pressed={view===key}
    onClick={()=>change(key)}>{label}{count?<span>{count}</span>:null}</RareButton>)}
  </div>
  <div className="wbv2-approvals-content">
   <ApprovalInbox currentUser={user} view={view} onCounts={setCounts} onReview={setReview}/>
  </div>
  {review?<ApprovalReviewDialog approval={review} onClose={()=>setReview(null)}/>:null}
 </section>;
}
