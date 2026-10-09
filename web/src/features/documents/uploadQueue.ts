import{newIdempotencyKey}from"../../shared/ids";
import type{UploadProgress}from"../../shared/uploadClient";

// Upload queue state machine (COMPLEX-WORKFLOWS-v1 §5, UX-ACCEPTANCE WF-24..28).
// Pure transitions only: the shared upload store owns the async upload loop and
// calls these to move a task between states, so the identity rules stay
// testable.
//
// Two ids, two meanings. `queueId` is the stable UI key for one dropped/selected
// file and never changes. `idempotencyKey` is the server operation identity:
// retrying the same file+content+operation keeps it (a replay cannot create a
// second version, WF-26), while a rename or retarget is a new operation and
// gets a fresh key (§5.1).
//
// Status note: this slice models queued→uploading→committed and the failed/
// cancelled exits. `progress` carries browser-sent bytes and `serverProcessing`
// marks the honest gap between "every byte is on the wire" and "the server
// committed a result" (§5.1); a client-side `validating` state still has no
// representation here, so status is reported honestly rather than faked.

export type UploadStatus="queued"|"uploading"|"committed"|"failed"|"cancelled";

export type UploadResult={fileId:string;versionSeq:number;deduplicated:boolean};

export type UploadTask={
 queueId:string;
 name:string;
 size:number;
 targetFolderId:string;
 idempotencyKey:string;
 status:UploadStatus;
 error?:string;
 result?:UploadResult;
 file:File;
 progress?:UploadProgress;
 serverProcessing?:boolean;
};

let seq=0;
function nextQueueId():string{
 seq+=1;
 return "q"+seq+"-"+Math.random().toString(36).slice(2,8);
}

// A rename keeps the exact bytes but must be sent under the new name, so the
// File is rebuilt with the same content and a different filename.
function renameFile(file:File,name:string):File{
 return new File([file],name,{type:file.type,lastModified:file.lastModified});
}

export function enqueue(tasks:UploadTask[],files:File[],targetFolderId:string):UploadTask[]{
 const added:UploadTask[]=files.map(file=>({
  queueId:nextQueueId(),
  name:file.name,
  size:file.size,
  targetFolderId,
  idempotencyKey:newIdempotencyKey(),
  status:"queued",
  file,
 }));
 return tasks.concat(added);
}

function patch(tasks:UploadTask[],queueId:string,change:Partial<UploadTask>):UploadTask[]{
 return tasks.map(task=>task.queueId===queueId?{...task,...change}:task);
}

export function markUploading(tasks:UploadTask[],queueId:string,progress?:UploadProgress):UploadTask[]{
 return patch(tasks,queueId,{status:"uploading",error:undefined,progress,serverProcessing:false});
}

// Byte-level sending progress only. Reaching loaded===total is not success: the
// component moves the item to server-processing on that edge and keeps it
// waiting until markCommitted or markFailed arrives.
export function markProgress(tasks:UploadTask[],queueId:string,progress:UploadProgress):UploadTask[]{
 return tasks.map(task=>task.queueId===queueId&&task.status==="uploading"
  ?{...task,progress}:task);
}

// All request bytes are on the wire; the browser is waiting for the server's
// committed result (§5.1: sending 100% must never read as success).
export function markServerProcessing(tasks:UploadTask[],queueId:string):UploadTask[]{
 return tasks.map(task=>task.queueId===queueId&&task.status==="uploading"
  ?{...task,serverProcessing:true}:task);
}

export function markCommitted(tasks:UploadTask[],queueId:string,result:UploadResult):UploadTask[]{
 return patch(tasks,queueId,{status:"committed",error:undefined,result,serverProcessing:false});
}

export function markFailed(tasks:UploadTask[],queueId:string,error:string):UploadTask[]{
 return patch(tasks,queueId,{status:"failed",error,serverProcessing:false});
}

// Used only for an aborted in-flight request (E_CANCELLED); a user cancel of a
// not-yet-submitted item goes through cancelTask instead.
export function markCancelled(tasks:UploadTask[],queueId:string):UploadTask[]{
 return patch(tasks,queueId,{status:"cancelled",serverProcessing:false});
}

// Cancel only guarantees local cancellation of a not-yet-submitted request
// (§5.1): once an upload has left "queued" it is a no-op here, because the
// request may already be committed server-side. For an in-flight item the
// component aborts the XHR instead and reports a local cancellation.
export function cancelTask(tasks:UploadTask[],queueId:string):UploadTask[]{
 return tasks.map(task=>task.queueId===queueId&&task.status==="queued"
  ?{...task,status:"cancelled",serverProcessing:false}:task);
}

// Retry reuses the same idempotency key: file, content, name and target are
// unchanged, so the replay is the same operation (WF-26). This is also the safe
// recovery for an unknown network outcome, since the server dedupes on the key.
// A retry is a fresh send, so it starts without the previous attempt's progress.
export function retryTask(tasks:UploadTask[],queueId:string):UploadTask[]{
 return tasks.map(task=>task.queueId===queueId&&(task.status==="failed"||task.status==="cancelled")
  ?{...task,status:"queued",error:undefined,progress:undefined,serverProcessing:false}:task);
}

// A same-name conflict is resolved per item: renaming keeps the bytes but is a
// new operation identity, so it gets a fresh idempotency key (§5.1, WF-25).
export function renameTask(tasks:UploadTask[],queueId:string,name:string):UploadTask[]{
 return tasks.map(task=>task.queueId===queueId&&task.status!=="committed"
  ?{...task,name,file:renameFile(task.file,name),idempotencyKey:newIdempotencyKey(),status:"queued",error:undefined,progress:undefined,serverProcessing:false}
  :task);
}

// Skip is a per-item decision to not upload; it never touches the server.
export function skipTask(tasks:UploadTask[],queueId:string):UploadTask[]{
 return tasks.map(task=>task.queueId===queueId&&task.status!=="committed"
  ?{...task,status:"cancelled",serverProcessing:false}:task);
}

// Retargeting to a different folder is also a new operation identity.
export function retargetTask(tasks:UploadTask[],queueId:string,targetFolderId:string):UploadTask[]{
 return tasks.map(task=>task.queueId===queueId&&task.status!=="committed"
  ?{...task,targetFolderId,idempotencyKey:newIdempotencyKey(),status:"queued",error:undefined,progress:undefined,serverProcessing:false}
  :task);
}
