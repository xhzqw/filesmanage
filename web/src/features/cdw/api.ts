import {request} from "../../shared/http";

export type CDWRecipient={kind:"user"|"workgroup";id:string};
export type CDWTask={
 taskId:string;parentTaskId?:string;parentRevision?:number;
 state:string;revision:number;assignmentId:string;
 actualAcceptorId?:string;remainingObligations?:string[];
};
export type CDWInboxItem={
 kind:"task"|"obligation"|"review";review?:CDWReviewGate;taskId:string;title:string;fileId:string;
 state:string;revision:number;assignmentId?:string;obligationId?:string;obligationKind?:string;
};
export type CDWBranch={
 branchId:string;taskId:string;fileId:string;baseVersionId:string;
 baseSha256:string;state:"open"|"fencing"|"frozen"|"closed"|"cancelled";
 revision:number;headRevisionId?:string;editEpoch:number;
};
export type CDWOfficeSession={
 branch:CDWBranch;
 session:{sessionId:string;branchId:string;documentKey:string;expiresAt:string;editEpoch:number};
 editorUrl:string;config:Record<string,unknown>;
};
export type CDWSave={
 requestId:string;branchId:string;sessionId:string;
 state:"requested"|"accepted"|"unknown"|"persisted"|"failed";
 persistedRevisionId?:string;sha256?:string;generation:number;editEpoch:number;
};
export type CDWReviewGate={
 gateId:string;deliveryId:string;taskId:string;taskTitle:string;
 fileId:string;submittedBy:string;reviewerId:string;
 branchRevisionId:string;sha256:string;state:string;revision:number;round:number;
};
export type CDWReviewResult={
 gateId:string;deliveryId:string;taskId:string;state:string;
 taskState:string;revision:number;round:number;returnOrderId?:string;
};
export type CDWResumeResult={
 taskId:string;branchId:string;revision:number;round:number;state:string;
};
export type CDWDelivery={
 deliveryId:string;branchId:string;taskId:string;branchRevisionId:string;
 sha256:string;reviewGateId:string;revision:number;
};

// Shared transport owns cookies, authorization failures and error mapping.
// Every write with an idempotency header retains the caller's key across retries.
const segment=(id:string)=>encodeURIComponent(id);
const mutate=(key:string,body:object,revision?:number)=>({
 method:"POST",headers:{"Idempotency-Key":key,...(revision?{"If-Match":'"rev-'+revision+'"'}:{})},
 body:JSON.stringify(body)
});
export const cdwApi={
 inbox:(limit=100,signal?:AbortSignal)=>request<{items:CDWInboxItem[];nextCursor:null;asOf:string}>(
  "/workbench/inbox?limit="+limit,{signal,cache:"no-store"}),
 create:(input:{title:string;fileId:string;assignee:CDWRecipient},key:string)=>
  request<CDWTask>("/workbench/tasks",mutate(key,input)),
 accept:(taskId:string,revision:number,key:string)=>
  request<CDWTask>("/workbench/tasks/"+segment(taskId)+"/accept",mutate(key,{},revision)),
 delegate:(taskId:string,revision:number,input:{childTitle:string;assignee:CDWRecipient},key:string)=>
  request<CDWTask>("/workbench/tasks/"+segment(taskId)+"/delegate",mutate(key,input,revision)),
 branches:(taskId:string)=>request<{items:CDWBranch[]}>("/workbench/tasks/"+segment(taskId)+"/branches",{cache:"no-store"}),
 createBranch:(taskId:string,key:string)=>
  request<CDWBranch>("/work-branches",mutate(key,{taskId})),
 branch:(id:string)=>request<CDWBranch>("/work-branches/"+segment(id),{cache:"no-store"}),
 openOffice:(id:string)=>request<CDWOfficeSession>("/work-branches/"+segment(id)+"/office-sessions",{method:"POST",body:"{}"}),
 touchOffice:(id:string,sessionId:string)=>request<CDWOfficeSession["session"]>(
  "/work-branches/"+segment(id)+"/office-sessions/"+segment(sessionId)+"/heartbeat",
  {method:"POST",body:"{}"}),
 requestSave:(branchId:string,sessionId:string,key:string)=>request<CDWSave>(
  "/work-branches/"+segment(branchId)+"/save",mutate(key,{sessionId})),
 saveStatus:(branchId:string,requestId:string)=>request<CDWSave>(
  "/work-branches/"+segment(branchId)+"/save-requests/"+segment(requestId),{cache:"no-store"}),
 freeze:(branchId:string,revision:number,requestId:string,branchRevisionId:string,key:string)=>
  request<CDWDelivery>("/work-branches/"+segment(branchId)+"/freeze-delivery",
   mutate(key,{requestId,branchRevisionId},revision)),
 reviewInbox:(limit=100)=>request<{items:CDWReviewGate[]}>("/workbench/review-gates/inbox?limit="+limit,{cache:"no-store"}),
 reviewGate:(id:string)=>request<CDWReviewGate>("/workbench/review-gates/"+segment(id),{cache:"no-store"}),
 reviewDecide:(id:string,revision:number,decision:"accept"|"return",reason:string,key:string)=>
  request<CDWReviewResult>("/workbench/review-gates/"+segment(id)+"/decide",mutate(key,{decision,reason},revision)),
 resume:(taskId:string,revision:number,key:string)=>
  request<CDWResumeResult>("/workbench/tasks/"+segment(taskId)+"/resume",mutate(key,{},revision)),
};
