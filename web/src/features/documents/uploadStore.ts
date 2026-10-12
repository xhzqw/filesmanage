import{create}from"zustand";
import {toast} from "../../shared/ui/feedback";
import{errorCode}from"../../shared/errors";
import{uploadFileWithProgress,type ReplaceUploadTarget}from"../../shared/uploadClient";
import{uploadResumable,resumableThreshold,resumableMaxFile}from"../../shared/resumableUpload";
import {fingerprintFile,readUploadTasks,storeUploadTasks} from "./uploadQueuePersistence";
import{
 enqueue,markUploading,markProgress,markServerProcessing,markCommitted,markFailed,markCancelled,
  cancelTask,retryTask,renameTask,replaceTask,skipTask,clearFinishedTasks,limitFinishedHistory,
 type UploadTask,
}from"./uploadQueue";

// Error-code to Chinese copy (COMPLEX-WORKFLOWS-v1 §4.1): every failure keeps
// the stable server code and maps to an actionable recovery.
function failureCopy(error:unknown):string{
 const code=errorCode(error);
 if(code==="E_NAME_CONFLICT")return"同名文件已存在，可选择替换为新版本";
 if(code==="E_LOCKED")return"目标文件正在编辑，请结束编辑后重新确认";
 if(code==="E_APPROVAL_PENDING")return"目标目录需要审批，不允许直接替换";
 if(code==="E_FORBIDDEN")return"当前目录没有上传权限";
 if(code==="E_NETWORK")return"连接中断，提交结果未确认；请用原任务重试核对，勿直接新建重复任务";
 if(code==="E_VERSION_CONFLICT"||code==="E_NOT_FOUND")return"原上传会话已失效或偏移不一致；请先核对目标目录，再改名发起新任务";
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
 bindUser:(userId:string)=>void;
 setCurrentFolder:(folderId:string,userId:string)=>void;
 enqueueFiles:(files:File[],targetFolderId:string)=>void;
 cancel:(queueId:string)=>void;
 retry:(queueId:string)=>void;
  rename:(queueId:string,name:string)=>void;
  replace:(queueId:string,target:ReplaceUploadTarget)=>void;
 skip:(queueId:string)=>void;
 clearFinished:()=>void;
 attach:(queueId:string,file:File)=>Promise<void>;
};

// queueId → the AbortController of its in-flight XHR, so 取消 on an uploading
// item aborts exactly that request. Module scope, not state: aborting is an
// effect and is never rendered.
const inFlight=new Map<string,AbortController>();
// Concurrency 1 is the G4 decision (ADR-UX-05). One pump loop runs at a time;
// a second enqueue/retry only wakes it, and each pass re-reads the queue, so an
// item added while an upload is in flight is picked up in order.
let pumping=false;
let activeUserId="";
let identityEpoch=0;

// Explicit identity boundary: never allow a still-running task from the
// previous principal to mutate the next principal's queue or progress.
function bindUser(userId:string){
 if(activeUserId===userId)return;
 if(activeUserId)storeUploadTasks(activeUserId,useUploadStore.getState().tasks);
 identityEpoch++;
 for(const controller of inFlight.values())controller.abort("identity.changed");
 inFlight.clear();
 activeUserId=userId;
 const tasks=userId?readUploadTasks(userId).map(saved=>({
  ...saved,file:null,status:"interrupted" as const,
  cacheAt:saved.at,
  error:undefined,progress:undefined,serverProcessing:false,
 })):[];
 useUploadStore.setState({tasks,currentFolderId:""});
}

// One queue for every entry point (WF-27): the drop zone and the toolbar file
// input in FileTable enqueue here and share the same items, statuses, per-item
// actions and idempotency identity. Living in a store rather than in DropZone
// keeps an in-flight upload running while both components are unmounted.
export const useUploadStore=create<UploadState>((set,get)=>({
 tasks:[],
 currentFolderId:"",
 reloadTick:0,
 bindUser,
 setCurrentFolder:(folderId,userId)=>{
  if(folderId)bindUser(userId);
  else if(activeUserId!==userId)return; // late unmount from an older account
  if(get().currentFolderId!==folderId)set({currentFolderId:folderId});
 },
 enqueueFiles:(files,targetFolderId)=>{
  // An empty target is "no writable folder", never a folder id.
  if(targetFolderId===""||files.length===0)return;
  const previous=new Set(get().tasks.map(t=>t.queueId));
  const epoch=identityEpoch;
  set({tasks:enqueue(get().tasks,files,targetFolderId)});
  toast.info(`已加入上传队列：${files.length} 个文件`);
  for(const task of get().tasks.filter(t=>!previous.has(t.queueId)&&t.file&&t.size>=resumableThreshold&&t.size<=resumableMaxFile)){
   void fingerprintFile(task.file!).then(fingerprint=>{
    if(epoch!==identityEpoch)return;
    useUploadStore.setState(state=>({tasks:state.tasks.map(t=>t.queueId===task.queueId?{...t,fingerprint}:t)}));
   }).catch(()=>{});
  }
  void pump();
 },
 // A queued item is cancelled in state; an uploading one can only be aborted
 // locally (cancelTask is a no-op past "queued"), and the pump reports the
 // E_CANCELLED result without pretending the server withdrew anything (§5.1).
 cancel:queueId=>{
  const task=get().tasks.find(item=>item.queueId===queueId);
  if(!task)return;
  if(task.status==="uploading"){inFlight.get(queueId)?.abort();return;}
  if(task.status==="queued")set({tasks:limitFinishedHistory(cancelTask(get().tasks,queueId))});
  if(task.status==="interrupted")set({tasks:get().tasks.filter(item=>item.queueId!==queueId)});
 },
 // Retry/rename go through the pure transitions, which keep the idempotency
 // key for a retry and mint a fresh one for a rename (§5.1).
 retry:queueId=>{set({tasks:retryTask(get().tasks,queueId)});void pump();},
  rename:(queueId,name)=>{set({tasks:renameTask(get().tasks,queueId,name)});void pump();},
  replace:(queueId,target)=>{set({tasks:replaceTask(get().tasks,queueId,target)});void pump();},
 attach:async(queueId,file)=>{
  const task=get().tasks.find(t=>t.queueId===queueId&&t.status==="interrupted");
  if(!task)return;
  const matches=file.name===(task.sourceName??task.name)&&file.size===task.size&&
   file.lastModified===task.lastModified&&file.type===(task.fileType??"");
  if(!matches){
   set({tasks:get().tasks.map(t=>t.queueId===queueId?{...t,error:"文件名、大小、修改时间或格式与原文件不符"}:t)});
   return;
  }
  const epoch=identityEpoch;
  const fingerprint=await fingerprintFile(file).catch(()=>"");
  if(epoch!==identityEpoch||!get().tasks.some(t=>t.queueId===queueId&&t.status==="interrupted"))return;
  if(!fingerprint||fingerprint!==task.fingerprint){
   set({tasks:get().tasks.map(t=>t.queueId===queueId?{...t,error:"文件内容校验不匹配，已阻止续传"}:t)});
   return;
  }
  const chosen=task.name===file.name?file:new File([file],task.name,{type:file.type,lastModified:file.lastModified});
  set({tasks:get().tasks.map(t=>t.queueId===queueId?{...t,file:chosen,status:"queued",error:undefined}:t)});
  void pump();
 },
 skip:queueId=>{set({tasks:skipTask(get().tasks,queueId)});},
 clearFinished:()=>set(state=>({tasks:clearFinishedTasks(state.tasks)})),
}));

// One bounded per-user metadata cache. The original bytes are never persisted.
useUploadStore.subscribe(state=>{
 if(activeUserId)storeUploadTasks(activeUserId,state.tasks);
});

// Sequential pump. It re-reads the queue every pass, so an item enqueued while
// an upload is in flight is picked up in order. The store, not a component,
// owns the loop, so unmounting the page cannot strand an upload and no request
// is aborted except by an explicit cancel.
async function pump(){
 if(pumping)return;
 pumping=true;
 const ownerEpoch=identityEpoch;
 let completed=0,failed=0;
 try{
  for(;;){
   const next=useUploadStore.getState().tasks.find(task=>task.status==="queued"&&task.file!==null);
   if(!next)break;
   if(!next.file)continue;
   const epoch=identityEpoch;
   const controller=new AbortController();
   inFlight.set(next.queueId,controller);
   if(epoch!==identityEpoch)continue;
   useUploadStore.setState(state=>({tasks:markUploading(state.tasks,next.queueId)}));
   try{
     const uploader=!next.replacement&&next.file.size>=resumableThreshold&&next.file.size<=resumableMaxFile?uploadResumable:uploadFileWithProgress;
     const reply=await uploader(next.targetFolderId,next.file,next.idempotencyKey,{
      signal:controller.signal,
      ...(next.replacement?{replace:next.replacement}:{}),
     // Byte progress is not success: when every byte is on the wire the item
     // moves to server-processing and only the committed envelope resolves it
     // (COMPLEX-WORKFLOWS-v1 §5.1).
     onProgress:progress=>{
      if(epoch!==identityEpoch)return;
      useUploadStore.setState(state=>{
       const withBytes=markProgress(state.tasks,next.queueId,progress);
       return {tasks:progress.total>0&&progress.loaded>=progress.total?markServerProcessing(withBytes,next.queueId):withBytes};
      });
     },
    });
    if(epoch!==identityEpoch)continue;
    useUploadStore.setState(state=>{
     const tasks=limitFinishedHistory(markCommitted(state.tasks,next.queueId,{fileId:reply.fileId,versionSeq:reply.versionSeq,deduplicated:reply.deduplicated}));
     // WF-28: the queue survives a folder switch, so only a commit into the
     // folder the page currently shows asks the page to reload its list.
     return next.targetFolderId===state.currentFolderId?{tasks,reloadTick:state.reloadTick+1}:{tasks};
    });
    completed++;
   }catch(error){
    if(epoch!==identityEpoch)continue;
    useUploadStore.setState(state=>({tasks:errorCode(error)==="E_CANCELLED"?
      limitFinishedHistory(markCancelled(state.tasks,next.queueId)):markFailed(state.tasks,next.queueId,next.replacement&&errorCode(error)==="E_VERSION_CONFLICT"?"目标文件版本已变化，请重新确认替换":failureCopy(error),errorCode(error))}));
    if(errorCode(error)!=="E_CANCELLED")failed++;
   }finally{
    if(inFlight.get(next.queueId)===controller)inFlight.delete(next.queueId);
   }
  }
 }finally{
  pumping=false;
  if(ownerEpoch===identityEpoch){
   if(failed)toast.warning(`上传结束：成功 ${completed} 个，失败 ${failed} 个；请在上传队列处理失败项`);
   else if(completed)toast.success(`已完成上传 ${completed} 个文件`);
  }
 }
}
