import {useEffect,useRef,useState} from "react";
import {useLocation,useNavigate} from "react-router-dom";
import type {Folder} from "../../entities/folder/model";
import {useUploadStore} from "./uploadStore";
import {toast} from "../../shared/ui/feedback";
import {Dialog} from "../../shared/ui/Dialog";
import {FolderPicker} from "../../shared/ui/FolderPicker";
import {RareButton} from "../../shared/ui/rare";
import "./globalUploadDrop.css";

// The explorer reports its resolved directory; URLs alone are not proof that a
// directory exists and is accessible (especially shared/favorites views).
export type DocumentUploadTarget={routeKey:string;folderId:string;folderName:string;userId:string};

type PendingUpload={files:File[]};
const INTERNAL_MOVE="application/x-filesmanage-files";

function hasExternalFiles(transfer:DataTransfer|null):boolean{
 if(!transfer)return false;
 const types=Array.from(transfer.types);
 if(types.includes(INTERNAL_MOVE)&&!types.includes("Files"))return false;
 return types.includes("Files")||Array.from(transfer.items).some(item=>item.kind==="file");
}

function onTextEntry(target:EventTarget|null):boolean{
 const element=target instanceof Element?target:null;
 if(!element)return false;
 if(element.closest("textarea,[contenteditable='true'],[contenteditable='']"))return true;
 const input=element.closest("input");
 return input instanceof HTMLInputElement&&input.type!=="file";
}

function overFolder(target:EventTarget|null):{id:string;name:string}|null{
 const element=target instanceof Element?target:null;
 const row=element?.closest<HTMLElement>("[data-upload-folder-id]");
 const id=row?.dataset.uploadFolderId;
 if(!id)return null;
 const name=row?.querySelector(".file-name,.explorer-item-name")?.textContent?.trim()||"此文件夹";
 return {id,name};
}

function transferredFiles(transfer:DataTransfer):{files:File[];skippedFolders:boolean}{
 // Some browsers represent a directory as a zero-byte File. Never enqueue a
 // directory as a fake empty file; reject it while accepting sibling files.
 const directories=new Set<string>();
 for(const item of Array.from(transfer.items)){
  if(item.kind!=="file")continue;
  const entry=item.webkitGetAsEntry?.();
  if(entry?.isDirectory)directories.add(entry.name);
 }
 return {files:Array.from(transfer.files).filter(file=>!directories.has(file.name)),skippedFolders:directories.size>0};
}

/** One OS-file gesture across every authenticated route; internal moves pass through. */
export function GlobalUploadDrop({userId,documentTarget,fetchFolderTree}:{userId:string;documentTarget:DocumentUploadTarget|null;fetchFolderTree:()=>Promise<Folder[]>}){
 const location=useLocation();
 const navigate=useNavigate();
 const [dragging,setDragging]=useState(false);
 const [hoverFolder,setHoverFolder]=useState<{id:string;name:string}|null>(null);
 const [pending,setPending]=useState<PendingUpload|null>(null);
 const [folders,setFolders]=useState<Folder[]>([]);
 const [folderStatus,setFolderStatus]=useState<"loading"|"ready"|"failed">("loading");
 const [selectedId,setSelectedId]=useState("");
 const [folderError,setFolderError]=useState("");
 const tasks=useUploadStore(state=>state.tasks);
 const routeKey=location.pathname+location.search;
 const inDocumentFolder=location.pathname==="/doc"&&!(["favorites","received","sent"].includes(new URLSearchParams(location.search).get("view")||""));
 const currentTarget=inDocumentFolder&&documentTarget?.routeKey===routeKey&&documentTarget.userId===userId?documentTarget:null;
 const destination=useRef<{direct:DocumentUploadTarget|null;enabled:boolean}>({direct:currentTarget,enabled:location.pathname!=="/login"});
 destination.current={direct:currentTarget,enabled:location.pathname!=="/login"};
 const activeRequest=useRef(0);

 function loadFolders(){
  const requestId=++activeRequest.current;
  setFolderStatus("loading");
  setFolderError("");
  void fetchFolderTree().then(items=>{
   if(requestId!==activeRequest.current)return;
   setFolders(items);
   setFolderStatus("ready");
  }).catch(()=>{
   if(requestId===activeRequest.current){setFolderStatus("failed");setFolderError("目录加载失败，请重试");}
  });
 }
 function dismiss(){
  activeRequest.current++;
  setPending(null);
  setSelectedId("");
  setFolderError("");
 }

 useEffect(()=>{
  // Window capture prevents the subtree DropZone from enqueuing a second copy.
  function over(event:DragEvent){
   if(!destination.current.enabled||!hasExternalFiles(event.dataTransfer))return;
   event.preventDefault();
   event.stopPropagation();
   if(event.dataTransfer)event.dataTransfer.dropEffect="copy";
   setDragging(true);
   const next=overFolder(event.target);
   setHoverFolder(old=>old?.id===next?.id?old:next);
  }
  function leave(event:DragEvent){
   if(!hasExternalFiles(event.dataTransfer))return;
   // Child transitions must not flicker; blur covers OS drag cancellation.
   if(event.clientX>0&&event.clientY>0&&event.clientX<window.innerWidth&&event.clientY<window.innerHeight)return;
   setDragging(false);
   setHoverFolder(null);
  }
  function drop(event:DragEvent){
   if(!destination.current.enabled||!hasExternalFiles(event.dataTransfer))return;
   event.preventDefault();
   event.stopPropagation();
   setDragging(false);
   setHoverFolder(null);
   if(onTextEntry(event.target)||document.querySelector("dialog[open]"))return;
   if(!event.dataTransfer)return;
   const {files,skippedFolders}=transferredFiles(event.dataTransfer);
   if(skippedFolders)toast.warning("暂不支持直接拖入文件夹，请选择文件上传");
   if(files.length===0)return;
   const target=overFolder(event.target);
   const targetId=target?.id??destination.current.direct?.folderId;
   if(targetId){useUploadStore.getState().enqueueFiles(files,targetId);return;}
   setPending(previous=>({files:previous?[...previous.files,...files]:files}));
   setSelectedId("");
   loadFolders();
  }
  function clear(){setDragging(false);setHoverFolder(null);}
  window.addEventListener("dragenter",over,true);
  window.addEventListener("dragover",over,true);
  window.addEventListener("dragleave",leave,true);
  window.addEventListener("drop",drop,true);
  window.addEventListener("blur",clear);
  return()=>{
   window.removeEventListener("dragenter",over,true);
   window.removeEventListener("dragover",over,true);
   window.removeEventListener("dragleave",leave,true);
   window.removeEventListener("drop",drop,true);
   window.removeEventListener("blur",clear);
  };
 },[userId]);
 useEffect(()=>()=>{activeRequest.current++;},[userId]);

 function confirm(){
  if(!pending||folderStatus!=="ready"||!folders.some(folder=>folder.id===selectedId))return;
  useUploadStore.getState().enqueueFiles(pending.files,selectedId);
  dismiss();
 }
 const outstanding=tasks.filter(task=>task.status==="queued"||task.status==="uploading"||task.status==="failed"||task.status==="interrupted");
 const running=outstanding.filter(task=>task.status==="queued"||task.status==="uploading").length;
 const failed=outstanding.length-running;
 const showingLocalQueue=inDocumentFolder&&Boolean(currentTarget);
 const hint=hoverFolder?`上传至「${hoverFolder.name}」`:currentTarget?`上传至「${currentTarget.folderName}」`:"松开后选择目标文件夹";
 return <>
  {dragging&&<div className="global-upload-overlay" aria-hidden="true">
   <div className="global-upload-hint"><span className="global-upload-symbol">↑</span><strong>{hint}</strong><span>松开文件以上传</span></div>
  </div>}
  <Dialog open={pending!==null} title="选择上传位置" onClose={dismiss}>
   {pending&&<div className="global-upload-pick">
    <div className="global-upload-pick-summary" role="status">{pending.files.length} 个文件待上传</div>
    {folderStatus==="failed"&&<div className="global-upload-pick-error" role="alert">{folderError} <RareButton type="button" onClick={loadFolders}>重试</RareButton></div>}
    {folderStatus==="loading"&&<p role="status" className="global-upload-pick-loading">正在读取目录…</p>}
    {folderStatus==="ready"&&<FolderPicker open title="选择上传位置" folders={folders}
     selectedId={selectedId} onSelect={setSelectedId} onClose={dismiss}
     footer={<div className="dialog-actions">
      <RareButton type="button" tone="ghost" onClick={dismiss}>取消</RareButton>
      <RareButton type="button" className="primary" disabled={!folders.some(folder=>folder.id===selectedId)} onClick={confirm}>上传到此目录</RareButton>
     </div>}/>}
   </div>}
  </Dialog>
  {!showingLocalQueue&&outstanding.length>0&&<div className="global-upload-queue" role="status" aria-live="polite">
   <div className="global-upload-queue-title">{running>0?`上传中 · ${running} 项`:"上传任务"}{failed>0?` · ${failed} 项需处理`:""}</div>
   <div className="global-upload-queue-bottom"><span title={outstanding[0]?.name}>{outstanding[0]?.name}</span>
    <RareButton type="button" tone="ghost" onClick={()=>navigate("/doc")}>查看队列</RareButton>
   </div>
   {outstanding[0]?.status==="uploading"&&<div className="global-upload-queue-progress"
    role="progressbar" aria-label="文件上传进度" aria-valuemin={0} aria-valuemax={100}
    aria-valuenow={outstanding[0].progress?.total?Math.min(99,Math.floor(outstanding[0].progress.loaded/outstanding[0].progress.total*100)):undefined}>
    <div style={{width:outstanding[0].progress?.total?Math.min(99,Math.floor(outstanding[0].progress.loaded/outstanding[0].progress.total*100))+"%":"30%"}}/>
   </div>}
  </div>}
 </>;
}
