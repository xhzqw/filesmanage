import {useEffect,useRef,useState,type ChangeEvent,type DragEvent,type FormEvent,type KeyboardEvent,type MouseEvent}from "react";
import {useNavigate}from "react-router-dom";
import type {FileItem} from "../../entities/file/model";
import type {Folder} from "../../entities/folder/model";
import {fileApi,formatSize} from "./api";
import {useUploadStore} from "./uploadStore";
import {batchConflict,batchExcluded,batchFailed,batchMoveInvalidTarget,batchPickTarget,batchSubmitStarted,batchSucceeded,failed,fileMoveInvalidTarget,openBatch,openFlow,pickTarget,preflightConflict,preflightReady,preflightStarted,submitStarted,succeeded,type BatchMoveFlow,type MoveFlow,type MovePreflight}from"./moveFileFlow";
import {errorCode,errorCopy} from "../../shared/errors";
import {request} from "../../shared/http";
import {newIdempotencyKey} from "../../shared/ids";
import {Dialog} from "../../shared/ui/Dialog";
import {FolderPicker} from "../../shared/ui/FolderPicker";
import {Menu,type MenuItem,type MenuPoint}from"../../shared/ui/Menu";
import"./dragMove.css";
import"./fileTable.css";

type SortKey="updated_desc"|"name_asc"|"name_desc"|"size_desc";

const SORT_LABELS:Record<SortKey,string>={
 updated_desc:"最近修改",
 name_asc:"名称 A→Z",
 name_desc:"名称 Z→A",
 size_desc:"大小降序",
};

const SORT_KEYS:SortKey[]=["updated_desc","name_asc","name_desc","size_desc"];

// Extension classes for the type icon: CAD geometry, raster images and the
// document/text family the workbench edits or previews.
const CAD_EXT=new Set(["dwg","dxf","stl","step","stp","iges","igs","obj","3mf"]);
const IMAGE_EXT=/^(png|jpe?g|gif|webp|bmp|tiff?)$/;
const DOC_EXT=/^(pdf|docx?|xlsx?|pptx?|md|txt|csv|json|xml|ya?ml|log)$/;

// Spec §4.1: a 14px thin-line type icon ahead of the name. The extension picks
// the glyph - CAD drawing, raster image, document, generic file - and the icon
// is always currentColor and aria-hidden, so it never carries meaning the name
// does not and never enters the accessibility tree (VIS-11).
function FileTypeIcon({name}:{name:string}){
 const dot=name.lastIndexOf(".");
 const ext=dot>0&&dot<name.length-1?name.slice(dot+1).toLowerCase():"";
 const kind=CAD_EXT.has(ext)?"cad":IMAGE_EXT.test(ext)?"image":DOC_EXT.test(ext)?"doc":"file";
 return <svg className="file-type-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
  {kind==="cad"?<><path d="M3 8.6V6.4l2.2-2.2h4.2l2.2 2.2h7.2v10.4H3z"/><path d="M7 13.6l2.6-3.1 2 2.3 2-2.5 3.4 3.3"/></>:null}
  {kind==="image"?<><rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M4.6 17.2l4.4-4.4 3 3 3-2.6 4.4 4.2"/></>:null}
  {kind==="doc"?<><path d="M6.6 3.6h6.4l4.4 4.4v12.4H6.6z"/><path d="M13 3.6v4.4h4.4"/></>:null}
  {kind==="file"?<><path d="M6.6 3.6h6.4l4.4 4.4v12.4H6.6z"/></>:null}
 </svg>;
}

// VIS-05 row density (Precision Workbench 2.0 §1.1/§3.1): a pure presentation
// choice persisted per browser so it survives navigation. The switch only
// swaps a class on the table below — the selection, sort, keyboard model and
// loaded pages are untouched in both modes.
type Density="default"|"compact";

const DENSITY_KEY="filesmanage.file-density";

function readDensity():Density{
 try{return localStorage.getItem(DENSITY_KEY)==="compact"?"compact":"default";}
 catch{return "default";}   // blocked storage (private mode) must not blank the page
}

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
export function FileTable({folder,folderName,onEdit,reloadKey}:{folder:string;folderName:string;onEdit:(fileId:string)=>void;reloadKey:number}){
 const[items,setItems]=useState<FileItem[]>([]);
// Round-trip of the list read the status bar reports (spec §3.1). It is an
// observation of the request that already runs below — never an extra one —
// so a failed read shows "—" instead of a stale number.
const[latencyMs,setLatencyMs]=useState<number|null>(null);
 const[status,setStatus]=useState("loading");
 const[message,setMessage]=useState("");
 const[messageTone,setMessageTone]=useState<"info"|"error">("info");
 const[sort,setSort]=useState<SortKey>("updated_desc");
 const[density,setDensity]=useState<Density>(readDensity);
 const[cursor,setCursor]=useState("");
 const[hasMore,setHasMore]=useState(false);
 const[renaming,setRenaming]=useState<FileItem|null>(null);
 const[renameValue,setRenameValue]=useState("");
 const[renameBusy,setRenameBusy]=useState(false);
 const[selectedIds,setSelectedIds]=useState<Set<string>>(()=>new Set<string>());
 const[focusedId,setFocusedId]=useState<string|null>(null);
 const[anchorId,setAnchorId]=useState<string|null>(null);
 const[pendingDelete,setPendingDelete]=useState<FileItem[]>([]);
 // Transient context-menu state (DESKTOP-INTERACTION §1.1 contextTarget): it
 // lives only while the row menu is open and is never business state.
 const[rowMenu,setRowMenu]=useState<{targets:FileItem[];point:MenuPoint|null;anchor:HTMLElement|null}|null>(null);
 const[deleteBusy,setDeleteBusy]=useState(false);
 // WF-01: the file being moved through the single-file CAS endpoint.
 const[moving,setMoving]=useState<FileItem|null>(null);
 // WF-07/WF-08/ADR-UX-02: the multi-selection being moved through the
 // all-or-nothing batch endpoint — the snapshot the row menu opened on.
 const[movingBatch,setMovingBatch]=useState<FileItem[]|null>(null);
 // The live internal-move drag session (§7.2) plus the rows it came from, only
 // so the source rows can dim while the gesture is in flight.
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
 const enqueueFiles=useUploadStore(state=>state.enqueueFiles);
 const navigate=useNavigate();

 useEffect(()=>{
  let valid=true;
  setStatus("loading");
  const started=performance.now();
  fileApi.list(folder,sort,"",50)
   .then(page=>{
    if(!valid)return;
    setItems(page.items);
    setHasMore(page.nextCursor!=="");
    setCursor(page.nextCursor);
    setStatus("ready");
    setLatencyMs(Math.max(0,Math.round(performance.now()-started)));
   })
   .catch(()=>{if(valid){setStatus("failed");setLatencyMs(null);}});
  return()=>{valid=false;};
 },[folder,sort,reloadKey]);

 // A directory, sort or reload change is a new order revision: the previous
 // selection, anchor and focus describe a list that no longer exists.
 useEffect(()=>{
  setSelectedIds(new Set<string>());
  setFocusedId(null);
  setAnchorId(null);
  setRowMenu(null);
 },[folder,sort,reloadKey]);

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

 function announce(text:string,tone:"info"|"error"){
  setMessage(text);
  setMessageTone(tone);
 }

 // VIS-05: the switch only swaps a class on the table below — the selection,
 // sort, keyboard model and loaded pages are untouched.
 function chooseDensity(next:Density){
  setDensity(next);
  localStorage.setItem(DENSITY_KEY,next);
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
   announce(on?`已关注：${file.name}`:`已取消关注：${file.name}`,"info");
  }catch(error){
   setFavoriteIds(prev=>{
    const next=new Set(prev);
    if(on)next.delete(file.id);else next.add(file.id);
    return next;
   });
   announce(errorCopy(error,on?"关注失败，请重试":"取消关注失败，请重试"),"error");
  }finally{
   setFavoriteBusy("");
  }
 }

 async function reload(){
  const page=await fileApi.list(folder,sort,"",50);
  setItems(page.items);setHasMore(page.nextCursor!=="");setCursor(page.nextCursor);
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
  announce(`已加入上传队列：${files.length} 个文件`,"info");
 }

 async function loadMore(){
  if(!cursor)return;
  const page=await fileApi.list(folder,sort,cursor,50);
  setItems(prev=>[...prev,...page.items]);
  setCursor(page.nextCursor);
  setHasMore(page.nextCursor!=="");
 }

 function visibleRange(fromId:string,toId:string):string[]{
  const from=items.findIndex(i=>i.id===fromId);
  const to=items.findIndex(i=>i.id===toId);
  if(from<0||to<0)return[toId];
  const low=Math.min(from,to);
  const high=Math.max(from,to);
  return items.slice(low,high+1).map(i=>i.id);
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
  setSelectedIds(new Set(items.map(i=>i.id)));
  setAnchorId(items[0]?.id??null);
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
  dataTransfer.setData("text/plain",`移动 ${ids.length} 个文件`);
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
  if(items.length===0)return;
  const next=Math.max(0,Math.min(items.length-1,index));
  const target=items[next];
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
  if(items.length===0)return;
  const index=focusedId?items.findIndex(i=>i.id===focusedId):-1;
  const current=index>=0?items[index]:null;
  switch(event.key){
   case "ArrowDown":
    event.preventDefault();moveFocus(index+1,event.shiftKey);break;
   case "ArrowUp":
    event.preventDefault();moveFocus(index-1,event.shiftKey);break;
   case "Home":
    event.preventDefault();moveFocus(0,event.shiftKey);break;
   case "End":
    event.preventDefault();moveFocus(items.length-1,event.shiftKey);break;
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
    setPendingDelete(items.filter(i=>selectedIds.has(i.id)));
    break;
   case "F2":
    if(selectedIds.size!==1)return;
    event.preventDefault();
    {const only=items.find(i=>selectedIds.has(i.id));if(only){setRenaming(only);setRenameValue(only.name);}}
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
     setSelectedIds(new Set(items.map(i=>i.id)));
    }
  }
 }

 function openRowMenu(item:FileItem){
  const row=document.querySelector<HTMLTableRowElement>(`tbody tr[data-id="${item.id}"]`);
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
   items.push({id:"rename",label:"重命名",hint:"F2",onSelect:()=>{setRenaming(file);setRenameValue(file.name);}});
   items.push({id:"move",label:"移动到…",onSelect:()=>startMove(file)});
   items.push({id:"download",label:"下载",onSelect:()=>startDownload(file)});
  }else if(targets.length>1){
   items.push({id:"move-batch",label:"移动到…",onSelect:()=>startMoveSelection(targets)});
  }
  items.push({id:"delete",label:"删除",hint:"Delete",danger:true,onSelect:()=>setPendingDelete(targets)});
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

 async function submitRename(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(!renaming||renameBusy)return;
  announce("","info");
  setRenameBusy(true);
  try{
   const updated=await fileApi.rename(renaming.id,renameValue);
   setItems(prev=>prev.map(f=>f.id===updated.id?updated:f));
   setRenaming(null);
   announce("重命名成功","info");
  }catch(error){
   announce(errorCode(error)==="E_NAME_CONFLICT"?"目标名称已存在":"重命名失败：名称冲突或无权操作","error");
  }finally{setRenameBusy(false);}
 }

 // Deletion runs per item: the API has no batch endpoint, so each result is
 // reported individually and a partial failure never claims full success.
 async function confirmDelete(){
  const targets=pendingDelete;
  if(targets.length===0||deleteBusy)return;
  setDeleteBusy(true);
  const failed:string[]=[];
  for(const target of targets){
   try{await fileApi.remove(target.id);}catch{failed.push(target.name);}
  }
  setDeleteBusy(false);
  setPendingDelete([]);
  setSelectedIds(prev=>{
   const next=new Set(prev);
   for(const target of targets)next.delete(target.id);
   return next;
  });
  const removed=targets.filter(t=>!failed.includes(t.name)).map(t=>t.name);
  if(removed.length>0)announce(`已移入回收站：${removed.join("、")}`,"info");
  if(failed.length>0)announce(`删除失败：${failed.join("、")}，请重试`,"error");
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

 const selection=items.filter(i=>selectedIds.has(i.id));
 const selectedBytes=selection.reduce((sum,file)=>sum+file.sizeBytes,0);
 const allLoadedSelected=items.length>0&&items.every(i=>selectedIds.has(i.id));

 // The work area is not a move target: an internal drag over it is a cancel
 // ("拖回来源", §7.2) and it must not light up the upload zone either, so its
 // drag events are stopped before the DropZone sees them. External file drags
 // are untouched and keep bubbling (DI-17: upload intent stays with §7.1).
 return <div className="work-body"
  onDragEnter={suppressInternalDrag}
  onDragOver={suppressInternalDrag}
  onDragLeave={suppressInternalDrag}
  onDrop={suppressInternalDrag}>
  <div className="toolbar">
   {/* Order matters: VIS-03 focuses the sort select and presses Tab once,
       expecting the first grid row. Every tabbable control therefore sits
       ahead of the select (and the header select-all box is tabIndex -1,
       with Ctrl+A covering the same action), so that Tab still lands there. */}
   <span className="density-switch" role="group" aria-label="行密度">
    <span className="density-title">密度</span>
    <button type="button" aria-pressed={density==="default"} onClick={()=>chooseDensity("default")}>标准</button>
    <button type="button" aria-pressed={density==="compact"} onClick={()=>chooseDensity("compact")}>超紧凑</button>
   </span>
   {/* The input allows multiple files: it feeds the same batch queue as a
       drop (WF-27), so it no longer locks while one upload is in flight. */}
   <label className="upload-button">
    上传文件
    <input type="file" multiple onChange={onUpload}/>
   </label>
   <label className="sort-label">排序
    <select aria-label="排序方式" value={sort} onChange={e=>setSort(e.target.value as SortKey)}>
     {SORT_KEYS.map(key=><option key={key} value={key}>{SORT_LABELS[key]}</option>)}
    </select>
   </label>
   <span className="toolbar-hint">{folderName}</span>
  </div>
  {selectedIds.size>0&&<div className="toolbar selection-bar" role="status">
   <span className="toolbar-hint">已选择 {selectedIds.size} 项（当前加载页）</span>
   <button type="button" onClick={()=>startMoveSelection(selection)}>移动到…</button>
   <button type="button" className="danger" onClick={()=>setPendingDelete(selection)}>删除所选</button>
   <button type="button" className="secondary-action" onClick={()=>{setSelectedIds(new Set<string>());setAnchorId(null);}}>取消选择</button>
  </div>}
  {message&&<p role="status" className={"notice "+messageTone}>{message}</p>}
  <div className="table" onClick={event=>{if(!(event.target as HTMLElement).closest("tr")){setSelectedIds(new Set<string>());setAnchorId(null);}}}>
   <table role="grid" aria-label={folderName+" 文件列表"} className={"file-table"+(density==="compact"?" file-table-ultra":"")}>
    <colgroup><col className="col-select"/><col className="col-name"/><col className="col-size"/><col className="col-version"/><col className="col-hash"/><col className="col-date"/><col className="col-actions"/></colgroup>
    <thead><tr>
     <th className="col-select" scope="col"><input type="checkbox" tabIndex={-1} checked={allLoadedSelected} onChange={toggleSelectAllLoaded} aria-label="选择当前已加载的文件"/></th>
     <th className="col-name" scope="col">文件名</th>
     <th className="col-size" scope="col">大小</th>
     <th className="col-version" scope="col">版本</th>
     <th className="col-hash" scope="col">校验值</th>
     <th className="col-date" scope="col">修改日期</th>
     <th className="col-actions" scope="col">操作</th>
    </tr></thead>
    <tbody onKeyDown={onGridKeyDown}>
     {status==="loading"&&<tr><td colSpan={7} className="empty">正在加载文件…</td></tr>}
     {status==="failed"&&<tr><td colSpan={7} className="empty" role="alert">获取文件失败，请刷新重试</td></tr>}
     {status==="ready"&&items.length===0&&<tr><td colSpan={7} className="empty">
      <svg className="empty-mark" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h8A1.5 1.5 0 0 1 20 10v7.5A1.5 1.5 0 0 1 18.5 19h-14A1.5 1.5 0 0 1 3 17.5z"/></svg>
      <span className="empty-title">目录为空</span>
      <span className="empty-hint">上传第一个文件开始使用。</span>
     </td></tr>}
     {status==="ready"&&items.map((item,index)=><tr key={item.id} data-id={item.id}
      tabIndex={focusedId===item.id||(focusedId===null&&index===0)?0:-1}
      aria-selected={selectedIds.has(item.id)}
      className={(selectedIds.has(item.id)?"selected":"")+(focusedId===item.id?" focused":"")+(draggingIds.has(item.id)?" drag-source":"")}
      draggable
      onClick={event=>onRowClick(event,item)}
      onContextMenu={event=>onRowContextMenu(event,item)}
      onDoubleClick={()=>navigate("/preview/"+item.id)}
      onDragStart={event=>onRowDragStart(event,item)}
      onDragEnd={onRowDragEnd}>
      <td className="col-select"><input type="checkbox" checked={selectedIds.has(item.id)} aria-label={"选择 "+item.name} onClick={event=>event.stopPropagation()} onChange={event=>onCheckToggle(event,item)}/></td>
      <td className="col-name"><FileTypeIcon name={item.name}/><span className="file-name" title={item.name}>{item.name}</span></td>
      <td className="col-size num">{formatSize(item.sizeBytes)}</td>
      <td className="col-version"><span className="version-badge">v{item.currentVersionSeq}</span></td>
      <td className="col-hash hash" title={item.sha256}>{item.sha256.slice(0,8)}</td>
      <td className="col-date date">{item.updatedAt.replace("T"," ").slice(0,16)}</td>
      <td className="row-actions col-actions" onClick={event=>event.stopPropagation()}>
       <button type="button" onClick={()=>navigate("/preview/"+item.id)}>打开</button>
       <a href={"/api/files/"+item.id+"/bytes"} download={item.name}>下载</a>
       <button type="button" onClick={()=>onEdit(item.id)}>编辑</button>
       <button type="button" onClick={()=>{setRenaming(item);setRenameValue(item.name);}}>重命名</button>
       <button type="button" className="danger" onClick={()=>setPendingDelete([item])}>删除</button>
       <button type="button" aria-pressed={favoriteIds.has(item.id)}
        disabled={favoritesState!=="ready"||favoriteBusy!==""}
        title={favoritesState==="failed"?"关注状态加载失败，请刷新后重试":undefined}
        onClick={()=>toggleFavorite(item)}>{favoriteIds.has(item.id)?"已关注":"关注"}</button>
      </td>
     </tr>)}
    </tbody>
   </table>
  </div>
  {hasMore&&<button type="button" className="secondary-action" onClick={loadMore}>加载更多</button>}
  {renaming&&<Dialog open title="重命名文件" onClose={()=>setRenaming(null)} closeGuard={()=>!renameBusy} className="dialog">
   <form onSubmit={submitRename}>
    <label htmlFor="rename-input">新名称</label>
    <input id="rename-input" value={renameValue} maxLength={200} onChange={e=>setRenameValue(e.target.value)} required disabled={renameBusy}/>
    <div className="dialog-actions">
     <button type="button" className="secondary-action" onClick={()=>setRenaming(null)} disabled={renameBusy}>取消</button>
     <button type="submit" className="primary" disabled={renameBusy}>{renameBusy?"保存中…":"保存"}</button>
    </div>
   </form>
  </Dialog>}
  {pendingDelete.length>0&&<Dialog open title="删除确认" onClose={()=>setPendingDelete([])} closeGuard={()=>!deleteBusy} className="dialog">
   <form onSubmit={event=>{event.preventDefault();confirmDelete();}}>
    <p className="hint">以下资源将进入回收站，可恢复。此操作可按服务端规则撤销。</p>
    <ul className="delete-list">
     {pendingDelete.slice(0,8).map(item=><li key={item.id}>{item.name}</li>)}
     {pendingDelete.length>8&&<li>…等共 {pendingDelete.length} 项</li>}
    </ul>
    <div className="dialog-actions">
     <button type="button" className="secondary-action" onClick={()=>setPendingDelete([])} disabled={deleteBusy}>取消</button>
     <button type="submit" className="danger" disabled={deleteBusy}>{deleteBusy?"删除中…":"确认删除"}</button>
    </div>
   </form>
  </Dialog>}
  {moving&&<MoveDialog file={moving} presetTargetId={moveDropTarget} onClose={()=>{setMoveDropTarget("");setMoving(null);}} onMoved={onMoved} onReload={onMoveReload}/>}
  {movingBatch&&<BatchMoveDialog files={movingBatch} presetTargetId={moveDropTarget} onClose={()=>{setMoveDropTarget("");setMovingBatch(null);}} onMoved={onBatchMoved} onReload={onMoveReload}/>}
  {rowMenu&&<Menu open label="文件操作菜单" items={rowMenuItems(rowMenu.targets)} anchor={rowMenu.anchor}
   point={rowMenu.point} onClose={()=>setRowMenu(null)}/>}
  <footer className="status-bar">
   <span>已选 <span className="status-strong">{selectedIds.size}</span> 项{selectedIds.size>0&&<> / <span className="status-strong">{formatSize(selectedBytes)}</span></>}</span>
   <span className="status-sep" aria-hidden="true">│</span>
   <span>共 <span className="status-strong">{items.length}</span> 个项目</span>
   <span className="status-sep" aria-hidden="true">│</span>
   <span>延迟 <span className="status-strong">{latencyMs===null?"—":latencyMs+" ms"}</span></span>
   <span className="status-spacer"/>
   <span className="status-build">filesmanage v2.1.0</span>
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

// Visible-ancestor path only: a folder outside the loaded tree is never
// invented, matching how the server filters its preflight summaries.
function pathOf(folders:Folder[],id:string):string{
 const byId=new Map(folders.map(folder=>[folder.id,folder]));
 const names:string[]=[];
 const seen=new Set<string>();
 let current=byId.get(id);
 while(current&&!seen.has(current.id)){
  seen.add(current.id);
  names.unshift(current.name);
  const parentId=current.parentId;
  current=parentId!==null?byId.get(parentId):undefined;
 }
 return names.join(" / ");
}

// Single-file move (COMPLEX-WORKFLOWS-v1 §2-§3, WF-01..WF-06/WF-09). The dialog
// hosts the shared FolderPicker: a click only sets a candidate, "检查并继续"
// runs the read-only server preflight, and only a preflight for the candidate
// currently shown unlocks "确认移动". The server stays the authority — the
// commit re-verifies permissions, the target's active state, name uniqueness
// and the CAS folder.
function MoveDialog({file,presetTargetId,onClose,onMoved,onReload}:{
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

 // How the dialog was opened is cosmetic (§7.2): a drop preselects a candidate
 // and says so, but it takes the same check-then-confirm path below.
 const viaDrop=presetTargetId!=="";
 const dialogTitle=viaDrop?"拖放移动到…":"移动到…";
 const busy=flow.state==="validating"||flow.state==="submitting";
 const selected=folders.find(folder=>folder.id===flow.targetId)??null;
 const invalid=selected?fileMoveInvalidTarget(selected,file,folders):null;
 const canCheck=tree==="ready"&&!busy&&!needsRefresh&&selected!==null&&invalid===null;
 const canConfirm=canCheck&&flow.state==="ready"&&preflight!==null;
 const sourcePath=pathOf(folders,file.folderId);
 const targetPath=flow.targetId!==""?pathOf(folders,flow.targetId):"";

 function close(){
  if(busy)return;
  onClose();
 }

 function choose(targetId:string){
  // A new candidate voids the previous preflight and any answer still in
  // flight: confirm stays disabled until this target is checked.
  checkSeq.current+=1;
  setPreflight(null);
  setFlow(current=>pickTarget(current,targetId));
 }

 async function check(){
  if(!canCheck)return;
  const targetId=flow.targetId;
  const seq=++checkSeq.current;
  setPreflight(null);
  setFlow(current=>preflightStarted(current));
  try{
   const data=await request<MovePreflight>("/moves/preflight",{method:"POST",body:JSON.stringify({resources:[{kind:"file",id:file.id}],targetFolderId:targetId,mode:"all_or_nothing"})});
   if(seq!==checkSeq.current)return;
   if(data.status==="ready"&&data.allowedCount>0){
    setPreflight(data);
    setFlow(current=>preflightReady(current));
    return;
   }
   // Conflict or forbidden: the user stays on the candidate step and may pick
   // another target; nothing was submitted.
   setFlow(current=>preflightConflict(current,conflictNotice(data)));
  }catch(error){
   if(seq!==checkSeq.current)return;
   setFlow(current=>preflightConflict(current,errorCode(error)==="E_NOT_FOUND"?"目标目录不存在或不可见":"预检失败，请重试"));
  }
 }

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

 return <Dialog open title={dialogTitle} onClose={close} closeGuard={()=>!busy} className="dialog">
  {tree==="loading"&&<p className="empty">正在读取目录…</p>}
  {tree==="failed"&&<>
   <p role="alert" className="notice error">获取目录失败，请稍后重试。</p>
   <div className="dialog-actions">
    <button type="button" className="secondary-action" onClick={close} disabled={busy}>取消</button>
    <button type="button" className="secondary-action" onClick={()=>setTreeToken(token=>token+1)} disabled={busy}>重试</button>
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
   detail={<>
    <p className="hint">来源：{sourcePath||"当前目录"} · 目标：{targetPath||"未选择"}</p>
    {viaDrop&&<p className="hint">目标由拖放预选，仍需检查并确认后才会移动。</p>}
    {preflight?.warnings.map((warning,index)=><p className="hint" key={index}>{warning}</p>)}
   </>}
   footer={needsRefresh
    ?<button type="button" className="secondary-action" onClick={()=>{onReload();onClose();}} disabled={busy}>刷新查看状态</button>
    :<>
     <button type="button" className="secondary-action" onClick={close} disabled={busy}>取消</button>
     <button type="button" className="secondary-action" onClick={check} disabled={!canCheck}>{flow.state==="validating"?"检查中…":"检查并继续"}</button>
     <button type="button" className="primary" onClick={submit} disabled={!canConfirm}>{flow.state==="submitting"?"移动中…":"确认移动"}</button>
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

 // How the dialog was opened is cosmetic (§7.2): a drop preselects a candidate
 // and says so, but the confirmation below is unchanged.
 const viaDrop=presetTargetId!=="";
 const dialogTitle=pendingIds.length>0?(viaDrop?`拖放移动 ${pendingIds.length} 个文件到…`:`移动 ${pendingIds.length} 个文件到…`):"移动到…";
 const busy=flow.state==="submitting";
 const selected=folders.find(folder=>folder.id===flow.targetId)??null;
 const invalid=selected?batchMoveInvalidTarget(selected,files,folders):null;
 const canSubmit=tree==="ready"&&!busy&&!needsRefresh&&flow.state==="candidate"&&selected!==null&&invalid===null&&pendingIds.length>0;
 const conflictIds=new Set(flow.conflicts.map(conflict=>conflict.id));
 const nameOf=new Map(files.map(file=>[file.id,file.name]));
 const sourcePath=pathOf(folders,files[0]?.folderId??"");
 const targetPath=flow.targetId!==""?pathOf(folders,flow.targetId):"";

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

 return <Dialog open title={dialogTitle} onClose={close} closeGuard={()=>!busy} className="dialog">
  {tree==="loading"&&<p className="empty">正在读取目录…</p>}
  {tree==="failed"&&<>
   <p role="alert" className="notice error">获取目录失败，请稍后重试。</p>
   <div className="dialog-actions">
    <button type="button" className="secondary-action" onClick={close} disabled={busy}>取消</button>
    <button type="button" className="secondary-action" onClick={()=>setTreeToken(token=>token+1)} disabled={busy}>重试</button>
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
   detail={<>
    <p className="hint">来源：{sourcePath||"当前目录"} · 目标：{targetPath||"未选择"}{pendingIds.length>0?` · 本次将移动 ${pendingIds.length} 个文件`:" · 已无可提交的文件"}</p>
    {viaDrop&&<p className="hint">目标由拖放预选，仍需确认后提交；提交为整批事务。</p>}
    {flow.state==="conflict"&&pendingIds.length>0&&<>
     <p className="hint" role="status">以下 {flow.conflicts.length} 个文件无法移动，本次没有移动任何文件：</p>
     <ul className="delete-list" style={{maxHeight:"160px",overflow:"auto"}}>
      {flow.conflicts.map(conflict=><li key={conflict.id}>{nameOf.get(conflict.id)??conflict.id}：{conflictItemCopy(conflict)}</li>)}
     </ul>
    </>}
    {flow.state==="conflict"&&pendingIds.length===0&&
     <p className="hint" role="status">已排除全部问题文件，没有可提交的项。请关闭后重新选择要移动的文件。</p>}
   </>}
   footer={needsRefresh
    ?<button type="button" className="secondary-action" onClick={()=>{onReload();onClose();}} disabled={busy}>刷新查看状态</button>
    :<>
     <button type="button" className="secondary-action" onClick={close} disabled={busy}>取消</button>
     {flow.state==="conflict"&&pendingIds.length>0&&
      <button type="button" className="secondary-action" onClick={excludeConflicts} disabled={busy}>排除问题项并重试</button>}
     <button type="button" className="primary" onClick={submit} disabled={!canSubmit}>{busy?"移动中…":"确认移动"}</button>
    </>}
  />}
 </Dialog>;
}
