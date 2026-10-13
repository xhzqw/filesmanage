import {RareButton,RareInput} from "../../shared/ui/rare";
import{useEffect,useRef,useState,type FormEvent,type ReactNode}from"react";
import{fileApi,formatSize,type ReplaceTarget}from"./api";
import{errorCopy}from"../../shared/errors";
import{toast}from"../../shared/ui/feedback";
import{useUploadStore}from"./uploadStore";
import {extensionChange} from "./fileExtensionChange";
import {ExtensionChangeNotice} from "./FileRenameDialog";
import"./dropZone.css";

// Drag-and-drop upload target rendering the shared queue (DI-17, WF-24..28).
// The queue itself lives in uploadStore, so this drop and the toolbar file
// input in FileTable feed one queue with identical business semantics (WF-27)
// and an upload keeps running while either component is unmounted. Each item
// keeps its own targetFolderId, so a queue survives a folder switch; the store
// asks for a reload only when the committed item's target is the folder this
// zone last reported (WF-28). OS file gestures are owned by GlobalUploadDrop;
// this component presents the *same* queue without registering a second drop.
export function DropZone({folderId,userId,onCommitted,children}:{folderId:string;userId:string;onCommitted:()=>void;children:ReactNode}){
 const tasks=useUploadStore(state=>state.tasks);
 const reloadTick=useUploadStore(state=>state.reloadTick);
 const setCurrentFolder=useUploadStore(state=>state.setCurrentFolder);
 const cancel=useUploadStore(state=>state.cancel);
 const clearFinished=useUploadStore(state=>state.clearFinished);
 const retry=useUploadStore(state=>state.retry);
 const rename=useUploadStore(state=>state.rename);
 const replace=useUploadStore(state=>state.replace);
 const skip=useUploadStore(state=>state.skip);
 const attach=useUploadStore(state=>state.attach);
 const[queueExpanded,setQueueExpanded]=useState(true);
 const[renamingId,setRenamingId]=useState<string|null>(null);
 const[renameValue,setRenameValue]=useState("");
 const[pendingRename,setPendingRename]=useState<{queueId:string;name:string}|null>(null);
 const[replaceConfirm,setReplaceConfirm]=useState<{queueId:string;target:ReplaceTarget}|null>(null);
 const[preparingReplace,setPreparingReplace]=useState("");
 const seenReload=useRef(reloadTick);
 useEffect(()=>{if(tasks.length>0)setQueueExpanded(true);},[tasks.length]);

 // Report the shown folder to the store so a commit into another folder never
 // reloads this list, and make "no zone is visible" explicit on unmount
 // (WF-28; the empty value is never a folder id).
 useEffect(()=>{
  setCurrentFolder(folderId,userId);
  return()=>setCurrentFolder("",userId);
 },[folderId,userId,setCurrentFolder]);

 // The store bumps reloadTick for a commit into the folder above; the tick
 // already present at mount is skipped because the table re-reads on mount.
 useEffect(()=>{
  if(seenReload.current===reloadTick)return;
  seenReload.current=reloadTick;
  onCommitted();
 },[reloadTick,onCommitted]);

 function finishRename(queueId:string,name:string){
  rename(queueId,name);
  setRenamingId(null);
  setRenameValue("");
  setPendingRename(null);
 }
 function submitRename(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  const name=renameValue.trim();
  const task=tasks.find(item=>item.queueId===renamingId);
  if(!task||name==="")return;
  if(extensionChange(task.name,name)){
   setPendingRename({queueId:task.queueId,name});
   return;
  }
  finishRename(task.queueId,name);
 }
 async function prepareReplace(queueId:string){
  const task=tasks.find(item=>item.queueId===queueId&&item.status==="failed"&&(item.failureCode==="E_NAME_CONFLICT"||!!item.replacement)&&item.file!==null);
  if(!task||preparingReplace)return;
  setPreparingReplace(queueId);
  setReplaceConfirm(null);
  try{
   const target=await fileApi.replaceTarget(task.targetFolderId,task.name);
   const latest=useUploadStore.getState().tasks.find(item=>item.queueId===queueId);
   if(latest?.status==="failed"&&latest.name===target.name&&latest.targetFolderId===target.folderId){
    setReplaceConfirm({queueId,target});
   }
  }catch(error){toast.warning(errorCopy(error,"无法替换此文件，请检查权限或文件状态"));}
  finally{setPreparingReplace("");}
 }

 const committed=tasks.filter(task=>task.status==="committed").length;
 const failed=tasks.filter(task=>task.status==="failed").length;
 const pending=tasks.filter(task=>task.status==="queued"||task.status==="uploading").length;
 const finished=tasks.filter(task=>task.status==="committed"||task.status==="cancelled").length;

 return <div
  className="dropzone"
  role="region"
  aria-label="文件上传拖放区"
 >
  {children}
  {tasks.length>0&&<section className="upload-queue" aria-label="上传任务">
   <header className="upload-queue-header">
    <span className="upload-queue-summary" role="status">
     上传任务 · {committed} 项完成 · {failed} 项失败{pending>0?` · ${pending} 项进行中`:""}
    </span>
    <div className="upload-queue-controls">
     {finished>0&&<RareButton type="button" aria-label={"清除 "+finished+" 项已结束的上传任务"} onClick={clearFinished}>清除已结束 ({finished})</RareButton>}
     <RareButton type="button" aria-expanded={queueExpanded} aria-controls="upload-queue-list" onClick={()=>setQueueExpanded(value=>!value)}>
      {queueExpanded?"收起":"展开"} ({tasks.length})
     </RareButton>
    </div>
   </header>
   {queueExpanded&&<ul className="upload-queue-list" id="upload-queue-list">
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
       {task.status==="interrupted"&&<span className="upload-item-error">{task.error||"刷新后待重新选择原文件"}</span>}
       {task.status==="uploading"&&(processing?"服务端处理中…":sent?`上传中 ${percent}%`:"上传中…")}
       {task.status==="committed"&&(task.result?`${task.result.deduplicated?"内容已存在，当前为":"已生成"} v${task.result.versionSeq}`:"")}
       {task.status==="failed"&&<span className="upload-item-error">{task.error}</span>}
       {task.status==="cancelled"&&<span title="取消只保证本地中断请求；服务端已提交的结果无法撤销">已取消</span>}
      </span>
      <div className="upload-item-actions">
       {task.status==="interrupted"&&<>
        <label className="upload-resume-picker">选择原文件
         <RareInput type="file" aria-label={`重新选择 ${task.sourceName??task.name}`} onChange={event=>{
          const file=event.currentTarget.files?.[0];if(file)void attach(task.queueId,file);
          event.currentTarget.value="";
         }}/>
        </label>
        <RareButton type="button" onClick={()=>cancel(task.queueId)}>移除</RareButton>
       </>}
       {task.status==="queued"&&<RareButton type="button" onClick={()=>cancel(task.queueId)}>取消</RareButton>}
       {task.status==="uploading"&&<RareButton type="button" title="取消只中断本地请求；服务端已提交的结果无法撤销" onClick={()=>cancel(task.queueId)}>取消</RareButton>}
       {task.status==="failed"&&<>
        {task.failureCode!=="E_NAME_CONFLICT"&&!task.replacement&&<RareButton type="button" onClick={()=>{setReplaceConfirm(null);retry(task.queueId);}}>重试</RareButton>}
        {(task.failureCode==="E_NAME_CONFLICT"||task.replacement)&&task.file&&<RareButton type="button" disabled={preparingReplace===task.queueId} onClick={()=>void prepareReplace(task.queueId)}>{preparingReplace===task.queueId?"正在检查…":task.replacement?"重新确认替换":"替换为新版本"}</RareButton>}
        <RareButton type="button" onClick={()=>{setPendingRename(null);setRenamingId(task.queueId);setRenameValue(task.name);}}>改名重试</RareButton>
        <RareButton type="button" onClick={()=>{setReplaceConfirm(null);skip(task.queueId);}}>跳过</RareButton>
       </>}
      </div>
      {replaceConfirm?.queueId===task.queueId&&task.status==="failed"&&<div className="upload-rename" role="group" aria-label="确认替换现有文件">
       <span>替换「{replaceConfirm.target.name}」的 v{replaceConfirm.target.versionSeq}，保留旧版本</span>
       <RareButton type="button" className="primary" onClick={()=>{replace(task.queueId,{fileId:replaceConfirm.target.fileId,versionSeq:replaceConfirm.target.versionSeq});setReplaceConfirm(null);}}>确认替换</RareButton>
       <RareButton type="button" onClick={()=>setReplaceConfirm(null)}>取消</RareButton>
      </div>}
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
      {renamingId===task.queueId&&(pendingRename?.queueId===task.queueId?
       <div className="upload-rename file-rename-inline-confirm" role="group" aria-label="确认更改文件后缀">
        {extensionChange(task.name,pendingRename.name)&&<ExtensionChangeNotice change={extensionChange(task.name,pendingRename.name)!}/>}
        <RareButton type="button" onClick={()=>setPendingRename(null)}>返回修改</RareButton>
        <RareButton type="button" className="primary" onClick={()=>finishRename(task.queueId,pendingRename.name)}>确认更改</RareButton>
       </div>:
       <form className="upload-rename" onSubmit={submitRename}>
        <RareInput aria-label="新文件名" value={renameValue} maxLength={200} onChange={e=>setRenameValue(e.target.value)} autoFocus required/>
        <RareButton type="submit" className="primary">确认改名</RareButton>
        <RareButton type="button" className="secondary-action" onClick={()=>{setRenamingId(null);setPendingRename(null);}}>取消</RareButton>
       </form>)}
     </li>;
    })}
   </ul>}
  </section>}
 </div>;
}
