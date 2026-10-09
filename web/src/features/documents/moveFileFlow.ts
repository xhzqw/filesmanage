import type {FileItem} from "../../entities/file/model";
import type {Folder} from "../../entities/folder/model";

// Single-file move flow (COMPLEX-WORKFLOWS-v1 §2.2/§3, WF-01..WF-06).
// Transitions are pure and take the previous flow back in, so the rule the
// picker depends on is reviewable on its own: every new candidate drops the
// previous preflight, and only a checked candidate may submit (WF-05).

export type MoveFlowState="idle"|"candidate"|"validating"|"ready"|"conflict"|"submitting"|"succeeded"|"failed";

export type MoveResult={fileId:string;fromFolderId:string;toFolderId:string};

export type MoveFlow={
 state:MoveFlowState;
 targetId:string;
 notice:string;
 result?:MoveResult;
};

// Preflight reply (draft A). candidateRevision is opaque and carries no
// authorization; sourceSummary/targetSummary are already visibility-filtered
// server-side, so they never leak a hidden ancestor.
export type MovePreflight={
 status:"ready"|"conflict"|"forbidden";
 candidateRevision:string;
 allowedCount:number;
 conflicts:{id:string;code:string;message?:string}[];
 warnings:string[];
 sourceSummary:string;
 targetSummary:string;
};

export const initialMoveFlow:MoveFlow={state:"idle",targetId:"",notice:""};

// Opening the picker enters the candidate step with no target chosen yet.
export function openFlow():MoveFlow{
 return {state:"candidate",targetId:"",notice:""};
}

// Any pick — the same folder included — returns to the unverified candidate
// step: the confirm action may only follow a check of what is currently shown.
export function pickTarget(flow:MoveFlow,targetId:string):MoveFlow{
 return {state:"candidate",targetId,notice:""};
}

export function preflightStarted(flow:MoveFlow):MoveFlow{
 return {state:"validating",targetId:flow.targetId,notice:""};
}

export function preflightReady(flow:MoveFlow):MoveFlow{
 return {state:"ready",targetId:flow.targetId,notice:""};
}

export function preflightConflict(flow:MoveFlow,notice:string):MoveFlow{
 return {state:"conflict",targetId:flow.targetId,notice};
}

export function submitStarted(flow:MoveFlow):MoveFlow{
 return {state:"submitting",targetId:flow.targetId,notice:""};
}

export function succeeded(flow:MoveFlow,result:MoveResult):MoveFlow{
 return {state:"succeeded",targetId:flow.targetId,notice:"",result};
}

// A server rejection or an unknown network outcome. The candidate stays visible
// so the user can retry or change it; the caller decides whether a refresh is
// the only safe next step.
export function failed(flow:MoveFlow,notice:string):MoveFlow{
 return {state:"failed",targetId:flow.targetId,notice};
}

// Client-side structural rule only. Permissions and name conflicts are the
// server's answer — the preflight and the commit transaction both re-verify
// them — so they are never guessed here. `visible` is the tree the host
// loaded; a folder outside it is not a target this flow may offer.
export function fileMoveInvalidTarget(folder:Folder,source:FileItem,visible?:Folder[]):string|null{
 if(folder.id===source.folderId)return "文件已在该目录";
 if(visible&&!visible.some(item=>item.id===folder.id))return "目标目录不可见";
 return null;
}

// Batch move flow (COMPLEX-WORKFLOWS-v1 §3.1/§3.2 C, WF-07/WF-08, ADR-UX-02).
// The all-or-nothing endpoint makes one server-side decision, so there is no
// preflight step and no per-file CAS: `candidate → submitting → succeeded |
// conflict | failed`. A conflict reply itemises the failing resources and
// wrote nothing, so the only paths forward are a new candidate, an explicit
// exclusion of the problem items, or a refresh.

export type BatchMoveState="candidate"|"submitting"|"succeeded"|"conflict"|"failed";

export type BatchMoveResult={fileId:string;fromFolderId:string;toFolderId:string};

export type BatchMoveConflict={id:string;code:string;message?:string};

export type BatchMoveFlow={
 state:BatchMoveState;
 targetId:string;
 notice:string;
 conflicts:BatchMoveConflict[];
 moved:BatchMoveResult[];
};

export function openBatch():BatchMoveFlow{
 return {state:"candidate",targetId:"",notice:"",conflicts:[],moved:[]};
}

// Any pick — the same folder included — voids the previous conflict list and
// move summary: they describe a submission the current candidate no longer
// matches.
export function batchPickTarget(_flow:BatchMoveFlow,targetId:string):BatchMoveFlow{
 return {state:"candidate",targetId,notice:"",conflicts:[],moved:[]};
}

export function batchSubmitStarted(flow:BatchMoveFlow):BatchMoveFlow{
 return {state:"submitting",targetId:flow.targetId,notice:"",conflicts:[],moved:[]};
}

export function batchSucceeded(flow:BatchMoveFlow,moved:BatchMoveResult[]):BatchMoveFlow{
 return {state:"succeeded",targetId:flow.targetId,notice:"",conflicts:[],moved};
}

// Nothing was written: the itemised conflicts stay on screen until the user
// changes the target or explicitly narrows the pending set.
export function batchConflict(flow:BatchMoveFlow,conflicts:BatchMoveConflict[]):BatchMoveFlow{
 return {state:"conflict",targetId:flow.targetId,notice:"",conflicts,moved:[]};
}

// Exclude-and-retry (ADR-UX-02): the caller removes the conflicting ids from
// its own pending set and returns to the candidate step, where the remainder
// can be submitted again. The flow never narrows the set by itself.
export function batchExcluded(flow:BatchMoveFlow,notice:string):BatchMoveFlow{
 return {state:"candidate",targetId:flow.targetId,notice,conflicts:[],moved:[]};
}

// A server rejection or an unknown network outcome. The candidate stays visible
// so the user can retry or change it; the caller decides whether a refresh is
// the only safe next step.
export function batchFailed(flow:BatchMoveFlow,notice:string):BatchMoveFlow{
 return {state:"failed",targetId:flow.targetId,notice,conflicts:[],moved:[]};
}

// Client-side structural rule only, mirroring fileMoveInvalidTarget: a target
// outside the loaded visible tree is never offered, and a folder that already
// holds the whole selection is a no-op. Per-file permissions and name
// conflicts stay the server's answer — never silently skipped, but reported
// per item by the all-or-nothing commit.
export function batchMoveInvalidTarget(folder:Folder,sources:FileItem[],visible?:Folder[]):string|null{
 if(visible&&!visible.some(item=>item.id===folder.id))return "目标目录不可见";
 if(sources.length>0&&sources.every(source=>source.folderId===folder.id))return "所选文件已全部在该目录";
 return null;
}
