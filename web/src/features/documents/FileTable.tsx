import {RareButton,RareDataTable,RareInput,RareSelect} from "../../shared/ui/rare";
import {toast} from "../../shared/ui/feedback";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {useCallback,useEffect,useMemo,useRef,useState,type ChangeEvent,type DragEvent,type KeyboardEvent,type MouseEvent,type ReactNode}from "react";
import {useNavigate}from "react-router-dom";
import type {FileItem} from "../../entities/file/model";
import type {Folder} from "../../entities/folder/model";
import {fileApi,formatSize} from "./api";
import {revalidateFileWindow} from "./revalidate";
import {useUploadStore} from "./uploadStore";
import {downloadZip,type ZipProgress} from "./zipDownload";
import {FileRenameDialog} from "./FileRenameDialog";
import {batchConflict,batchExcluded,batchFailed,batchMoveInvalidTarget,batchPickTarget,batchSubmitStarted,batchSucceeded,failed,fileMoveInvalidTarget,openBatch,openFlow,pickTarget,preflightConflict,preflightReady,preflightStarted,submitStarted,succeeded,type BatchMoveFlow,type MoveFlow,type MovePreflight}from"./moveFileFlow";
import {errorCode,errorCopy} from "../../shared/errors";
import {request} from "../../shared/http";
import {newIdempotencyKey} from "../../shared/ids";
import {Dialog} from "../../shared/ui/Dialog";
import {FolderPicker} from "../../shared/ui/FolderPicker";
import {BatchPrintDialog} from "./BatchPrintDialog";
import {Menu,type MenuItem,type MenuPoint}from"../../shared/ui/Menu";
import {MicroHoldToDelete}from"../../shared/ui/rare";
import"./dragMove.css";
import {setMoveDragImage} from "./dragPreview";
import {classifyFile} from "../../shared/fileTypes";
import {FileTypeIcon} from "../../shared/ui/FileTypeIcon";
import"./fileTable.css";

type SortKey="updated_desc"|"name_asc"|"name_desc"|"size_desc";

const SORT_LABELS:Record<SortKey,string>={
 updated_desc:"最近修改",
 name_asc:"名称 A→Z",
 name_desc:"名称 Z→A",
 size_desc:"大小降序",
};

const SORT_KEYS:SortKey[]=["updated_desc","name_asc","name_desc","size_desc"];

export {classifyFile} from "../../shared/fileTypes";
export type {FileCategory} from "../../shared/fileTypes";

// Locked ultra-compact density (26px rows): permanent high-density layout
type Density="compact";

// Internal file→folder move gesture (DESKTOP-INTERACTION-v1 §7.2, DI-17). The
// folder tree is a sibling feature and neither feature may import the other
// (scripts/check_architecture.py), so the two halves of one gesture speak over
// two window events with a fixed detail shape; folders/FolderTree.tsx carries
// the same block:
//   filesmanage:move-session {active,ids,sourceFolderId,focusId}
//     FileTable → tree on dragstart/dragend: the captured source set. A drag is
//     local state only — nothing here writes to the server.
//   filesmanage:move-drop {targetFolderId}
//     tree → FileTable on a legal drop: open the ordinary move dialog with that
//     folder preselected. The drop never moves anything by itself.
const MOVE_SESSION_EVENT="filesmanage:move-session";
const MOVE_DROP_EVENT="filesmanage:move-drop";
const DRAG_MIME="application/x-filesmanage-files";

// What dragstart captures: the source set (the current selection when the
// dragged row is inside it, otherwise that row alone — the row menu's scoping
// rule), the source folder and the focus the gesture started from.
type MoveDragSession={ids:string[];sourceFolderId:string;focusId:string|null};
type MoveSessionDetail=MoveDragSession&{active:boolean};
type MoveDropDetail={targetFolderId:string};

// An internal move drag and nothing else. A drag that also carries OS files is
// treated as an upload (the conservative choice, DI-17): the DropZone keeps it
// and the tree stays out of it. The duplicate of this helper in
// folders/FolderTree.tsx is deliberate — the import boundary forbids sharing it.
function isInternalMoveDrag(dataTransfer:DataTransfer|null):boolean{
 if(!dataTransfer)return false;
 const types=Array.from(dataTransfer.types);
 if(!types.includes(DRAG_MIME)||types.includes("Files"))return false;
 for(let index=0;index<dataTransfer.items.length;index+=1){
  if(dataTransfer.items[index]?.kind==="file")return false;
 }
 return true;
}

// WF-23 row action state. The caller's favorites are read and written through
// the shared JSON client instead of the collaboration feature's api module:
// features/documents -> features/collaboration would fail
// scripts/check_architecture.py (the same reason RestoreDialog reads
// /folders/tree directly).
type FavoriteRow={kind:string;fileId?:string};

// Desktop resource-explorer semantics (DESKTOP-INTERACTION-v1 §1-§3): single
// click selects, double click opens, Ctrl/Cmd toggles, Shift ranges over the
// current visible order, and the keyboard mirrors every mouse action. The
// selection model keeps focus, anchor and membership separate so a stale
// anchor can never resurrect after a re-sort.
export function FileTable({folder,folderName,onEdit,reloadKey,newFolderSlot}:{folder:string;folderName:string;onEdit:(fileId:string)=>void;reloadKey:number;newFolderSlot?:ReactNode}){
 const[items,setItems]=useState<FileItem[]>([]);
// Round-trip of the list read the status bar reports (spec §3.1). It is an
// observation of the request that already runs below — never an extra one —
// so a failed read shows "—" instead of a stale number.
const[latencyMs,setLatencyMs]=useState<number|null>(null);
 const[status,setStatus]=useState("loading");
 const[sort,setSort]=useState<SortKey>("updated_desc");
 const[categoryFilter,setCategoryFilter]=useState<FileCategory>("all");
 const[nameFilter,setNameFilter]=useState("");
 const[cursor,setCursor]=useState("");
 const[hasMore,setHasMore]=useState(false);
 const[loadingMore,setLoadingMore]=useState(false);
 const[moreError,setMoreError]=useState("");
 // A page response belongs to a particular directory/order revision. React
 // state alone cannot prevent a late response after navigating elsewhere.
 const listRevision=useRef(0);
 const listKey=folder+"\u0000"+sort+"\u0000"+reloadKey;
 const listKeyRef=useRef(listKey);
 listKeyRef.current=listKey;
 const lastViewRef=useRef(folder+"\u0000"+sort);
 const pagingRef=useRef(false);
 const completedCursor=useRef("");
 const[renaming,setRenaming]=useState<FileItem|null>(null);
 const[selectedIds,setSelectedIds]=useState<Set<string>>(()=>new Set<string>());
 const selectAllRef=useRef<HTMLInputElement>(null);
 const[focusedId,setFocusedId]=useState<string|null>(null);
 const[anchorId,setAnchorId]=useState<string|null>(null);
 const[pendingDelete,setPendingDelete]=useState<FileItem[]>([]);
 const[printingBatch,setPrintingBatch]=useState<FileItem[]|null>(null);
 // Transient context-menu state (DESKTOP-INTERACTION §1.1 contextTarget): it
 // lives only while the row menu is open and is never business state.
 const[rowMenu,setRowMenu]=useState<{targets:FileItem[];point:MenuPoint|null;anchor:HTMLElement|null}|null>(null);
 const[deleteBusy,setDeleteBusy]=useState(false);
 const[zipProgress,setZipProgress]=useState<ZipProgress|null>(null);
 const zipController=useRef<AbortController|null>(null);
 useEffect(()=>()=>zipController.current?.abort(),[]);
 const[deleteFailures,setDeleteFailures]=useState<Record<string,string>>({});
 function openDelete(targets:FileItem[]){
  setDeleteFailures({});
  setPendingDelete(targets);
 }
 function closeDelete(){setPendingDelete([]);setDeleteFailures({});}
 // WF-01: the file being moved through the single-file CAS endpoint.
 const[moving,setMoving]=useState<FileItem|null>(null);
 // WF-07/WF-08/ADR-UX-02: the multi-selection being moved through the
 // all-or-nothing batch endpoint — the snapshot the row menu opened on.
 const[movingBatch,setMovingBatch]=useState<FileItem[]|null>(null);
 // The live internal-move drag session (§7.2) and source-row lift state.
 // The native drag image is a separate filename-only surface, not a table row.
 const dragSession=useRef<MoveDragSession|null>(null);
 const[draggingIds,setDraggingIds]=useState<Set<string>>(()=>new Set<string>());
 // A target preselected by a drop; "" is the menu entry, which opens the same
 // dialog with no candidate.
 const[moveDropTarget,setMoveDropTarget]=useState("");
 // WF-23: ids favorited by the caller, the load state of that list, and the row
 // whose toggle is in flight.
 const[favoriteIds,setFavoriteIds]=useState<Set<string>>(()=>new Set<string>());
 const[favoritesState,setFavoritesState]=useState<"loading"|"ready"|"failed">("loading");
 const[favoriteBusy,setFavoriteBusy]=useState("");
 // Favorite and unfavorite are mutually exclusive states; never stack their
 // transient success messages in the center of the screen.
 const favoriteToastId=useRef(-1);
 const enqueueFiles=useUploadStore(state=>state.enqueueFiles);
 const navigate=useNavigate();

 useEffect(()=>{
  let valid=true;
  const controller=new AbortController();
  const revision=++listRevision.current;
  const viewKey=folder+"\u0000"+sort;
  const viewChanged=viewKey!==lastViewRef.current;
  const hasPreviousRows=!viewChanged&&items.length>0;
  lastViewRef.current=viewKey;
  pagingRef.current=false;
  completedCursor.current="";
  setLoadingMore(false);
  setMoreError("");
  // A background WebSocket revalidation is a stale-while-revalidate read.
  // Keep existing rows visible and preserve selection while the fresh page
  // arrives. Only directory/sort navigation resets the old list immediately.
  if(viewChanged||status!=="ready"){
   setStatus("loading");
   if(viewChanged)setItems([]);
  }
  if(viewChanged){setCursor("");setHasMore(false);}
  const started=performance.now();
  // Preserve all loaded pages across remote updates; re-query the visible
  // ordered window instead of merging stale cursor pages with a fresh page.
  const visibleCount=hasPreviousRows?items.length:50;
  revalidateFileWindow((next,limit,signal)=>fileApi.list(folder,sort,next,limit,signal),visibleCount,controller.signal)
   .then(page=>{
    if(!valid||revision!==listRevision.current||listKeyRef.current!==listKey)return;
    setItems(page.items);
    setSelectedIds(current=>{
     const ids=new Set(page.items.map(item=>item.id));
     const kept=new Set([...current].filter(id=>ids.has(id)));
     return kept.size===current.size?current:kept;
    });
    setFocusedId(current=>current&&page.items.some(item=>item.id===current)?current:null);
    setAnchorId(current=>current&&page.items.some(item=>item.id===current)?current:null);
    setHasMore(page.nextCursor!=="");
    setCursor(page.nextCursor);
    setStatus("ready");
    setLatencyMs(Math.max(0,Math.round(performance.now()-started)));
   })
   .catch(error=>{if(valid&&revision===listRevision.current&&listKeyRef.current===listKey){
    if(["E_FORBIDDEN","E_NOT_FOUND","E_AUTH"].includes(errorCode(error))){
     setItems([]);setSelectedIds(new Set());setCursor("");setHasMore(false);setStatus("failed");return;
    }
    // Keep last successfully rendered rows on a transient refresh failure.
    setStatus(hasPreviousRows?"ready":"failed");setLatencyMs(null);
   }});
  return()=>{valid=false;controller.abort();};
 },[folder,sort,reloadKey]);

 // A directory, sort or reload change is a new order revision: the previous
 // selection, anchor and focus describe a list that no longer exists.
 useEffect(()=>{
  setSelectedIds(new Set<string>());
  setFocusedId(null);
  setAnchorId(null);
  setRowMenu(null);
 },[folder,sort]);

 // The favorite marks are read once per list revision. A failed read leaves the
 // row action disabled: the button must not claim "not favorited" when the
 // caller's list is unknown.
 useEffect(()=>{
  let valid=true;
  setFavoritesState("loading");
  request<FavoriteRow[]>("/favorites")
   .then(rows=>{
    if(!valid)return;
    const next=new Set<string>();
    for(const row of rows){
     if(row.kind==="file"&&row.fileId)next.add(row.fileId);
    }
    setFavoriteIds(next);
    setFavoritesState("ready");
   })
   .catch(()=>{if(valid)setFavoritesState("failed");});
  return()=>{valid=false;};
 },[folder,reloadKey]);

 // A legal drop on a tree node opens the same move dialog the row menu opens,
 // with the dropped folder as the pre-selected candidate; the preflight and the
 // commit are unchanged, so a drop never bypasses validation (§7.2, DI-17).
 useEffect(()=>{
  function onMoveDrop(event:Event){
   const target=(event as CustomEvent<MoveDropDetail|undefined>).detail?.targetFolderId??"";
   const captured=dragSession.current;
   if(target===""||!captured)return;
   dragSession.current=null;
   // The captured set must still be exactly what the list shows: a reload
   // during the drag means those rows are no longer the visible ones, so the
   // gesture stops instead of opening a dialog about a stale set.
   const sources=items.filter(file=>captured.ids.includes(file.id));
   if(sources.length!==captured.ids.length){
    announce("文件列表已变化，移动未开始，请重试","error");
    return;
   }
   setMoveDropTarget(target);
   if(sources.length===1)setMoving(sources[0]??null);
   else if(sources.length>1)setMovingBatch(sources);
  }
  window.addEventListener(MOVE_DROP_EVENT,onMoveDrop);
  return()=>window.removeEventListener(MOVE_DROP_EVENT,onMoveDrop);
 },[items]);

 function announce(text:string,tone:"info"|"error",toastText=text){
  if(toastText.trim())(tone==="error"?toast.error:toast.success)(toastText);
 }

 function favoriteFeedback(text:string,tone:"success"|"danger"|"warning"="success"){
  if(favoriteToastId.current!==-1)toast.dismiss(favoriteToastId.current);
  favoriteToastId.current=tone==="warning"?toast.warning(text):tone==="danger"?toast.error(text):toast.success(text);
 }


 // The toggle is optimistic because the endpoint is idempotent in both
 // directions; a failed write restores the previous local state instead of
 // leaving the row showing a favorite the server never recorded.
 async function toggleFavorite(file:FileItem){
  if(favoritesState!=="ready"||favoriteBusy!=="")return;
  const on=!favoriteIds.has(file.id);
  setFavoriteBusy(file.id);
  setFavoriteIds(prev=>{
   const next=new Set(prev);
   if(on)next.add(file.id);else next.delete(file.id);
   return next;
  });
  try{
   await request<{id:string;favorited:boolean}>("/favorites/file/"+file.id,{method:on?"PUT":"DELETE"});
   favoriteFeedback(on?"已收藏":"已取消收藏");
  }catch(error){
   setFavoriteIds(prev=>{
    const next=new Set(prev);
    if(on)next.delete(file.id);else next.add(file.id);
    return next;
   });
   favoriteFeedback(errorCode(error)==="E_NETWORK"
    ?"网络中断，收藏状态未确认；请刷新后核对"
    :errorCopy(error,on?"收藏失败，请重试":"取消收藏失败，请重试"),
    errorCode(error)==="E_NETWORK"?"warning":"danger");
  }finally{
   setFavoriteBusy("");
  }
 }

 async function reload(){
  const revision=++listRevision.current;
  pagingRef.current=false;
  completedCursor.current="";
  setLoadingMore(false);
  setMoreError("");
  const page=await revalidateFileWindow((next,limit)=>fileApi.list(folder,sort,next,limit),items.length);
  if(revision!==listRevision.current||listKeyRef.current!==listKey)return;
  setItems(page.items);setHasMore(page.nextCursor!=="");setCursor(page.nextCursor);
  setSelectedIds(current=>{
   const ids=new Set(page.items.map(item=>item.id));
   return new Set([...current].filter(id=>ids.has(id)));
  });
 }

 // DI-18/WF-27: the toolbar input is the non-drag upload entry. It enqueues
 // into the same store the drop zone feeds, so both entries share one queue,
 // one idempotency identity and the same per-item progress, failures and
 // 重试/改名重试/跳过/取消 actions, which the queue itself reports. The
 // announcement only states the local enqueue fact, never a server result.
 function onUpload(event:ChangeEvent<HTMLInputElement>){
  const files=Array.from(event.target.files??[]);
  event.target.value="";
  if(files.length===0)return;
  enqueueFiles(files,folder);
  // Upload store is the sole owner of enqueue/progress feedback.
 }

 async function loadMore(){
  if(status!=="ready"||!cursor||!hasMore||pagingRef.current||completedCursor.current===cursor)return;
  const revision=listRevision.current;
  const requestedCursor=cursor;
  pagingRef.current=true;
  setLoadingMore(true);
  setMoreError("");
  try{
   const page=await fileApi.list(folder,sort,requestedCursor,50);
   if(revision!==listRevision.current||listKeyRef.current!==listKey)return;
   completedCursor.current=requestedCursor;
   setItems(prev=>{
    const known=new Set(prev.map(item=>item.id));
    return [...prev,...page.items.filter(item=>!known.has(item.id))];
   });
   setCursor(page.nextCursor);
   setHasMore(page.nextCursor!=="");
  }catch(error){
   if(revision===listRevision.current&&listKeyRef.current===listKey){
    setMoreError(errorCopy(error,"加载下一页失败，请重试"));
   }
  }finally{
   if(revision===listRevision.current&&listKeyRef.current===listKey){
    pagingRef.current=false;
    setLoadingMore(false);
   }
  }
 }


  async function batchDownload(files:FileItem[]){
   if(files.length===0||zipController.current)return;
   // Up to three selected files retain their original formats and filenames.
   // Trigger all links synchronously within the user's click gesture.
   if(files.length<=3){
    setZipProgress(null);
    for(const file of files)startDownload(file);
    announce(files.length===1?"已请求下载文件":`已请求下载 ${files.length} 个原文件`,"info");
    return;
   }
   if(files.length>30){announce("单次最多打包 30 个文件，请分批下载","error");return;}
   const originalBytes=files.reduce((sum,file)=>sum+file.sizeBytes,0);
   if(originalBytes>512*1024*1024){
    announce("打包原始文件最多 512 MiB，请分批下载","error");return;
   }
   const controller=new AbortController();zipController.current=controller;
   try{
    const outcome=await downloadZip(files.map(f=>f.id),originalBytes,controller.signal,setZipProgress);
    if(outcome==="handoff")announce("已交由浏览器下载管理器，进度和取消请在浏览器下载列表操作","info");
    else{announce("ZIP 已准备好，浏览器正在保存文件","info");setZipProgress(null);}
   }catch(error){
    if(controller.signal.aborted){setZipProgress(null);announce("ZIP 下载已取消","info");}
    else{const message=errorCopy(error,"ZIP 下载失败");setZipProgress({phase:"failed",bytes:0,error:message});announce(message,"error");}
   }finally{if(zipController.current===controller)zipController.current=null;}
  }

  const visibleItems=useMemo(()=>{
   let list=items;
   if(nameFilter.trim()){
    const q=nameFilter.trim().toLowerCase();
    list=list.filter(item=>item.name.toLowerCase().includes(q));
   }
   if(categoryFilter!=="all"){
    list=list.filter(item=>classifyFile(item.name).category===categoryFilter);
   }
   return list;
  },[items,categoryFilter,nameFilter]);

 const categoryCounts=useMemo(()=>{
  const map:Record<FileCategory,number>={
   all:items.length,cad:0,doc:0,image:0,media:0,archive:0,code:0,other:0,
  };
  for(const item of items){
   const cat=classifyFile(item.name).category;
   map[cat]=(map[cat]??0)+1;
  }
  return map;
 },[items]);

 function visibleRange(fromId:string,toId:string):string[]{
  const from=visibleItems.findIndex(i=>i.id===fromId);
  const to=visibleItems.findIndex(i=>i.id===toId);
  if(from<0||to<0)return[toId];
  const low=Math.min(from,to);
  const high=Math.max(from,to);
  return visibleItems.slice(low,high+1).map(i=>i.id);
 }

 function onRowClick(event:MouseEvent<HTMLTableRowElement>,item:FileItem){
  if(event.metaKey||event.ctrlKey){
   setSelectedIds(prev=>{
    const next=new Set(prev);
    if(next.has(item.id))next.delete(item.id);else next.add(item.id);
    return next;
   });
   setFocusedId(item.id);
   setAnchorId(item.id);
   return;
  }
  if(event.shiftKey&&anchorId){
   setSelectedIds(new Set(visibleRange(anchorId,item.id)));
   setFocusedId(item.id);
   return;
  }
  setSelectedIds(new Set([item.id]));
  setFocusedId(item.id);
  setAnchorId(item.id);
 }

 // The checkbox column mirrors the row model but never replaces the selection:
 // plain/Ctrl/Cmd only toggle this row's membership, Shift extends the same
 // visibleRange the row click uses. Modifiers come from the native event (React
 // fires a checkbox onChange from the click) and focus always follows.
 function onCheckToggle(event:ChangeEvent<HTMLInputElement>,item:FileItem){
  if((event.nativeEvent as {shiftKey?:boolean}).shiftKey&&anchorId){
   setSelectedIds(new Set(visibleRange(anchorId,item.id)));
   setFocusedId(item.id);
   return;
  }
  setSelectedIds(prev=>{
   const next=new Set(prev);
   if(next.has(item.id))next.delete(item.id);else next.add(item.id);
   return next;
  });
  setFocusedId(item.id);
 }

 // The header box acts on the whole loaded page; selecting all also sets the
 // anchor to the first row so a following Shift range has a base.
 function toggleSelectAllLoaded(){
  if(allLoadedSelected){setSelectedIds(new Set<string>());setAnchorId(null);return;}
  setSelectedIds(new Set(visibleItems.map(i=>i.id)));
  setAnchorId(visibleItems[0]?.id??null);
 }

 function focusRow(id:string){
  const row=document.querySelector<HTMLTableRowElement>(`tbody tr[data-id="${CSS.escape(id)}"]`);
  row?.focus();
 }

 // DESKTOP-INTERACTION §3.1: right-clicking a row inside the selection keeps
 // the whole selection; an unselected row becomes the single selection first.
 function onRowContextMenu(event:MouseEvent<HTMLTableRowElement>,item:FileItem){
  event.preventDefault();
  const inside=selectedIds.has(item.id);
  if(!inside){
   setSelectedIds(new Set([item.id]));
   setFocusedId(item.id);
   setAnchorId(item.id);
  }
  setRowMenu({targets:inside?selection:[item],point:{x:event.clientX,y:event.clientY},anchor:event.currentTarget});
 }

 // DESKTOP-INTERACTION §7.2: dragstart only creates the session — the source
 // set, the source folder and the original focus — and writes nothing to the
 // server. The scope rule mirrors the row menu: a row inside the selection
 // drags the whole selection, an unselected row becomes the single source first.
 function onRowDragStart(event:DragEvent<HTMLTableRowElement>,item:FileItem){
  const origin=event.target as HTMLElement|null;
  // The actions cell keeps its own behaviour: a link or button must never
  // become the drag source of a row move.
  if(origin?.closest("a,button,input,select,textarea")){event.preventDefault();return;}
  const inside=selectedIds.has(item.id);
  if(!inside){
   setSelectedIds(new Set([item.id]));
   setFocusedId(item.id);
   setAnchorId(item.id);
  }
  const sources=inside?selection:[item];
  const ids=sources.map(file=>file.id);
  const dataTransfer=event.dataTransfer;
  // An empty set is never draggable.
  if(ids.length===0||!dataTransfer){event.preventDefault();return;}
  const session:MoveDragSession={ids,sourceFolderId:folder,focusId:item.id};
  dragSession.current=session;
  setDraggingIds(new Set(ids));
  // "move" and never "copy"/"copyMove": this phase offers no copy, and a copy
  // cursor over a gesture that moves would misstate the outcome (§7.2).
  dataTransfer.effectAllowed="move";
  dataTransfer.setData(DRAG_MIME,JSON.stringify(session));
  // Native text fallback mirrors the filename-only visual ghost.
  dataTransfer.setData("text/plain",ids.length===1?item.name:`${item.name} +${ids.length-1}`);
  setMoveDragImage(dataTransfer,item.name,ids.length);
  window.dispatchEvent(new CustomEvent<MoveSessionDetail>(MOVE_SESSION_EVENT,{detail:{active:true,...session}}));
 }

 function onRowDragEnd(){
  const ended=dragSession.current;
  dragSession.current=null;
  setDraggingIds(current=>current.size===0?current:new Set<string>());
  window.dispatchEvent(new CustomEvent<MoveSessionDetail>(MOVE_SESSION_EVENT,{detail:{active:false,ids:[],sourceFolderId:ended?.sourceFolderId??folder,focusId:null}}));
 }

 // Over the source list an internal drag is a cancel ("拖回来源", §7.2) and it
 // must not light up the upload zone either, so it is kept from reaching the
 // DropZone's handlers. External file drags are untouched and keep bubbling to
 // them (DI-17: an upload and a move must never be confused).
 function suppressInternalDrag(event:DragEvent<HTMLDivElement>){
  if(!dragSession.current||!isInternalMoveDrag(event.dataTransfer))return;
  event.stopPropagation();
 }

 function moveFocus(index:number,extend:boolean){
  if(visibleItems.length===0)return;
  const next=Math.max(0,Math.min(visibleItems.length-1,index));
  const target=visibleItems[next];
  if(!target)return;
  if(extend&&anchorId){
   setSelectedIds(new Set(visibleRange(anchorId,target.id)));
  }else{
   setSelectedIds(new Set([target.id]));
   setAnchorId(target.id);
  }
  setFocusedId(target.id);
  focusRow(target.id);
 }

 function onGridKeyDown(event:KeyboardEvent<HTMLTableSectionElement>){
  if(visibleItems.length===0)return;
  const index=focusedId?visibleItems.findIndex(i=>i.id===focusedId):-1;
  const current=index>=0?visibleItems[index]:null;
  switch(event.key){
   case "ArrowDown":
    event.preventDefault();moveFocus(index+1,event.shiftKey);break;
   case "ArrowUp":
    event.preventDefault();moveFocus(index-1,event.shiftKey);break;
   case "Home":
    event.preventDefault();moveFocus(0,event.shiftKey);break;
   case "End":
    event.preventDefault();moveFocus(visibleItems.length-1,event.shiftKey);break;
   case " ":
    if(!current)return;
    event.preventDefault();
    setSelectedIds(prev=>{
     const next=new Set(prev);
     if(next.has(current.id))next.delete(current.id);else next.add(current.id);
     return next;
    });
    break;
   case "Enter":
    if(!current)return;
    event.preventDefault();
    navigate("/preview/"+current.id);
    break;
   case "Escape":
    // Escape unwinds the topmost cancelable layer only; with no dialog or
    // menu open it clears the explorer selection.
    if(selectedIds.size>0){event.preventDefault();setSelectedIds(new Set<string>());setAnchorId(null);}
    break;
   case "Delete":
    if(selectedIds.size===0)return;
    event.preventDefault();
    openDelete(visibleItems.filter(i=>selectedIds.has(i.id)));
    break;
   case "F2":
    if(selectedIds.size!==1)return;
    event.preventDefault();
    {const only=visibleItems.find(i=>selectedIds.has(i.id));if(only)setRenaming(only);}
    break;
   case "F10":
    // Shift+F10 is the keyboard equivalent of a right-click on the focused
    // row; the bare F10 key stays with the browser.
    if(!event.shiftKey)return;
    event.preventDefault();
    if(current)openRowMenu(current);
    break;
   case "ContextMenu":
    event.preventDefault();
    if(current)openRowMenu(current);
    break;
   default:
    if((event.metaKey||event.ctrlKey)&&(event.key==="a"||event.key==="A")){
     event.preventDefault();
     setSelectedIds(new Set(visibleItems.map(i=>i.id)));
    }
  }
 }

 function openRowMenu(item:FileItem,trigger?:HTMLElement){
  const row=trigger??document.querySelector<HTMLTableRowElement>(`tbody tr[data-id="${CSS.escape(item.id)}"]`);
  // The keyboard menu mirrors the mouse scoping: a focused row inside the
  // selection acts on the whole selection, otherwise on the row alone.
  setRowMenu({targets:selectedIds.has(item.id)?selection:[item],point:null,anchor:row});
 }

 // WF-11: the menu only offers what the whole target set can legally perform.
 // FileItem carries no permission or lock facts, so actions without a batch
 // endpoint — open, edit, rename, download — stay single-selection, while the
 // move entry acts on the whole selection: one file through the CAS endpoint,
 // two or more through the all-or-nothing batch (ADR-UX-02), which the server
 // rejects as a unit rather than silently applying to part of the set.
 // Deletion keeps its per-item confirmation with explicit partial-failure
 // reporting.
 function rowMenuItems(targets:FileItem[]):MenuItem[]{
  const single=targets.length===1?targets[0]:null;
  const items:MenuItem[]=[];
  if(single){
   const file:FileItem=single;
   items.push({id:"open",label:"打开",hint:"Enter",onSelect:()=>navigate("/preview/"+file.id)});
   items.push({id:"edit",label:"编辑",onSelect:()=>onEdit(file.id)});
   items.push({id:"rename",label:"重命名",hint:"F2",onSelect:()=>setRenaming(file)});
   items.push({id:"move",label:"移动到…",onSelect:()=>startMove(file)});
   items.push({id:"download",label:"下载",onSelect:()=>startDownload(file)});
   items.push({id:"print",label:"打印",onSelect:()=>navigate("/preview/"+file.id+"?print=1")});
  }else if(targets.length>1){
   items.push({id:"move-batch",label:"移动到…",onSelect:()=>startMoveSelection(targets)});
   if(targets.length<=20)items.push({id:"print-batch",label:"批量打印",onSelect:()=>setPrintingBatch(targets)});
  }
  items.push({id:"delete",label:"删除",hint:"Delete",danger:true,onSelect:()=>openDelete(targets)});
  return items;
 }

 // The row-actions cell downloads through a plain <a download>; the menu
 // reproduces that navigation so the browser, not an XHR, fetches the bytes.
 function startDownload(file:FileItem){
  const link=document.createElement("a");
  link.href="/api/files/"+file.id+"/bytes";
  link.download=file.name;
  document.body.append(link);
  link.click();
  link.remove();
 }

 // Deletion runs per item: the API has no batch endpoint, so each result is
 // reported individually and a partial failure never claims full success.
 async function confirmDelete(){
  const targets=pendingDelete;
  if(targets.length===0||deleteBusy)return;
  setDeleteBusy(true);
  const failed:FileItem[]=[];
  const reasons:Record<string,string>={};
  const removedIds=new Set<string>();
  for(const target of targets){
   try{
    await fileApi.remove(target.id);
    removedIds.add(target.id);
   }catch(error){
    failed.push(target);
    reasons[target.id]=errorCopy(error,"无法删除，请确认权限和文件状态");
   }
  }
  setDeleteBusy(false);
  setDeleteFailures(reasons);
  setPendingDelete(failed);
  setSelectedIds(prev=>{
   const next=new Set(prev);
   for(const id of removedIds)next.delete(id);
   return next;
  });
  if(removedIds.size)announce(`已移入回收站 ${removedIds.size} 项`,"info");
  if(failed.length)announce(`另有 ${failed.length} 项失败，请在弹窗内查看原因并重试`,"error");
  try{
   await reload();
  }catch{
   announce("操作已提交，但列表刷新失败，请手动刷新后核对","error");
  }
 }

 // DI-18 touch/no-drag fallback: moving without dragging. The selection-bar
 // button and the row menu both land here, one file or many — dragging is never
 // the only way to move (§7.2).
 function startMoveSelection(files:FileItem[]){
  if(files.length===0)return;
  setMoveDropTarget("");
  if(files.length===1)setMoving(files[0]??null);
  else setMovingBatch(files);
 }

 function startMove(file:FileItem){
  startMoveSelection([file]);
 }

 // WF-09: a committed move changes this folder's content and the file's
 // authorization scope, so the source list reloads and the moved row leaves the
 // selection. The destination tree and inspector refresh on their next read.
 function onMoved(file:FileItem){
  setMoving(null);
  setMoveDropTarget("");
  setSelectedIds(prev=>{
   if(!prev.has(file.id))return prev;
   const next=new Set(prev);
   next.delete(file.id);
   return next;
  });
  announce(`已移动：${file.name}`,"info");
  void reload().catch(()=>announce("操作已提交，但列表刷新失败，请手动刷新后核对","error"));
 }

 // Used when the move outcome is unknown or the CAS basis is stale: re-reading
 // the list is the only honest way to show what actually happened.
 function onMoveReload(){
  void reload().catch(()=>announce("列表刷新失败，请手动刷新后核对","error"));
 }

 // WF-09: the same boundary as the single-file move — this table reloads its
 // own list and announces the committed result; the destination tree, the
 // inspector and the search/favorites views refresh as the page re-reads them.
 function onBatchMoved(movedIds:string[]){
  setMovingBatch(null);
  setMoveDropTarget("");
  setSelectedIds(prev=>{
   const next=new Set(prev);
   for(const id of movedIds)next.delete(id);
   return next;
  });
  announce(`已移动 ${movedIds.length} 个文件`,"info");
  void reload().catch(()=>announce("操作已提交，但列表刷新失败，请手动刷新后核对","error"));
 }

 const selection=visibleItems.filter(i=>selectedIds.has(i.id));
 const selectedBytes=selection.reduce((sum,file)=>sum+file.sizeBytes,0);
 const selectedVisibleCount=visibleItems.reduce((count,item)=>count+(selectedIds.has(item.id)?1:0),0);
 const allLoadedSelected=visibleItems.length>0&&selectedVisibleCount===visibleItems.length;
 // Mixed selection is a real native indeterminate checkbox state, including
 // screen-reader semantics. Never fake it with another selected-row border.
 useEffect(()=>{
  if(selectAllRef.current)selectAllRef.current.indeterminate=selectedVisibleCount>0&&!allLoadedSelected;
 },[selectedVisibleCount,allLoadedSelected]);

 // The work area is not a move target: an internal drag over it is a cancel
 // ("拖回来源", §7.2) and it must not light up the upload zone either, so its
 // drag events are stopped before the DropZone sees them. External file drags
 // are untouched and keep bubbling (DI-17: upload intent stays with §7.1).
 return <div className="work-body"
  onDragEnter={suppressInternalDrag}
  onDragOver={suppressInternalDrag}
  onDragLeave={suppressInternalDrag}
  onDrop={suppressInternalDrag}>
  <div className="toolbar file-toolbar">
   <div className="toolbar-actions">
    <label className="upload-button primary-btn">
     <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14"/></svg>
     <span>上传文件</span>
     <RareInput type="file" multiple onChange={onUpload}/>
    </label>
    {newFolderSlot}
    {selectedIds.size>0&&<div className="batch-actions-group" role="group" aria-label={`已选 ${selectedIds.size} 个文件的批量操作`}>
     <span className="file-selected-count" aria-live="polite">已选 <strong>{selectedIds.size}</strong></span>
     <RareButton type="button" tone="ghost" className="batch-btn" disabled={zipController.current!==null} onClick={()=>void batchDownload(selection)} title="批量下载已勾选文件">下载</RareButton>
     <RareButton type="button" tone="ghost" className="batch-btn" disabled={selectedIds.size>20}
      onClick={()=>setPrintingBatch(selection)} title={selectedIds.size>20?"每批最多 20 份文件":"逐份确认并打开浏览器打印预览"}>打印</RareButton>
     <RareButton type="button" tone="ghost" className="batch-btn" onClick={()=>startMoveSelection(selection)} title="批量移动已勾选文件">移动</RareButton>
     <RareButton type="button" tone="danger" className="batch-btn danger" onClick={()=>openDelete(selection)} title="批量删除已勾选文件">删除</RareButton>
     <RareButton type="button" tone="ghost" className="batch-clear-selection" onClick={()=>{setSelectedIds(new Set<string>());setAnchorId(null);}} aria-label="取消全部选中" title="取消选择">
      <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg>
     </RareButton>
    </div>}
   </div>
   <div className="toolbar-views">
    <label className="sort-label">排序
     <RareSelect aria-label="排序方式" value={sort} onChange={e=>setSort(e.target.value as SortKey)}>
      {SORT_KEYS.map(key=><option key={key} value={key}>{SORT_LABELS[key]}</option>)}
     </RareSelect>
    </label>
    <label className="filter-label">类型
     <RareSelect aria-label="文件类型筛选" value={categoryFilter} onChange={e=>{
      setCategoryFilter(e.target.value as FileCategory);
      setSelectedIds(new Set<string>());
      setFocusedId(null);
      setAnchorId(null);
     }}>
      <option value="all">全部类型 ({categoryCounts.all})</option>
      <option value="cad">CAD / 3D 图纸 ({categoryCounts.cad})</option>
      <option value="doc">办公文档 ({categoryCounts.doc})</option>
      <option value="image">图片文件 ({categoryCounts.image})</option>
      <option value="media">音视频 ({categoryCounts.media})</option>
      <option value="archive">压缩包 ({categoryCounts.archive})</option>
      <option value="code">代码与数据 ({categoryCounts.code})</option>
      <option value="other">其他文件 ({categoryCounts.other})</option>
     </RareSelect>
    </label>
    <div className="filter-search-wrap">
     <RareInput type="search" className="filter-search-input" placeholder="过滤已加载文件…" aria-label="当前已加载文件名过滤"
      value={nameFilter} onChange={e=>{
       setNameFilter(e.target.value);
       setSelectedIds(new Set<string>());
       setFocusedId(null);
       setAnchorId(null);
      }}/>
    </div>
   </div>
  </div>
  {zipProgress&&<div className="zip-download-status" role="status">
   <span>{zipProgress.phase==="preparing"?"正在鉴权并准备 ZIP…":zipProgress.phase==="receiving"?`ZIP 已接收 ${formatSize(zipProgress.bytes)}（压缩总量未知）`:zipProgress.phase==="saving"?"准备保存 ZIP…":zipProgress.phase==="handoff"?"已交由浏览器下载管理器（可在下载列表查看进度及取消）":zipProgress.error}</span>
   {zipProgress.phase!=="failed"&&zipProgress.phase!=="handoff"&&<span className="zip-progress-track" aria-label="正在下载 ZIP"><span/></span>}
   <RareButton type="button" onClick={()=>{if(zipProgress.phase==="failed"||zipProgress.phase==="handoff")setZipProgress(null);else zipController.current?.abort();}}>
    {zipProgress.phase==="failed"||zipProgress.phase==="handoff"?"关闭":"取消"}
   </RareButton>
  </div>}
  <div className="table" onClick={event=>{if(!(event.target as HTMLElement).closest("tr")){setSelectedIds(new Set<string>());setAnchorId(null);}}}>
   <RareDataTable role="grid" aria-label={folderName+" 文件列表"} density="compact" className="file-table file-table-ultra">
    <thead><tr>
     <th className="col-select" scope="col"><RareInput ref={selectAllRef} type="checkbox" checked={allLoadedSelected} onChange={toggleSelectAllLoaded} aria-label="选择当前已加载的文件"/></th>
     <th className="col-name" scope="col">文件名</th>
     <th className="col-size" scope="col">大小</th>
     <th className="col-version" scope="col">版本</th>
     <th className="col-date" scope="col">修改日期</th>
     <th className="col-actions" scope="col">操作</th>
    </tr></thead>
    <tbody onKeyDown={onGridKeyDown}>
     {status==="loading"&&<tr><td colSpan={6} className="empty"><BrandLoadingLabel size="sm">正在加载文件…</BrandLoadingLabel></td></tr>}
     {status==="failed"&&<tr><td colSpan={6} className="empty" role="alert">获取文件失败，请刷新重试</td></tr>}
     {status==="ready"&&items.length===0&&<tr><td colSpan={6} className="empty">
      <svg className="empty-mark" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h8A1.5 1.5 0 0 1 20 10v7.5A1.5 1.5 0 0 1 18.5 19h-14A1.5 1.5 0 0 1 3 17.5z"/></svg>
      <span className="empty-title">目录为空</span>
      <span className="empty-hint">上传第一个文件开始使用。</span>
     </td></tr>}
     {status==="ready"&&items.length>0&&visibleItems.length===0&&<tr><td colSpan={6} className="empty">
     <span className="empty-title">无匹配文件</span>
      <span className="empty-hint">已加载的文件中没有匹配项{hasMore?"，可继续加载后查找":""}。</span>
      <RareButton type="button" className="secondary-action" style={{marginTop:6}} onClick={()=>{
       setCategoryFilter("all");
       setNameFilter("");
       setSelectedIds(new Set<string>());
       setFocusedId(null);
       setAnchorId(null);
      }}>清除筛选（显示已加载 {items.length} 个文件）</RareButton>
     </td></tr>}
     {status==="ready"&&visibleItems.map((item,index)=><tr key={item.id} data-id={item.id}
      tabIndex={focusedId===item.id||(focusedId===null&&index===0)?0:-1}
      aria-selected={selectedIds.has(item.id)}
      className={(selectedIds.has(item.id)?"selected":"")+(focusedId===item.id?" focused":"")+(draggingIds.has(item.id)?" drag-source":"")}
      draggable
      onClick={event=>onRowClick(event,item)}
      onContextMenu={event=>onRowContextMenu(event,item)}
      onDoubleClick={()=>navigate("/preview/"+item.id)}
      onDragStart={event=>onRowDragStart(event,item)}
      onDragEnd={onRowDragEnd}>
      <td className="col-select"><RareInput type="checkbox" checked={selectedIds.has(item.id)} aria-label={"选择 "+item.name} onClick={event=>event.stopPropagation()} onChange={event=>onCheckToggle(event,item)}/></td>
      <td className="col-name"><div className="file-cell-wrap">
       <FileTypeIcon name={item.name} size={19}/><span className="file-name" title={item.name}>{item.name}</span>
       <small className="file-mobile-meta">v{item.currentVersionSeq} · {formatSize(item.sizeBytes)}</small>
       <RareButton type="button" className="file-mobile-actions" aria-label={"操作 "+item.name}
        title={"文件操作："+item.name} aria-haspopup="menu"
        onClick={event=>{event.stopPropagation();openRowMenu(item,event.currentTarget);}}>···</RareButton>
      </div></td>
      <td className="col-size num">{formatSize(item.sizeBytes)}</td>
      <td className="col-version"><span className="version-badge">v{item.currentVersionSeq}</span></td>
      <td className="col-date date">{item.updatedAt.replace("T"," ").slice(0,16)}</td>
      <td className="row-actions col-actions" onClick={event=>event.stopPropagation()}><div className="actions-cell-wrap">
       <div className="actions-hover-group">
        <RareButton type="button" className="action-link" onClick={()=>navigate("/preview/"+item.id)}>打开</RareButton>
        <a href={"/api/files/"+item.id+"/bytes"} download={item.name} className="action-link">下载</a>
        <RareButton type="button" className="action-link" onClick={()=>onEdit(item.id)}>编辑</RareButton>
        <RareButton type="button" className="action-link more-trigger"
         aria-label={"更多操作："+item.name} aria-haspopup="menu"
         onClick={event=>openRowMenu(item,event.currentTarget)}>···</RareButton>
       </div>
       <RareButton type="button"
        className={"action-star-btn"+(favoriteIds.has(item.id)?" favorited":"")}
        aria-label={favoriteIds.has(item.id)?"已收藏":"收藏"}
        title={favoritesState==="failed"?"收藏状态加载失败，请刷新重试":favoriteIds.has(item.id)?"已收藏（点击取消）":"收藏"}
        disabled={favoritesState!=="ready"||favoriteBusy!==""}
        onClick={()=>toggleFavorite(item)}>
        <svg className="star-icon" viewBox="0 0 24 24" width="14" height="14" fill={favoriteIds.has(item.id)?"currentColor":"none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
         <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
        </svg>
        <span className="sr-only">{favoriteIds.has(item.id)?"已收藏":"收藏"}</span>
       </RareButton>
      </div></td>
     </tr>)}
    </tbody>
   </RareDataTable>
  </div>
  {(hasMore||loadingMore||moreError)&&<div className="file-page-controls" role="group" aria-label="文件分页">
   <RareButton type="button" className="secondary-action" disabled={loadingMore||status!=="ready"||!hasMore} aria-busy={loadingMore} onClick={()=>void loadMore()}>{loadingMore?"正在加载…":moreError?"重试加载":"加载更多"}</RareButton>
   <span className="file-page-hint">{hasMore?"已加载 "+items.length+" 项 · 后面还有文件":"已显示全部 "+items.length+" 项"}</span>
   {moreError&&<span className="file-page-error" role="alert">{moreError}</span>}
  </div>}
  {renaming&&<FileRenameDialog file={renaming} onClose={()=>setRenaming(null)}
   onRenamed={updated=>{setItems(prev=>prev.map(item=>item.id===updated.id?updated:item));setRenaming(null);}}/>}
  {pendingDelete.length>0&&<Dialog open title={Object.keys(deleteFailures).length?"删除部分失败":"删除确认"} onClose={closeDelete} closeGuard={()=>!deleteBusy} className="dialog">
   <form onSubmit={event=>{event.preventDefault();confirmDelete();}}>
    <p className="hint">以下 {pendingDelete.length} 项将移入回收站。按文件逐项处理，失败项可单独重试。</p>
    <ul className="delete-list">
     {pendingDelete.slice(0,8).map(item=><li key={item.id}>{item.name}{deleteFailures[item.id]&&<span className="batch-delete-failure"> · {deleteFailures[item.id]}</span>}</li>)}
     {pendingDelete.length>8&&<li>…等共 {pendingDelete.length} 项</li>}
    </ul>
    <div className="dialog-actions">
     <RareButton type="button" className="secondary-action" onClick={closeDelete} disabled={deleteBusy}>关闭</RareButton>
     <MicroHoldToDelete label={deleteBusy?"删除中…":Object.keys(deleteFailures).length?"重试失败项":"确认删除"} tone="danger" disabled={deleteBusy} onConfirm={confirmDelete}/>
    </div>
   </form>
  </Dialog>}
  {moving&&<MoveDialog file={moving} presetTargetId={moveDropTarget} onClose={()=>{setMoveDropTarget("");setMoving(null);}} onMoved={onMoved} onReload={onMoveReload}/>}
  {movingBatch&&<BatchMoveDialog files={movingBatch} presetTargetId={moveDropTarget} onClose={()=>{setMoveDropTarget("");setMovingBatch(null);}} onMoved={onBatchMoved} onReload={onMoveReload}/>}
   {printingBatch&&<BatchPrintDialog files={printingBatch} onClose={()=>setPrintingBatch(null)}/>}
  {rowMenu&&<Menu open label="文件操作菜单" items={rowMenuItems(rowMenu.targets)} anchor={rowMenu.anchor}
   point={rowMenu.point} onClose={()=>setRowMenu(null)}/>}
  <footer className="status-bar">
   <div className="status-left">
    <span>已选 <span className="status-strong">{selectedIds.size}</span> 项{selectedIds.size>0&&<> / <span className="status-strong">{formatSize(selectedBytes)}</span></>} · {hasMore?"已加载":"共"} <span className="status-strong">{items.length}</span> 个文件{(categoryFilter!=="all"||nameFilter.trim())&&<> · 匹配 <span className="status-strong">{visibleItems.length}</span> 项（已加载范围）</>}</span>
   </div>
   <div className="status-right">
    <span>延迟: <span className="status-strong">{latencyMs===null?"—":latencyMs+"ms"}</span> · <span className="status-build">v2.1.0</span></span>
   </div>
  </footer>
 </div>;
}

const MOVE_CONFLICT_COPY:Record<string,string>={
 E_FORBIDDEN:"没有权限移动到该目录",
 E_NAME_CONFLICT:"目标目录已存在同名文件，请更改目标",
 E_MOVE_CONFLICT:"文件已在该目录",
 E_NOT_FOUND:"资源不存在或已不可访问",
 E_BAD:"无法移动该资源",
};

// The preflight answers per resource; a single-file flow reports the first
// conflict, preferring the stable UI copy over the server's sanitized message.
function conflictNotice(preflight:MovePreflight):string{
 const first=preflight.conflicts[0];
 if(!first)return "预检未通过，请更换目标";
 return MOVE_CONFLICT_COPY[first.code]??first.message??"预检未通过，请更换目标";
}

// The batch answers itemised: the stable code names the reason for one file, so
// every row keeps its own copy instead of collapsing the list into one notice.
function conflictItemCopy(conflict:{code:string;message?:string}):string{
 return MOVE_CONFLICT_COPY[conflict.code]??conflict.message??"无法移动该文件";
}

// Single-file move (COMPLEX-WORKFLOWS-v1 §2-§3, WF-01..WF-06/WF-09). The dialog
// hosts the shared FolderPicker: every valid candidate is preflighted in the
// background, and only a checked candidate unlocks "确认移动". The server stays the authority — the
// commit re-verifies permissions, the target's active state, name uniqueness
// and the CAS folder.
export function MoveDialog({file,presetTargetId,onClose,onMoved,onReload}:{
 file:FileItem;
 // The folder a drop preselected; "" means the menu entry opened this dialog.
 // It only seeds the candidate — the preflight and the commit below are the
 // same steps a menu-opened dialog runs.
 presetTargetId:string;
 onClose:()=>void;
 onMoved:(file:FileItem)=>void;
 onReload:()=>void;
}){
 const[folders,setFolders]=useState<Folder[]>([]);
 const[tree,setTree]=useState<"loading"|"ready"|"failed">("loading");
 const[treeToken,setTreeToken]=useState(0);
 const[flow,setFlow]=useState<MoveFlow>(()=>presetTargetId===""?openFlow():pickTarget(openFlow(),presetTargetId));
 const[preflight,setPreflight]=useState<MovePreflight|null>(null);
 const[needsRefresh,setNeedsRefresh]=useState(false);
 // Preflight generation: a late answer for a previous candidate must never
 // unlock the confirm action of the current one (WF-05).
 const checkSeq=useRef(0);

 useEffect(()=>{
  let valid=true;
  setTree("loading");
  // The visible tree is read through the shared JSON client so this feature
  // stays independent of the folders module (the architecture gate forbids
  // features/documents -> features/folders), exactly as RestoreDialog does.
  request<Folder[]>("/folders/tree")
   .then(data=>{if(!valid)return;setFolders(data);setTree("ready");})
   .catch(()=>{if(valid)setTree("failed");});
  return()=>{valid=false;};
 },[treeToken]);

 const dialogTitle="移动文件";
 // A running preflight must not lock the tree: choosing another target cancels
 // its relevance through checkSeq, while the actual commit still locks edits.
 const busy=flow.state==="submitting";
 const selected=folders.find(folder=>folder.id===flow.targetId)??null;
 const invalid=selected?fileMoveInvalidTarget(selected,file,folders):null;
 const canCheck=tree==="ready"&&!busy&&!needsRefresh&&selected!==null&&invalid===null;
 const canConfirm=canCheck&&flow.state==="ready"&&preflight?.status==="ready"&&preflight.allowedCount>0;

 function close(){
  if(busy)return;
  onClose();
 }

 function choose(targetId:string){
  // Re-selecting a checked target is a no-op; a rejected/failed target can be
  // checked again after an external conflict is resolved.
  if(targetId===flow.targetId){
   if(flow.state!=="ready"&&flow.state!=="validating")void check(targetId);
   return;
  }
  // A new candidate voids any in-flight or previous preflight.
  checkSeq.current+=1;
  setPreflight(null);
  setFlow(current=>pickTarget(current,targetId));
 }

 const check=useCallback(async(targetId:string)=>{
  const seq=++checkSeq.current;
  setPreflight(null);
  setFlow(current=>current.targetId===targetId?preflightStarted(current):current);
  try{
   const data=await request<MovePreflight>("/moves/preflight",{method:"POST",body:JSON.stringify({resources:[{kind:"file",id:file.id}],targetFolderId:targetId,mode:"all_or_nothing"})});
   if(seq!==checkSeq.current)return;
   if(data.status==="ready"&&data.allowedCount>0){
    setPreflight(data);
    setFlow(current=>current.targetId===targetId?preflightReady(current):current);
    return;
   }
   setFlow(current=>current.targetId===targetId?preflightConflict(current,conflictNotice(data)):current);
  }catch(error){
   if(seq!==checkSeq.current)return;
   setFlow(current=>current.targetId===targetId?preflightConflict(current,errorCode(error)==="E_NOT_FOUND"?"目标目录不存在或不可见":"检查失败，请重试"):current);
  }
 },[file.id]);

 useEffect(()=>{
  if(tree!=="ready"||needsRefresh||!flow.targetId)return;
  const candidate=folders.find(folder=>folder.id===flow.targetId);
  if(!candidate||fileMoveInvalidTarget(candidate,file,folders))return;
  void check(flow.targetId);
  return()=>{checkSeq.current+=1;};
 },[tree,folders,flow.targetId,needsRefresh,check,file]);

 async function submit(){
  if(!canConfirm)return;
  const targetId=flow.targetId;
  checkSeq.current+=1;
  setFlow(current=>submitStarted(current));
  try{
   const result=await fileApi.move(file.id,targetId,file.folderId,newIdempotencyKey());
   if(result.status!=="committed"){
    setPreflight(null);
    setNeedsRefresh(true);
    setFlow(current=>failed(current,"移动结果未确认，请刷新查看状态"));
    return;
   }
   setFlow(current=>succeeded(current,result));
   onMoved(file);
  }catch(error){
   setPreflight(null);
   const code=errorCode(error);
   if(code==="E_VERSION_CONFLICT"){
    // The CAS basis names a folder the file has already left, so an in-place
    // retry can only repeat the rejection: reload the list and let the user
    // restart the flow from the refreshed row (WF-15).
    setNeedsRefresh(true);
    setFlow(current=>failed(current,"文件已被其他人移动或修改，请刷新后重试"));
    onReload();
    return;
   }
   if(code==="E_NETWORK"){
    // The request never completed, so the outcome is unknown: never report
    // success or failure — only the refreshed list tells the truth.
    setNeedsRefresh(true);
    setFlow(current=>failed(current,"网络中断，无法确认是否已移动，请刷新查看状态"));
    return;
   }
   if(code==="E_NAME_CONFLICT"){setFlow(current=>failed(current,"目标目录已存在同名文件，请更改目标"));return;}
   if(code==="E_MOVE_CONFLICT"){setFlow(current=>failed(current,"文件已在该目录"));return;}
   if(code==="E_FORBIDDEN"){setFlow(current=>failed(current,"没有权限移动到该目录"));return;}
   setFlow(current=>failed(current,"移动失败，请重试"));
  }
 }

 return <Dialog open title={dialogTitle} onClose={close} closeGuard={()=>!busy} className="move-file-dialog">
  {tree==="loading"&&<p className="empty"><BrandLoadingLabel>正在读取目录…</BrandLoadingLabel></p>}
  {tree==="failed"&&<>
   <p role="alert" className="notice error">获取目录失败，请稍后重试。</p>
   <div className="dialog-actions">
    <RareButton type="button" className="secondary-action" onClick={close} disabled={busy}>取消</RareButton>
    <RareButton type="button" className="secondary-action" onClick={()=>setTreeToken(token=>token+1)} disabled={busy}>重试</RareButton>
   </div>
  </>}
  {tree==="ready"&&<FolderPicker
   open
   title={dialogTitle}
   folders={folders}
   selectedId={flow.targetId}
   onSelect={choose}
   onClose={close}
   invalidTarget={folder=>fileMoveInvalidTarget(folder,file,folders)}
   notice={flow.notice}
   busy={busy}
   footer={needsRefresh
    ?<RareButton type="button" className="secondary-action" onClick={()=>{onReload();onClose();}} disabled={busy}>刷新查看状态</RareButton>
    :<>
     <RareButton type="button" className="secondary-action" onClick={close} disabled={busy}>取消</RareButton>
     {flow.state==="conflict"&&flow.notice==="检查失败，请重试"&&<RareButton type="button" className="secondary-action" onClick={()=>void check(flow.targetId)} disabled={!canCheck}>重试检查</RareButton>}
     <RareButton type="button" className="primary" onClick={submit} disabled={!canConfirm}>{flow.state==="validating"?"检查中…":flow.state==="submitting"?"移动中…":"确认移动"}</RareButton>
    </>}
  />}
 </Dialog>;
}

// Batch move (WF-07/WF-08, ADR-UX-02). The whole selection goes to one
// all-or-nothing transaction: there is no preflight step (the commit
// re-verifies everything anyway) and a conflict answer wrote nothing, so the
// dialog stays open with the per-item list and lets the user exclude the
// problem files and submit the remainder. An unknown outcome offers only a
// re-read — it never claims the move happened or that it did not.
function BatchMoveDialog({files,presetTargetId,onClose,onMoved,onReload}:{
 files:FileItem[];
 // The folder a drop preselected; "" means the menu entry opened this dialog.
 // It only seeds the candidate — the all-or-nothing commit below is unchanged.
 presetTargetId:string;
 onClose:()=>void;
 onMoved:(movedIds:string[])=>void;
 onReload:()=>void;
}){
 const[folders,setFolders]=useState<Folder[]>([]);
 const[tree,setTree]=useState<"loading"|"ready"|"failed">("loading");
 const[treeToken,setTreeToken]=useState(0);
 const[flow,setFlow]=useState<BatchMoveFlow>(()=>presetTargetId===""?openBatch():batchPickTarget(openBatch(),presetTargetId));
 // The pending set is the live scope of the submission; only the explicit
 // exclude-and-retry step narrows it, never the dialog on its own.
 const[pendingIds,setPendingIds]=useState<string[]>(()=>files.map(file=>file.id));
 const[needsRefresh,setNeedsRefresh]=useState(false);

 useEffect(()=>{
  let valid=true;
  setTree("loading");
  // Read through the shared JSON client, as RestoreDialog does, so this
  // feature stays independent of the folders module.
  request<Folder[]>("/folders/tree")
   .then(data=>{if(!valid)return;setFolders(data);setTree("ready");})
   .catch(()=>{if(valid)setTree("failed");});
  return()=>{valid=false;};
 },[treeToken]);

 const dialogTitle=`移动 ${pendingIds.length} 个文件`;
 const busy=flow.state==="submitting";
 const selected=folders.find(folder=>folder.id===flow.targetId)??null;
 const invalid=selected?batchMoveInvalidTarget(selected,files,folders):null;
 const canSubmit=tree==="ready"&&!busy&&!needsRefresh&&flow.state==="candidate"&&selected!==null&&invalid===null&&pendingIds.length>0;
 const conflictIds=new Set(flow.conflicts.map(conflict=>conflict.id));
 const nameOf=new Map(files.map(file=>[file.id,file.name]));

 function close(){
  if(busy)return;
  onClose();
 }

 function choose(targetId:string){
  // A new candidate voids the previous conflict list; the picker is
  // busy-locked while a submission is in flight, so no stale answer survives.
  setFlow(current=>batchPickTarget(current,targetId));
 }

 // ADR-UX-02 exclude-and-retry: drop exactly the conflicting items from the
 // pending set and return to the candidate step, where the remainder can be
 // submitted again. Nothing is dropped without the user asking for it.
 function excludeConflicts(){
  if(flow.state!=="conflict"||pendingIds.length===0)return;
  const remaining=pendingIds.filter(id=>!conflictIds.has(id));
  setPendingIds(remaining);
  if(remaining.length===0)return;
  setFlow(current=>batchExcluded(current,`已排除 ${pendingIds.length-remaining.length} 个问题文件，可提交剩余 ${remaining.length} 个`));
 }

 async function submit(){
  if(!canSubmit)return;
  const targetId=flow.targetId;
  setFlow(current=>batchSubmitStarted(current));
  try{
   const data=await fileApi.moveBatch(pendingIds,targetId,newIdempotencyKey());
   if(data.status==="committed"){
    setFlow(current=>batchSucceeded(current,data.moved));
    onMoved(data.moved.map(item=>item.fileId));
    return;
   }
   if(data.conflicts.length>0){
    setFlow(current=>batchConflict(current,data.conflicts));
    return;
   }
   // Neither a commit nor an itemised conflict: the outcome is not something
   // this dialog may read as success.
   setNeedsRefresh(true);
   setFlow(current=>batchFailed(current,"移动结果未确认，请刷新查看状态"));
  }catch(error){
   const code=errorCode(error);
   if(code==="E_NETWORK"){
    // The request never completed, so the outcome is unknown: never report
    // success or failure — only the refreshed list tells the truth.
    setNeedsRefresh(true);
    setFlow(current=>batchFailed(current,"网络中断，无法确认是否已移动，请刷新查看状态"));
    return;
   }
   if(code==="E_FORBIDDEN"){setFlow(current=>batchFailed(current,"没有权限移动所选文件，请更换目标或确认权限"));return;}
   if(code==="E_BAD"){setFlow(current=>batchFailed(current,"所选文件超出单次移动上限，请分批选择后重试"));return;}
   if(code==="E_NOT_FOUND"){setFlow(current=>batchFailed(current,"目标目录不存在或已不可见，请刷新后重试"));return;}
   if(code==="E_NAME_CONFLICT"){setFlow(current=>batchFailed(current,"目标目录已存在同名文件，请更改目标"));return;}
   setFlow(current=>batchFailed(current,"移动失败，请重试"));
  }
 }

 return <Dialog open title={dialogTitle} onClose={close} closeGuard={()=>!busy} className="move-file-dialog">
  {tree==="loading"&&<p className="empty"><BrandLoadingLabel>正在读取目录…</BrandLoadingLabel></p>}
  {tree==="failed"&&<>
   <p role="alert" className="notice error">获取目录失败，请稍后重试。</p>
   <div className="dialog-actions">
    <RareButton type="button" className="secondary-action" onClick={close} disabled={busy}>取消</RareButton>
    <RareButton type="button" className="secondary-action" onClick={()=>setTreeToken(token=>token+1)} disabled={busy}>重试</RareButton>
   </div>
  </>}
  {tree==="ready"&&<FolderPicker
   open
   title={dialogTitle}
   folders={folders}
   selectedId={flow.targetId}
   onSelect={choose}
   onClose={close}
   invalidTarget={folder=>batchMoveInvalidTarget(folder,files,folders)}
   notice={flow.notice}
   busy={busy}
   detail={flow.state==="conflict"?<>
    {pendingIds.length>0&&<>
     <p className="hint" role="status">以下 {flow.conflicts.length} 个文件无法移动，本次没有移动任何文件：</p>
     <ul className="delete-list" style={{maxHeight:"160px",overflow:"auto"}}>
      {flow.conflicts.map(conflict=><li key={conflict.id}>{nameOf.get(conflict.id)??conflict.id}：{conflictItemCopy(conflict)}</li>)}
     </ul>
    </>}
    {flow.state==="conflict"&&pendingIds.length===0&&
     <p className="hint" role="status">已排除全部问题文件，没有可提交的项。请关闭后重新选择要移动的文件。</p>}
   </>:undefined}
   footer={needsRefresh
    ?<RareButton type="button" className="secondary-action" onClick={()=>{onReload();onClose();}} disabled={busy}>刷新查看状态</RareButton>
    :<>
     <RareButton type="button" className="secondary-action" onClick={close} disabled={busy}>取消</RareButton>
     {flow.state==="conflict"&&pendingIds.length>0&&
      <RareButton type="button" className="secondary-action" onClick={excludeConflicts} disabled={busy}>排除问题项并重试</RareButton>}
     <RareButton type="button" className="primary" onClick={submit} disabled={!canSubmit}>{busy?"移动中…":"确认移动"}</RareButton>
    </>}
  />}
 </Dialog>;
}
