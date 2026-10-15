import {request} from "../../shared/http";

export type CDWApprovedCandidate={id:string;fileId:string;fileName:string;sha256:string;approvedAt:string};
export type CDWControlledRelease={id:string;fileId:string;fileName:string;candidateId:string;revisionLabel:string;sha256:string;state:"preparing"|"ready"|"issued_pending"|"effective"|"superseded"|"withdrawn"|"cancelled";revision:number;plannedEffectiveAt?:string};
export type CDWDistributionPlan={
 id:string;releaseId:string;fileId:string;fileName:string;
 state:"draft"|"frozen"|"approved"|"dispatched"|"cancelled";
 revision:number;digestSha256?:string;departmentCount:number;
 targets:Array<{departmentId:string;receiverId:string}>;
};
export type CDWDistributionBatch={
 id:string;planId:string;releaseId:string;fileId:string;
 state:"dispatched";revision:number;digestSha256:string;departmentCount:number;
};
export type CDWReceiptTarget={
 targetId:string;batchId:string;fileId:string;fileName:string;
 revisionLabel:string;departmentId:string;receiverId:string;
 manifestSha256:string;artifactSha256:string;state:"awaiting"|"received";revision:number;
};
export type CDWDepartmentReceipt={
 receiptId:string;targetId:string;batchId:string;fileId:string;actorId:string;
 state:"received";revision:number;manifestSha256:string;evidenceSha256:string;signedAt:string;
};
export type CDWFormalReady={deliveryId:string;taskId:string;fileId:string;fileName:string;sha256:string};
export type CDWFormalApproval={
 id:string;subjectId:string;deliveryId:string;fileId:string;fileName?:string;
 sha256:string;templateVersionId:string;state:"pending"|"approved"|"rejected"|"cancelled"|"conflicted";
 revision:number;candidateId?:string;requestedBy:string;
};
export type CDWFormalStep={id:string;nodeKey:string;sequence:number;approverId:string;state:string;revision:number};
export type CDWFormalDetail={approval:CDWFormalApproval;steps:CDWFormalStep[];
 decisions:Array<{stepId:string;actorId:string;decision:string;reason:string;decidedAt:string}>};
export type CDWObligationFulfillment={
 obligationId:string;taskId:string;fileId:string;kind:string;state:"fulfilled";
 revision:number;fulfilledBy:string;evidenceSha256:string;fulfilledAt:string;
};
export type CDWRecipient={kind:"user"|"workgroup";id:string};
export type CDWTask={
 taskId:string;parentTaskId?:string;parentRevision?:number;
 state:string;revision:number;assignmentId:string;
 actualAcceptorId?:string;remainingObligations?:string[];
};
export type CDWInboxItem={
 kind:"task"|"obligation"|"review"|"formal"|"control"|"scope"|"receipt";receipt?:CDWReceiptTarget;scope?:CDWDistributionPlan;review?:CDWReviewGate;formal?:CDWFormalApproval;candidate?:CDWApprovedCandidate;taskId:string;title:string;fileId:string;
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
export type CDWOverrideGrant={
 grantId:string;gateId:string;taskId:string;grantedBy:string;
 actorId:string;expiresAt:string;revoked:boolean;
};
export type CDWReviewGate={
 gateId:string;deliveryId:string;taskId:string;taskTitle:string;
 fileId:string;submittedBy:string;reviewerId:string;
 branchRevisionId:string;sha256:string;state:string;revision:number;round:number;
 substitutable:boolean;overrideGrantId?:string;reviewMode:"direct"|"delegated";
};
export type CDWReviewResult={
 gateId:string;deliveryId:string;taskId:string;state:string;
 taskState:string;revision:number;round:number;returnOrderId?:string;
 overrideGrantId?:string;actingForId?:string;
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
 create:(input:{title:string;fileId:string;assignee:CDWRecipient;allowOverrideReview?:boolean},key:string)=>
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
 reviewDecide:(id:string,revision:number,decision:"accept"|"return",reason:string,key:string,overrideGrantId?:string)=>
  request<CDWReviewResult>("/workbench/review-gates/"+segment(id)+"/decide",mutate(key,{decision,reason,overrideGrantId},revision)),
 reviewGrants:(id:string)=>request<{items:CDWOverrideGrant[]}>("/workbench/review-gates/"+segment(id)+"/grants",{cache:"no-store"}),
 reviewCandidates:(id:string)=>request<{items:Array<{id:string;displayName:string}>}>("/workbench/review-gates/"+segment(id)+"/candidates",{cache:"no-store"}),
 reviewGrant:(id:string,revision:number,actorId:string,reason:string,key:string)=>
  request<CDWOverrideGrant>("/workbench/review-gates/"+segment(id)+"/grants",mutate(key,{actorId,reason},revision)),
 reviewRevoke:(id:string,grantId:string,key:string)=>
  request<CDWOverrideGrant>("/workbench/review-gates/"+segment(id)+"/grants/"+segment(grantId)+"/revoke",mutate(key,{})),
 scopeInbox:()=>request<{items:CDWDistributionPlan[]}>(
  "/workbench/distribution-scope/inbox",{cache:"no-store"}),
 scopeGrant:(fileId:string,userId:string,key:string)=>request<{id:string}>(
  "/workbench/distribution-scope-roles",mutate(key,{fileId,userId})),
 scopeApprove:(id:string,revision:number,key:string)=>request<CDWDistributionPlan>(
  "/workbench/distribution-plans/"+segment(id)+"/approve-scope",mutate(key,{},revision)),
 receiptInbox:()=>request<{items:CDWReceiptTarget[]}>(
  "/workbench/distribution-targets/inbox",{cache:"no-store"}),
 receiptAcknowledge:(id:string,revision:number,statement:string,key:string)=>request<CDWDepartmentReceipt>(
  "/workbench/distribution-targets/"+segment(id)+"/acknowledge",mutate(key,{statement},revision)),
 controlIssue:(releaseId:string,revision:number,key:string)=>request<CDWControlledRelease>(
  "/workbench/controlled/releases/"+segment(releaseId)+"/issue",mutate(key,{},revision)),
 distributionDispatch:(planId:string,revision:number,key:string)=>request<CDWDistributionBatch>(
  "/workbench/distribution-plans/"+segment(planId)+"/dispatch",mutate(key,{},revision)),
 distributionForRelease:(releaseId:string)=>request<CDWDistributionPlan>(
  "/workbench/controlled/releases/"+segment(releaseId)+"/distribution-plan",{cache:"no-store"}),
 distributionCreate:(releaseId:string,targets:Array<{departmentId:string;receiverId:string}>,key:string)=>
  request<CDWDistributionPlan>("/workbench/distribution-plans",mutate(key,{releaseId,targets})),
 distributionFreeze:(id:string,revision:number,key:string)=>
  request<CDWDistributionPlan>("/workbench/distribution-plans/"+segment(id)+"/freeze",mutate(key,{},revision)),
 distributionRead:(id:string)=>request<CDWDistributionPlan>("/workbench/distribution-plans/"+segment(id),{cache:"no-store"}),
 controlVerify:(id:string,revision:number,justification:string,key:string)=>
  request<CDWControlledRelease>("/workbench/controlled/releases/"+segment(id)+"/verify",
   mutate(key,{justification,noAdditionalSealRequired:true,noConversionRequired:true},revision)),
 controlCandidates:()=>request<{items:CDWApprovedCandidate[]}>("/workbench/controlled/candidates",{cache:"no-store"}),
 controlList:(fileId:string)=>request<{items:CDWControlledRelease[]}>("/workbench/controlled/files/"+segment(fileId)+"/releases",{cache:"no-store"}),
 controlGrant:(fileId:string,userId:string,key:string)=>request<{id:string}>("/workbench/controlled/role",mutate(key,{fileId,userId})),
 controlPrepare:(candidateId:string,revisionLabel:string,plannedEffectiveAt:string|undefined,key:string)=>
  request<CDWControlledRelease>("/workbench/controlled/releases",mutate(key,{candidateId,revisionLabel,...(plannedEffectiveAt?{plannedEffectiveAt}:{})})),
 formalReady:()=>request<{items:CDWFormalReady[]}>("/workbench/formal-approvals/ready",{cache:"no-store"}),
 formalInbox:(limit=100)=>request<{items:CDWFormalApproval[]}>(
  "/workbench/formal-approvals/inbox?limit="+limit,{cache:"no-store"}),
 formalDetail:(id:string)=>request<CDWFormalDetail>("/workbench/formal-approvals/"+segment(id),{cache:"no-store"}),
 formalDecide:(id:string,revision:number,decision:"approve"|"reject",reason:string,key:string)=>
  request<CDWFormalApproval>("/workbench/formal-approvals/"+segment(id)+"/decide",mutate(key,{decision,reason},revision)),
 formalPublish:(templateKey:string,steps:Array<{nodeKey:string;sequence:number;approverId:string}>,key:string)=>
  request<{id:string}>("/workbench/formal-templates",mutate(key,{templateKey,steps})),
 formalGrant:(fileId:string,userId:string,key:string)=>
  request<{id:string}>("/workbench/formal-roles",mutate(key,{fileId,userId})),
 formalStart:(deliveryId:string,templateVersionId:string,key:string)=>
  request<CDWFormalApproval>("/workbench/formal-approvals",mutate(key,{deliveryId,templateVersionId})),
 fulfillObligation:(id:string,revision:number,statement:string,key:string)=>
  request<CDWObligationFulfillment>("/workbench/obligations/"+segment(id)+"/fulfill",mutate(key,{statement},revision)),
 resume:(taskId:string,revision:number,key:string)=>
  request<CDWResumeResult>("/workbench/tasks/"+segment(taskId)+"/resume",mutate(key,{},revision)),
};
