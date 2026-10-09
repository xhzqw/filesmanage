import type {Folder} from "../../entities/folder/model";
import {errorCode,errorCopy} from "../../shared/errors";

// Single-folder move flow (COMPLEX-WORKFLOWS-v1 §2.2/§3, WF-01/WF-02/WF-04).
// There is no folder preflight endpoint, so the client only judges structure
// from the visible tree; permissions, cycles and folder activity stay
// server-side facts re-validated inside the move transaction.
export type FolderMoveStep="idle"|"candidate"|"submitting"|"succeeded"|"failed";

export type FolderMoveState={
 step:FolderMoveStep;
 targetId:string;
 notice:string;
 // The request broke before a result arrived: the outcome is unknown and must
 // be re-read instead of repeated (COMPLEX-WORKFLOWS §4.2).
 unknown:boolean;
};

export const FOLDER_MOVE_NOTICE={
 // The folder handler rejects a self/descendant/cyclic target as E_BAD (the
 // hierarchy guard in migrations/0003 raises a check violation) and a target
 // that already holds the same child name as E_NAME_CONFLICT (409).
 selfOrDescendant:"目标不允许：不能移动到自身或其子目录",
 forbidden:"没有权限移动到该目录",
 nameConflict:"目标目录已存在同名目录，请更换目标",
 unknown:"网络中断，无法确认是否已移动，请刷新查看状态",
};

export function folderMoveIdle():FolderMoveState{
 return {step:"idle",targetId:"",notice:"",unknown:false};
}

// Structural target rules only: the source itself, a visible descendant of it,
// and a folder the caller cannot see are not selectable targets. The server
// remains the authority on permissions and on cycles it can see but the client
// cannot (an ancestor hidden from the visible set).
export function folderMoveInvalidTarget(folder:Folder,source:Folder,allFolders:Folder[]):string|null{
 if(folder.id===source.id)return "不能移动到自身";
 const index=folderIndex(allFolders);
 if(!index.has(folder.id))return "目标目录不可见";
 // Walk the candidate's visible ancestor chain; a cycle in that chain is
 // impossible for real data but must not hang the UI.
 const seen=new Set<string>();
 let current=index.get(folder.id);
 while(current&&!seen.has(current.id)){
  seen.add(current.id);
  const parentId=current.parentId;
  if(parentId===null)break;
  const parent=index.get(parentId);
  if(!parent)break;
  if(parent.id===source.id)return "不能移动到自身子目录";
  current=parent;
 }
 return null;
}

// The visible tree array is stable between reloads, so the id index is built
// once per tree instead of once per picker row (WF-10 keeps 10k-folder target
// picking free of per-row full-tree work).
const indexCache=new WeakMap<Folder[],Map<string,Folder>>();

function folderIndex(allFolders:Folder[]):Map<string,Folder>{
 let index=indexCache.get(allFolders);
 if(!index){
  index=new Map(allFolders.map(f=>[f.id,f]));
  indexCache.set(allFolders,index);
 }
 return index;
}

// A new candidate always clears the previous rejection notice.
export function folderMovePickTarget(state:FolderMoveState,targetId:string):FolderMoveState{
 return targetId===""?folderMoveIdle():{step:"candidate",targetId,notice:"",unknown:false};
}

export function folderMoveSubmitStarted(state:FolderMoveState):FolderMoveState{
 if(state.step!=="candidate"&&state.step!=="failed")return state;
 return {step:"submitting",targetId:state.targetId,notice:"",unknown:false};
}

export function folderMoveSucceeded(state:FolderMoveState):FolderMoveState{
 return {step:"succeeded",targetId:state.targetId,notice:"",unknown:false};
}

export function folderMoveFailed(state:FolderMoveState,notice:string,unknown=false):FolderMoveState{
 return {step:"failed",targetId:state.targetId,notice,unknown};
}

export function folderMoveBusy(state:FolderMoveState):boolean{
 return state.step==="submitting";
}

export function folderMoveCanSubmit(state:FolderMoveState):boolean{
 if(state.step!=="candidate"&&state.step!=="failed")return false;
 // A rejected candidate may be retried; an interrupted request must be
 // verified first, never repeated blindly (§4.2).
 return state.targetId!==""&&!state.unknown;
}

// Stable server codes map to the recovery the user can actually perform
// (COMPLEX-WORKFLOWS §4.1): the dialog stays open on the candidate so another
// target or a retry is always reachable.
export function folderMoveFailure(error:unknown):{notice:string;unknown:boolean}{
 const code=errorCode(error);
 if(code==="E_NETWORK")return {notice:FOLDER_MOVE_NOTICE.unknown,unknown:true};
 if(code==="E_FORBIDDEN")return {notice:FOLDER_MOVE_NOTICE.forbidden,unknown:false};
 if(code==="E_BAD"||code==="E_MOVE_CONFLICT")return {notice:FOLDER_MOVE_NOTICE.selfOrDescendant,unknown:false};
 if(code==="E_NAME_CONFLICT")return {notice:FOLDER_MOVE_NOTICE.nameConflict,unknown:false};
 return {notice:errorCopy(error,"移动失败，请重试"),unknown:false};
}
