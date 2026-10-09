import{useEffect,useRef,useState,type DragEvent,type FormEvent,type ReactNode}from"react";
import{formatSize}from"./api";
import{useUploadStore}from"./uploadStore";
import"./dropZone.css";

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

// Drag-and-drop upload target rendering the shared queue (DI-17, WF-24..28).
// The queue itself lives in uploadStore, so this drop and the toolbar file
// input in FileTable feed one queue with identical business semantics (WF-27)
// and an upload keeps running while either component is unmounted. Each item
// keeps its own targetFolderId, so a queue survives a folder switch; the store
// asks for a reload only when the committed item's target is the folder this
// zone last reported (WF-28). No window-level listeners are registered: every
// handler is scoped to this subtree, so a drop over a text input elsewhere
// never uploads.
export function DropZone({folderId,disabled,onCommitted,children}:{folderId:string;disabled?:boolean;onCommitted:()=>void;children:ReactNode}){
 const tasks=useUploadStore(state=>state.tasks);
 const reloadTick=useUploadStore(state=>state.reloadTick);
 const setCurrentFolder=useUploadStore(state=>state.setCurrentFolder);
 const enqueueFiles=useUploadStore(state=>state.enqueueFiles);
 const cancel=useUploadStore(state=>state.cancel);
 const retry=useUploadStore(state=>state.retry);
 const rename=useUploadStore(state=>state.rename);
 const skip=useUploadStore(state=>state.skip);
 const[dragging,setDragging]=useState(false);
 const[renamingId,setRenamingId]=useState<string|null>(null);
 const[renameValue,setRenameValue]=useState("");
 const dragDepth=useRef(0);
 const seenReload=useRef(reloadTick);

 // Report the shown folder to the store so a commit into another folder never
 // reloads this list, and make "no zone is visible" explicit on unmount
 // (WF-28; the empty value is never a folder id).
 useEffect(()=>{
  setCurrentFolder(folderId);
  return()=>setCurrentFolder("");
 },[folderId,setCurrentFolder]);

 // The store bumps reloadTick for a commit into the folder above; the tick
 // already present at mount is skipped because the table re-reads on mount.
 useEffect(()=>{
  if(seenReload.current===reloadTick)return;
  seenReload.current=reloadTick;
  onCommitted();
 },[reloadTick,onCommitted]);

 // Without a writable target the zone is inert (no highlight, no enqueue) but
 // still renders its children and any in-flight queue unchanged.
 const active=folderId!==""&&disabled!==true;

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
  enqueueFiles(Array.from(event.dataTransfer.files),folderId);
 }

 function submitRename(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  const name=renameValue.trim();
  if(renamingId===null||name==="")return;
  rename(renamingId,name);
  setRenamingId(null);
  setRenameValue("");
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
       {task.status==="queued"&&<button type="button" onClick={()=>cancel(task.queueId)}>取消</button>}
       {task.status==="uploading"&&<button type="button" title="取消只中断本地请求；服务端已提交的结果无法撤销" onClick={()=>cancel(task.queueId)}>取消</button>}
       {task.status==="failed"&&<>
        <button type="button" onClick={()=>retry(task.queueId)}>重试</button>
        <button type="button" onClick={()=>{setRenamingId(task.queueId);setRenameValue(task.name);}}>改名重试</button>
        <button type="button" onClick={()=>skip(task.queueId)}>跳过</button>
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
