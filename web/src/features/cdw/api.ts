import {request} from "../../shared/http";

export type CDWApprovedCandidate={id:string;fileId:string;fileName:string;sha256:string;approvedAt:string};
export type CDWControlledRelease={id:string;fileId:string;fileName:string;candidateId:string;revisionLabel:string;sha256:string;state:"preparing"|"ready"|"issued_pending"|"effective"|"superseded"|"withdrawn"|"cancelled";revision:number;plannedEffectiveAt?:string};
export type CDWActivationDecision={
 releaseId:string;fileId:string;outcome:"activated"|"blocked";revision:number;
 pointerRevision:number;priorReleaseId?:string;effectiveAt?:string;blockers:string[];
};
export type CDWActivationAttempt={
 id:string;releaseId:string;actorId:string;outcome:"activated"|"blocked"|"failed";
 triggerKind:string;attemptedAt:string;blockers:string[];
};
export type CDWActivationSchedule={
 releaseId:string;sponsorId:string;status:"not_configured"|"enabled"|"paused"|"completed"|"cancelled";
 revision:number;releaseRevision:number;nextAttemptAt:string;attempts:number;
 lastBlockers:string[];lastError?:string;
};
export type CDWEffectiveSearchHit={
 fileId:string;releaseId:string;fileName:string;sha256:string;effectiveAt:string;snippet:string;
};
export type CDWEffectiveSearchPage={items:CDWEffectiveSearchHit[];nextCursor:string};
export type CDWDistributionPlan={
 id:string;releaseId:string;fileId:string;fileName:string;
 state:"draft"|"frozen"|"approved"|"dispatched"|"cancelled";
 revision:number;digestSha256?:string;departmentCount:number;
 targets:Array<{departmentId:string;receiverId:string;channel:string;paperQuantity:number}>;
};
export type CDWDistributionBatch={
 id:string;planId:string;releaseId:string;fileId:string;
 state:"dispatched";revision:number;digestSha256:string;departmentCount:number;
};
export type CDWDistributionWithdrawal={
 id:string;batchId:string;planId:string;releaseId:string;fileId:string;
 state:"withdrawn";planRevision:number;manifestSha256:string;
 revokedGrants:number;cancelledReaders:number;invalidatedTargets:number;
 actorId:string;reason:string;
};
export type CDWDistributionLedgerRow={
 targetId:string;departmentId:string;departmentName:string;
 channel:"electronic"|"paper"|"mixed";paperQuantity:number;paperIssued:number;paperOutstanding:number;
 receiverId:string;receiverName:string;actualSignerId?:string;actualSignerName?:string;
 signedAt?:string;receiptId?:string;receiptStatus:"awaiting"|"received";
 readingAssigned:number;readingConfirmed:number;
 readingStatus:"unassigned"|"awaiting"|"partial"|"confirmed";
 dueAt?:string;overdue:boolean;exceptionReason?:string;
};
export type CDWDistributionLedger={
 planId:string;batchId:string;batchState:"dispatched"|"withdrawn";manifestSha256:string;rows:CDWDistributionLedgerRow[];
 receiptCompleted:number;readingAssigned:number;readingConfirmed:number;
};
export type CDWPaperCopy={
 id:string;copyNo:string;holderId:string;state:"issued"|"collected"|"destroyed"|"lost"|"waived";
 revision:number;lastEventId?:string;lastActorId?:string;lastReason?:string;
};
export type CDWPaperLedger={
 targetId:string;targetRevision:number;fileId:string;batchId:string;channel:string;paperQuantity:number;
 lotId?:string;issued:number;collected:number;destroyed:number;lost:number;waived:number;
 outstanding:number;copies:CDWPaperCopy[];
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
export type CDWReadingRoster={
 id:string;targetId:string;batchId:string;fileId:string;
 departmentId:string;digestSha256:string;assignedCount:number;
};
export type CDWReadingAssignment={
 id:string;rosterId:string;targetId:string;batchId:string;fileId:string;fileName:string;
 revisionLabel:string;artifactSha256:string;userId:string;
 state:"assigned"|"opened"|"confirmed"|"exception"|"cancelled";
};
export type CDWReadingConfirmation={
 assignmentId:string;eventId:string;actorId:string;
 artifactSha256:string;state:"confirmed";confirmedAt:string;
};
export type CDWFormalReady={deliveryId:string;taskId:string;fileId:string;fileName:string;sha256:string};
export type CDWDocumentClassification={fileId:string;approvalClass:"pending"|"general"|"qms";requiresQms:boolean;reason?:string;classifiedBy?:string;roleBindingId?:string};
export type CDWQMSAppointment={id:string;fileId:string;userId:string;nodeKey:string;policyReleaseId:string;evidenceReleaseId:string;expiresAt:string;status:"pending"|"verified"|"revoked";proposedBy:string;verifiedBy?:string;reason:string};
export type CDWQMSPendingReview=CDWQMSAppointment&{fileName:string;evidenceFileId:string;evidenceFileName:string};
export type CDWQMSAppointmentInput={fileId:string;userId:string;nodeKey:string;policyReleaseId:string;evidenceReleaseId:string;expiresAt:string;reason:string};
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
 kind:"task"|"obligation"|"review"|"formal"|"control"|"scope"|"receipt"|"reading";reading?:CDWReadingAssignment;receipt?:CDWReceiptTarget;scope?:CDWDistributionPlan;review?:CDWReviewGate;formal?:CDWFormalApproval;candidate?:CDWApprovedCandidate;taskId:string;title:string;fileId:string;
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
 readingEligible:(targetId:string)=>request<{items:Array<{id:string;displayName:string}>}>(
  "/workbench/distribution-targets/"+segment(targetId)+"/reading-eligible",{cache:"no-store"}),
 readingRoster:(targetId:string,userIds:string[],key:string)=>request<CDWReadingRoster>(
  "/workbench/distribution-targets/"+segment(targetId)+"/reading-roster",mutate(key,{userIds})),
 readingRosterRead:(targetId:string)=>request<CDWReadingRoster>(
  "/workbench/distribution-targets/"+segment(targetId)+"/reading-roster",{cache:"no-store"}),
 readingInbox:()=>request<{items:CDWReadingAssignment[]}>(
  "/workbench/reading-assignments/inbox",{cache:"no-store"}),
 readingConfirm:(id:string,statement:string,key:string)=>request<CDWReadingConfirmation>(
  "/workbench/reading-assignments/"+segment(id)+"/confirm",mutate(key,{statement})),
 receiptInbox:()=>request<{items:CDWReceiptTarget[]}>(
  "/workbench/distribution-targets/inbox",{cache:"no-store"}),
 receiptAcknowledge:(id:string,revision:number,statement:string,key:string)=>request<CDWDepartmentReceipt>(
  "/workbench/distribution-targets/"+segment(id)+"/acknowledge",mutate(key,{statement},revision)),
 controlIssue:(releaseId:string,revision:number,key:string)=>request<CDWControlledRelease>(
  "/workbench/controlled/releases/"+segment(releaseId)+"/issue",mutate(key,{},revision)),
 distributionDispatch:(planId:string,revision:number,key:string)=>request<CDWDistributionBatch>(
  "/workbench/distribution-plans/"+segment(planId)+"/dispatch",mutate(key,{},revision)),
 distributionWithdraw:(planId:string,revision:number,reason:string,key:string)=>request<CDWDistributionWithdrawal>(
  "/workbench/distribution-plans/"+segment(planId)+"/withdraw",mutate(key,{reason},revision)),
 distributionLedger:(planId:string)=>request<CDWDistributionLedger>(
  "/workbench/distribution-plans/"+segment(planId)+"/ledger",{cache:"no-store"}),
 paperLedger:(targetId:string)=>request<CDWPaperLedger>(
  "/workbench/distribution-targets/"+segment(targetId)+"/paper-copies",{cache:"no-store"}),
 paperIssue:(targetId:string,revision:number,copyNumbers:string[],key:string)=>request<CDWPaperLedger>(
  "/workbench/distribution-targets/"+segment(targetId)+"/paper-issue",mutate(key,{copyNumbers},revision)),
 paperEvent:(copyId:string,revision:number,kind:"collected"|"lost"|"destroyed",reason:string,key:string)=>request<{
  copyId:string;eventId:string;kind:string;state:string;revision:number;actorId:string;reason:string
 }>("/workbench/paper-copies/"+segment(copyId)+"/events",mutate(key,{kind,reason},revision)),
 distributionForRelease:(releaseId:string)=>request<CDWDistributionPlan>(
  "/workbench/controlled/releases/"+segment(releaseId)+"/distribution-plan",{cache:"no-store"}),
 distributionCreate:(releaseId:string,targets:Array<{departmentId:string;receiverId:string;channel:string;paperQuantity:number}>,key:string)=>
  request<CDWDistributionPlan>("/workbench/distribution-plans",mutate(key,{releaseId,targets})),
 distributionFreeze:(id:string,revision:number,key:string)=>
  request<CDWDistributionPlan>("/workbench/distribution-plans/"+segment(id)+"/freeze",mutate(key,{},revision)),
 distributionRead:(id:string)=>request<CDWDistributionPlan>("/workbench/distribution-plans/"+segment(id),{cache:"no-store"}),
 controlVerify:(id:string,revision:number,justification:string,key:string)=>
  request<CDWControlledRelease>("/workbench/controlled/releases/"+segment(id)+"/verify",
   mutate(key,{justification,noAdditionalSealRequired:true,noConversionRequired:true},revision)),
 controlCandidates:()=>request<{items:CDWApprovedCandidate[]}>("/workbench/controlled/candidates",{cache:"no-store"}),
 controlEffectiveSearch:(q:string,cursor:string,limit=30)=>request<CDWEffectiveSearchPage>(
  "/workbench/controlled/effective-search?"+new URLSearchParams({q,cursor,limit:String(limit)}).toString(),
  {cache:"no-store"}),
 controlList:(fileId:string)=>request<{items:CDWControlledRelease[]}>("/workbench/controlled/files/"+segment(fileId)+"/releases",{cache:"no-store"}),
 controlActivate:(releaseId:string,revision:number,key:string)=>request<CDWActivationDecision>(
  "/workbench/controlled/releases/"+segment(releaseId)+"/activate",mutate(key,{},revision)),
 controlActivationHistory:(releaseId:string)=>request<{items:CDWActivationAttempt[]}>(
  "/workbench/controlled/releases/"+segment(releaseId)+"/activation-history",{cache:"no-store"}),
 controlScheduleRead:(releaseId:string)=>request<CDWActivationSchedule>(
  "/workbench/controlled/releases/"+segment(releaseId)+"/schedule",{cache:"no-store"}),
 controlScheduleSet:(releaseId:string,revision:number,enabled:boolean,key:string)=>request<CDWActivationSchedule>(
  "/workbench/controlled/releases/"+segment(releaseId)+"/schedule",mutate(key,{enabled},revision)),
 controlGrant:(fileId:string,userId:string,key:string)=>request<{id:string}>("/workbench/controlled/role",mutate(key,{fileId,userId})),
 controlPrepare:(candidateId:string,revisionLabel:string,plannedEffectiveAt:string|undefined,key:string)=>
  request<CDWControlledRelease>("/workbench/controlled/releases",mutate(key,{candidateId,revisionLabel,...(plannedEffectiveAt?{plannedEffectiveAt}:{})})),
 formalReady:()=>request<{items:CDWFormalReady[]}>("/workbench/formal-approvals/ready",{cache:"no-store"}),
 formalClass:(fileId:string)=>request<CDWDocumentClassification>(
  "/workbench/formal-documents/"+segment(fileId)+"/classification",{cache:"no-store"}),
 formalClassify:(fileId:string,approvalClass:"general"|"qms",reason:string,key:string)=>request<CDWDocumentClassification>(
  "/workbench/formal-documents/"+segment(fileId)+"/classification",mutate(key,{approvalClass,reason})),
 qmsAppointments:(fileId:string)=>request<{items:CDWQMSAppointment[]}>(
  "/workbench/qms-appointments/files/"+segment(fileId),{cache:"no-store"}),
 qmsPendingReview:()=>request<{items:CDWQMSPendingReview[]}>(
  "/workbench/qms-appointments/pending",{cache:"no-store"}),
 qmsAppointmentPropose:(input:CDWQMSAppointmentInput,key:string)=>request<CDWQMSAppointment>(
  "/workbench/qms-appointments",mutate(key,input)),
 qmsAppointmentVerify:(id:string,statement:string,key:string)=>request<CDWQMSAppointment>(
  "/workbench/qms-appointments/"+segment(id)+"/verify",mutate(key,{statement})),
 formalInbox:(limit=100)=>request<{items:CDWFormalApproval[]}>(
  "/workbench/formal-approvals/inbox?limit="+limit,{cache:"no-store"}),
 formalDetail:(id:string)=>request<CDWFormalDetail>("/workbench/formal-approvals/"+segment(id),{cache:"no-store"}),
 formalDecide:(id:string,revision:number,decision:"approve"|"reject",reason:string,key:string)=>
  request<CDWFormalApproval>("/workbench/formal-approvals/"+segment(id)+"/decide",mutate(key,{decision,reason},revision)),
 formalPublish:(templateKey:string,steps:Array<{nodeKey:string;sequence:number;approverId:string}>,key:string,authorityBasisReleaseId?:string)=>
  request<{id:string}>("/workbench/formal-templates",mutate(key,{templateKey,steps,...(authorityBasisReleaseId?{authorityBasisReleaseId}:{})})),
 formalGrant:(fileId:string,userId:string,key:string,authorityBasisReleaseId?:string)=>
  request<{id:string}>("/workbench/formal-roles",mutate(key,{fileId,userId,...(authorityBasisReleaseId?{authorityBasisReleaseId}:{})})),
 formalStart:(deliveryId:string,templateVersionId:string,key:string)=>
  request<CDWFormalApproval>("/workbench/formal-approvals",mutate(key,{deliveryId,templateVersionId})),
 fulfillObligation:(id:string,revision:number,statement:string,key:string)=>
  request<CDWObligationFulfillment>("/workbench/obligations/"+segment(id)+"/fulfill",mutate(key,{statement},revision)),
 resume:(taskId:string,revision:number,key:string)=>
  request<CDWResumeResult>("/workbench/tasks/"+segment(taskId)+"/resume",mutate(key,{},revision)),
};
