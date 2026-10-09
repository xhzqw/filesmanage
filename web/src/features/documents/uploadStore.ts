import{create}from"zustand";
import{errorCode}from"../../shared/errors";
import{uploadFileWithProgress}from"../../shared/uploadClient";
import{
 enqueue,markUploading,markProgress,markServerProcessing,markCommitted,markFailed,markCancelled,
 cancelTask,retryTask,renameTask,skipTask,
 type UploadTask,
}from"./uploadQueue";

// Error-code to Chinese copy (COMPLEX-WORKFLOWS-v1 §4.1): every failure keeps
// the stable server code and maps to an actionable recovery.
function failureCopy(error:unknown):string{
 const code=errorCode(error);
 if(code==="E_NAME_CONFLICT")return"同名文件已存在，可改名或跳过";
 if(code==="E_FORBIDDEN")return"当前目录没有上传权限";
 return"上传失败，可重试";
}

export type UploadState={
 tasks:UploadTask[];
 // The folder the page is currently showing, set by the mounted DropZone. The
 // pump compares a committed item's own targetFolderId with this value, so an
 // item that lands elsewhere is reported in the queue but never reloads this
 // folder's list (WF-28).
 currentFolderId:string;
 // Bumped only by a commit into currentFolderId; the queue consumer watches it
 // and runs its onCommitted reload (WF-28).
 reloadTick:number;
 setCurrentFolder:(folderId:string)=>void;
 enqueueFiles:(files:File[],targetFolderId:string)=>void;
 cancel:(queueId:string)=>void;
 retry:(queueId:string)=>void;
 rename:(queueId:string,name:string)=>void;
 skip:(queueId:string)=>void;
};

// queueId → the AbortController of its in-flight XHR, so 取消 on an uploading
// item aborts exactly that request. Module scope, not state: aborting is an
// effect and is never rendered.
const inFlight=new Map<string,AbortController>();
// Concurrency 1 is the G4 decision (ADR-UX-05). One pump loop runs at a time;
// a second enqueue/retry only wakes it, and each pass re-reads the queue, so an
// item added while an upload is in flight is picked up in order.
let pumping=false;

// One queue for every entry point (WF-27): the drop zone and the toolbar file
// input in FileTable enqueue here and share the same items, statuses, per-item
// actions and idempotency identity. Living in a store rather than in DropZone
// keeps an in-flight upload running while both components are unmounted.
export const useUploadStore=create<UploadState>((set,get)=>({
 tasks:[],
 currentFolderId:"",
 reloadTick:0,
 setCurrentFolder:folderId=>{if(get().currentFolderId!==folderId)set({currentFolderId:folderId});},
 enqueueFiles:(files,targetFolderId)=>{
  // An empty target is "no writable folder", never a folder id.
  if(targetFolderId===""||files.length===0)return;
  set({tasks:enqueue(get().tasks,files,targetFolderId)});
  void pump();
 },
 // A queued item is cancelled in state; an uploading one can only be aborted
 // locally (cancelTask is a no-op past "queued"), and the pump reports the
 // E_CANCELLED result without pretending the server withdrew anything (§5.1).
 cancel:queueId=>{
  const task=get().tasks.find(item=>item.queueId===queueId);
  if(!task)return;
  if(task.status==="uploading"){inFlight.get(queueId)?.abort();return;}
  if(task.status==="queued")set({tasks:cancelTask(get().tasks,queueId)});
 },
 // Retry/rename go through the pure transitions, which keep the idempotency
 // key for a retry and mint a fresh one for a rename (§5.1).
 retry:queueId=>{set({tasks:retryTask(get().tasks,queueId)});void pump();},
 rename:(queueId,name)=>{set({tasks:renameTask(get().tasks,queueId,name)});void pump();},
 skip:queueId=>{set({tasks:skipTask(get().tasks,queueId)});},
}));

// Sequential pump. It re-reads the queue every pass, so an item enqueued while
// an upload is in flight is picked up in order. The store, not a component,
// owns the loop, so unmounting the page cannot strand an upload and no request
// is aborted except by an explicit cancel.
async function pump(){
 if(pumping)return;
 pumping=true;
 try{
  for(;;){
   const next=useUploadStore.getState().tasks.find(task=>task.status==="queued");
   if(!next)break;
   const controller=new AbortController();
   inFlight.set(next.queueId,controller);
   useUploadStore.setState(state=>({tasks:markUploading(state.tasks,next.queueId)}));
   try{
    const reply=await uploadFileWithProgress(next.targetFolderId,next.file,next.idempotencyKey,{
     signal:controller.signal,
     // Byte progress is not success: when every byte is on the wire the item
     // moves to server-processing and only the committed envelope resolves it
     // (COMPLEX-WORKFLOWS-v1 §5.1).
     onProgress:progress=>{
      useUploadStore.setState(state=>{
       const withBytes=markProgress(state.tasks,next.queueId,progress);
       return {tasks:progress.total>0&&progress.loaded>=progress.total?markServerProcessing(withBytes,next.queueId):withBytes};
      });
     },
    });
    useUploadStore.setState(state=>{
     const tasks=markCommitted(state.tasks,next.queueId,{fileId:reply.fileId,versionSeq:reply.versionSeq,deduplicated:reply.deduplicated});
     // WF-28: the queue survives a folder switch, so only a commit into the
     // folder the page currently shows asks the page to reload its list.
     return next.targetFolderId===state.currentFolderId?{tasks,reloadTick:state.reloadTick+1}:{tasks};
    });
   }catch(error){
    useUploadStore.setState(state=>({tasks:errorCode(error)==="E_CANCELLED"?
     markCancelled(state.tasks,next.queueId):markFailed(state.tasks,next.queueId,failureCopy(error))}));
   }finally{
    inFlight.delete(next.queueId);
   }
  }
 }finally{
  pumping=false;
 }
}
