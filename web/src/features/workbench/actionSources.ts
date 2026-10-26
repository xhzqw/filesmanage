import {request} from "../../shared/http";
import {workflowApi} from "../workflow/api";

export type WorkSourceKey="approvals"|"dhf-review"|"dhf-verify"|"dhf-remediation";
export type WorkActionRef={
 id:string;
 title:string;
 context:string;
 href:string;
};
export type WorkSource={
 key:WorkSourceKey;
 label:string;
 href:string;
 count:number|null;
 truncated:boolean;
 error:boolean;
 items:WorkActionRef[];
};

type DHFTask={id:string;status:string;projectId:string;stageId:string;reviewKey:string};
type DHFVerification={caseId:string;projectId:string;stageId:string;readyToVerify:boolean;verificationId?:string};
type DHFReturn={decisionId:string;projectId:string;stageId:string;canPrepare:boolean;caseId?:string;verificationId?:string};
const sources:Omit<WorkSource,"count"|"truncated"|"error"|"items">[]=[
 {key:"approvals",label:"文件修订审批",href:"/workbench?view=approvals&approvalTab=inbox"},
 {key:"dhf-review",label:"DHF 阶段签审（试点）",href:"/workbench?view=dhf-operations&gateTab=review"},
 {key:"dhf-verify",label:"DHF 整改复验（试点）",href:"/workbench?view=dhf-operations&gateTab=verification"},
 {key:"dhf-remediation",label:"DHF 退回整改（试点）",href:"/workbench?view=dhf-operations&gateTab=returns"},
];

/** ACL-scoped read models only. The source service remains the only authority
 * for task permissions, eligibility, write transitions and audit evidence. */
export async function readWorkSources():Promise<WorkSource[]>{
 const readers:Record<WorkSourceKey,()=>Promise<{count:number;truncated?:boolean;items:WorkActionRef[]}>>={
  approvals:async()=>{
   const page=await workflowApi.approvalsPage("inbox","",10);
   return {count:page.pendingCount,items:page.items.filter(row=>row.state==="pending").slice(0,3).map(row=>({
    id:"approvals:"+row.id,
    title:row.fileName,
    context:row.action==="rollback"?"文件版本回退审批":"文件修订审批",
    href:"/workbench?view=approvals&approvalTab=inbox&item="+encodeURIComponent(row.id),
   }))};
  },
  "dhf-review":async()=>{
   const response=await request<{items:DHFTask[]}>("/workbench/dhf/tasks");
   const items=response.items??[];
   const pending=items.filter(item=>item.status==="pending");
   return {count:pending.length,truncated:items.length>=100,
    items:pending.slice(0,3).map(item=>({
     id:"dhf-review:"+item.id,
     title:item.stageId+" · "+(item.reviewKey==="__gate__"?"阶段总复核":item.reviewKey),
     context:"DHF 项目 "+item.projectId,
     href:"/workbench?view=dhf-operations&gateTab=review&dhfReviewTask="+encodeURIComponent(item.id),
    }))};
  },
  "dhf-verify":async()=>{
   const response=await request<{items:DHFVerification[]}>("/workbench/dhf/verifications");
   const items=response.items??[];
   const pending=items.filter(item=>item.readyToVerify&&!item.verificationId);
   return {count:pending.length,truncated:items.length>=100,
    items:pending.slice(0,3).map(item=>({
     id:"dhf-verify:"+item.caseId,
     title:item.stageId+" · 待整改复验",
     context:"DHF 项目 "+item.projectId,
     href:"/workbench?view=dhf-operations&gateTab=verification&dhfVerificationCase="+encodeURIComponent(item.caseId),
    }))};
  },
  "dhf-remediation":async()=>{
   const response=await request<{items:DHFReturn[]}>("/workbench/dhf/returns");
   const items=response.items??[];
   const pending=items.filter(item=>item.canPrepare&&!item.caseId&&!item.verificationId);
   return {count:pending.length,truncated:items.length>=100,
    items:pending.slice(0,3).map(item=>({
     id:"dhf-remediation:"+item.decisionId,
     title:item.stageId+" · 待退回整改",
     context:"DHF 项目 "+item.projectId,
     href:"/workbench?view=dhf-operations&gateTab=returns&dhfReturnDecision="+encodeURIComponent(item.decisionId),
    }))};
  },
 };
 return Promise.all(sources.map(async source=>{
  try{
   const result=await readers[source.key]();
   return {...source,count:result.count,truncated:Boolean(result.truncated),error:false,items:result.items};
  }catch{
   // Never present missing or unauthorized data as a zero count.
   return {...source,count:null,truncated:false,error:true,items:[]};
  }
 }));
}
