import{useEffect,useRef,useState,type DragEvent,type FormEvent,type ReactNode}from"react";
import{formatSize}from"./api";
import{uploadFileWithProgress}from"../../shared/uploadClient";
import{errorCode}from"../../shared/errors";
import{
 enqueue,markUploading,markProgress,markServerProcessing,markCommitted,markFailed,markCancelled,
 cancelTask,retryTask,renameTask,skipTask,
 type UploadTask,
}from"./uploadQueue";
import"./dropZone.css";

// Error-code to Chinese copy (COMPLEX-WORKFLOWS-v1 §4.1): every failure keeps
// the stable server code and maps to an actionable recovery.
function failureCopy(error:unknown):string{
 const code=errorCode(error);
 if(code==="E_NAME_CONFLICT")return"同名文件已存在，可改名或跳过";
 if(code==="E_FORBIDDEN")return"当前目录没有上传权限";
 return"上传失败，可重试";
}

// DESKTOP-INTERACTION-v1 §7.1: a drop onto a text-entry surface must not be
// hijacked into an upload. The file <input> is intentionally allowed through so
// dropping on the existing upload button still enqueues.
function dropOnTextEntry(event:DragEvent<HTMLDivElement>):boolean{
 const el=event.target as HTMLElement|null;
 if(!el||typeof el.closest!=="function")return false;
 if(el.closest("textarea,[contenteditable='true'],[contenteditable='']"))return true;
 const input=el.closest("input");
 return input instanceof HTMLInputElement&&input.type!=="file";
}

// Drag-and-drop upload target with a real per-item queue (DI-17, WF-24..28).
// The whole subtree is the drop zone; a non-drag entry (the file input inside
// FileTable, DI-18) stays the keyboard/touch path and is untouched here. Drops
// enqueue files that upload sequentially (concurrency 1 is a G4 decision,
// ADR-UX-05); each item keeps its own targetFolderId so a queue survives a
// folder switch and only reloads the list when it committed into the current
// folder (WF-28). No window-level listeners are registered: every handler is
// scoped to this subtree, so a drop over a text input elsewhere never uploads.
export function DropZone({folderId,disabled,onCommitted,children}:{folderId:string;disabled?:boolean;onCommitted:()=>void;children:ReactNode}){
 const[tasks,setTasks]=useState<UploadTask[]>([]);
 const[dragging,setDragging]=useState(false);
 const[renamingId,setRenamingId]=useState<string|null>(null);
 const[renameValue,setRenameValue]=useState("");
 const tasksRef=useRef<UploadTask[]>([]);
 const dragDepth=useRef(0);
 const pumping=useRef(false);
 // queueId → the AbortController of its in-flight XHR, so 取消 on an uploading
 // item aborts exactly that request while a queued item is cancelled in state.
 const inFlight=useRef(new Map<string,AbortController>());
 const mounted=useRef(true);
 const folderIdRef=useRef(folderId);
 const onCommittedRef=useRef(onCommitted);
 folderIdRef.current=folderId;
 onCommittedRef.current=onCommitted;

 useEffect(()=>{
  mounted.current=true;
  return()=>{mounted.current=false;};
 },[]);

 // Without a writable target the zone is inert (no highlight, no enqueue) but
 // still renders its children and any in-flight queue unchanged.
 const active=folderId!==""&&disabled!==true;

 // tasksRef mirrors state synchronously so the async pump always reads the
 // latest queue; every mutation flows through here to keep the two in step.
 function applyTasks(change:(prev:UploadTask[])=>UploadTask[]){
  const next=change(tasksRef.current);
  tasksRef.current=next;
  if(mounted.current)setTasks(next);
 }

 // Sequential pump (concurrency 1, ADR-UX-05). It re-reads the queue each pass,
 // so items enqueued while an upload is in flight are picked up in order.
 async function pump(){
  if(pumping.current)return;
  pumping.current=true;
  try{
   while(mounted.current){
    const next=tasksRef.current.find(task=>task.status==="queued");
    if(!next)break;
    const controller=new AbortController();
    inFlight.current.set(next.queueId,controller);
    applyTasks(prev=>markUploading(prev,next.queueId));
    try{
     const reply=await uploadFileWithProgress(next.targetFolderId,next.file,next.idempotencyKey,{
      signal:controller.signal,
      // Byte progress is not success: when every byte is on the wire the item
      // moves to server-processing and only the committed envelope resolves it
      // (COMPLEX-WORKFLOWS-v1 §5.1).
      onProgress:progress=>{
       applyTasks(prev=>{
        const withBytes=markProgress(prev,next.queueId,progress);
        return progress.total>0&&progress.loaded>=progress.total?markServerProcessing(withBytes,next.queueId):withBytes;
       });
      },
     });
     applyTasks(prev=>markCommitted(prev,next.queueId,{fileId:reply.fileId,versionSeq:reply.versionSeq,deduplicated:reply.deduplicated}));
     if(next.targetFolderId===folderIdRef.current)onCommittedRef.current();
    }catch(error){
     if(errorCode(error)==="E_CANCELLED"){
      applyTasks(prev=>markCancelled(prev,next.queueId));
     }else{
      applyTasks(prev=>markFailed(prev,next.queueId,failureCopy(error)));
     }
    }finally{
     inFlight.current.delete(next.queueId);
    }
   }
  }finally{
   pumping.current=false;
  }
 }

 function enqueueFiles(files:File[]){
  if(!active||files.length===0)return;
  applyTasks(prev=>enqueue(prev,files,folderId));
  void pump();
 }

 function onDragEnter(event:DragEvent<HTMLDivElement>){
  if(!active)return;
  event.preventDefault();
  dragDepth.current+=1;
  setDragging(true);
 }

 function onDragOver(event:DragEvent<HTMLDivElement>){
  if(!active)return;
  event.preventDefault();
 }

 // A depth counter absorbs child enter/leave flicker: the highlight only clears
 // when the pointer has actually left the whole subtree.
 function onDragLeave(event:DragEvent<HTMLDivElement>){
  if(!active)return;
  event.preventDefault();
  dragDepth.current=Math.max(0,dragDepth.current-1);
  if(dragDepth.current===0)setDragging(false);
 }

 function onDrop(event:DragEvent<HTMLDivElement>){
  if(!active)return;
  event.preventDefault();
  dragDepth.current=0;
  setDragging(false);
  if(dropOnTextEntry(event))return;
  enqueueFiles(Array.from(event.dataTransfer.files));
 }

 function submitRename(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  const name=renameValue.trim();
  if(renamingId===null||name==="")return;
  const target=renamingId;
  applyTasks(prev=>renameTask(prev,target,name));
  setRenamingId(null);
  setRenameValue("");
  void pump();
 }

 const committed=tasks.filter(task=>task.status==="committed").length;
 const failed=tasks.filter(task=>task.status==="failed").length;
 const pending=tasks.filter(task=>task.status==="queued"||task.status==="uploading").length;

 return <div
  className={"dropzone"+(dragging?" dragging":"")}
  role="region"
  aria-label="文件上传拖放区"
  onDragEnter={onDragEnter}
  onDragOver={onDragOver}
  onDragLeave={onDragLeave}
  onDrop={onDrop}
 >
  {children}
  {tasks.length>0&&<div className="upload-queue">
   <p className="upload-queue-summary" role="status">
    {committed} 项完成 · {failed} 项失败{pending>0?` · ${pending} 项进行中`:""}
   </p>
   <ul className="upload-queue-list">
    {tasks.map(task=>{
     const progress=task.progress;
     const processing=task.status==="uploading"&&task.serverProcessing===true;
     // Byte information is dropped while server-processing, so a completed send
     // renders as indeterminate instead of a finished bar (§5.1).
     const sent=!processing&&progress!==undefined&&progress.total>0?progress:undefined;
     const percent=sent?Math.min(99,Math.floor(sent.loaded/sent.total*100)):0;
     return <li key={task.queueId} className={"upload-item "+task.status}>
      <div className="upload-item-main">
       <span className="upload-item-name" title={task.name}>{task.name}</span>
       <span className="upload-item-size">{formatSize(task.size)}</span>
       {task.targetFolderId!==folderId&&<span className="upload-item-target" title="队列保留加入时的目标目录">其他目录</span>}
      </div>
      <span className="upload-item-status">
       {task.status==="queued"&&"排队中"}
       {task.status==="uploading"&&(processing?"服务端处理中…":sent?`上传中 ${percent}%`:"上传中…")}
       {task.status==="committed"&&(task.result?`${task.result.deduplicated?"内容已存在，当前为":"已生成"} v${task.result.versionSeq}`:"")}
       {task.status==="failed"&&<span className="upload-item-error">{task.error}</span>}
       {task.status==="cancelled"&&<span title="取消只保证本地中断请求；服务端已提交的结果无法撤销">已取消</span>}
      </span>
      <div className="upload-item-actions">
       {task.status==="queued"&&<button type="button" onClick={()=>applyTasks(prev=>cancelTask(prev,task.queueId))}>取消</button>}
       {task.status==="uploading"&&<button type="button" title="取消只中断本地请求；服务端已提交的结果无法撤销" onClick={()=>inFlight.current.get(task.queueId)?.abort()}>取消</button>}
       {task.status==="failed"&&<>
        <button type="button" onClick={()=>{applyTasks(prev=>retryTask(prev,task.queueId));void pump();}}>重试</button>
        <button type="button" onClick={()=>{setRenamingId(task.queueId);setRenameValue(task.name);}}>改名重试</button>
        <button type="button" onClick={()=>applyTasks(prev=>skipTask(prev,task.queueId))}>跳过</button>
       </>}
      </div>
      {task.status==="uploading"&&<div
       className={"upload-progress"+(sent?"":" indeterminate")}
       role="progressbar"
       aria-label={processing?"服务端处理中":"上传进度"}
       aria-valuemin={0}
       aria-valuemax={sent?sent.total:task.size}
       aria-valuenow={sent?sent.loaded:undefined}
      >
       <div className="upload-progress-fill" style={sent?{width:percent+"%"}:undefined}/>
      </div>}
      {renamingId===task.queueId&&<form className="upload-rename" onSubmit={submitRename}>
       <input aria-label="新文件名" value={renameValue} maxLength={200} onChange={e=>setRenameValue(e.target.value)} autoFocus required/>
       <button type="submit" className="primary">确认改名</button>
       <button type="button" className="secondary-action" onClick={()=>setRenamingId(null)}>取消</button>
      </form>}
     </li>;
    })}
   </ul>
  </div>}
 </div>;
}
