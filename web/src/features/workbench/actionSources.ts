import {request} from "../../shared/http";
import {workflowApi} from "../workflow/api";

export type WorkSourceKey="approvals"|"dhf-review"|"dhf-verify"|"dhf-remediation";
export type WorkSource={
 key:WorkSourceKey;
 label:string;
 href:string;
 count:number|null;
 truncated:boolean;
 error:boolean;
};

type DHFTask={id:string;status:string};
type DHFVerification={caseId:string;readyToVerify:boolean;verificationId?:string};
type DHFReturn={decisionId:string;canPrepare:boolean;caseId?:string;verificationId?:string};
const sources:Omit<WorkSource,"count"|"truncated"|"error">[]=[
 {key:"approvals",label:"文件修订审批",href:"/workbench?view=approvals&approvalTab=inbox"},
 {key:"dhf-review",label:"DHF 阶段签审（试点）",href:"/workbench?view=dhf-operations&gateTab=review"},
 {key:"dhf-verify",label:"DHF 整改复验（试点）",href:"/workbench?view=dhf-operations&gateTab=verification"},
 {key:"dhf-remediation",label:"DHF 退回整改（试点）",href:"/workbench?view=dhf-operations&gateTab=returns"},
];

/** ACL-scoped read models only. The source service remains the only authority
 * for task permissions, eligibility, write transitions and audit evidence. */
export async function readWorkSources():Promise<WorkSource[]>{
 const readers:Record<WorkSourceKey,()=>Promise<{count:number;truncated?:boolean}>>={
  approvals:async()=>{
   const page=await workflowApi.approvalsPage("inbox","",1);
   return {count:page.pendingCount};
  },
  "dhf-review":async()=>{
   const response=await request<{items:DHFTask[]}>("/workbench/dhf/tasks");
   const items=response.items??[];
   return {count:items.filter(item=>item.status==="pending").length,truncated:items.length>=100};
  },
  "dhf-verify":async()=>{
   const response=await request<{items:DHFVerification[]}>("/workbench/dhf/verifications");
   return {count:(response.items??[]).filter(item=>item.readyToVerify&&!item.verificationId).length};
  },
  "dhf-remediation":async()=>{
   const response=await request<{items:DHFReturn[]}>("/workbench/dhf/returns");
   return {count:(response.items??[]).filter(item=>item.canPrepare&&!item.caseId&&!item.verificationId).length};
  },
 };
 return Promise.all(sources.map(async source=>{
  try{
   const result=await readers[source.key]();
   return {...source,count:result.count,truncated:Boolean(result.truncated),error:false};
  }catch{
   // Never present missing or unauthorized data as a zero count.
   return {...source,count:null,truncated:false,error:true};
  }
 }));
}
