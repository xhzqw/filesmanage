import {useEffect,useRef,useState,type ChangeEvent,type FormEvent,type KeyboardEvent,type MouseEvent}from "react";
import {useNavigate}from "react-router-dom";
import type {FileItem} from "../../entities/file/model";
import type {Folder} from "../../entities/folder/model";
import {fileApi,formatSize,uploadFile} from "./api";
import {failed,fileMoveInvalidTarget,openFlow,pickTarget,preflightConflict,preflightReady,preflightStarted,submitStarted,succeeded,type MoveFlow,type MovePreflight}from"./moveFileFlow";
import {errorCode,errorCopy} from "../../shared/errors";
import {request} from "../../shared/http";
import {newIdempotencyKey} from "../../shared/ids";
import {Dialog} from "../../shared/ui/Dialog";
import {FolderPicker} from "../../shared/ui/FolderPicker";
import {Menu,type MenuItem,type MenuPoint}from"../../shared/ui/Menu";

type SortKey="updated_desc"|"name_asc"|"name_desc"|"size_desc";

const SORT_LABELS:Record<SortKey,string>={
 updated_desc:"最近修改",
 name_asc:"名称 A→Z",
 name_desc:"名称 Z→A",
 size_desc:"大小降序",
};

const SORT_KEYS:SortKey[]=["updated_desc","name_asc","name_desc","size_desc"];

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
 const[status,setStatus]=useState("loading");
 const[message,setMessage]=useState("");
 const[messageTone,setMessageTone]=useState<"info"|"error">("info");
 const[sort,setSort]=useState<SortKey>("updated_desc");
 const[cursor,setCursor]=useState("");
 const[hasMore,setHasMore]=useState(false);
 const[uploading,setUploading]=useState(false);
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
 // WF-01: the file being moved. Every move endpoint takes one id, so this is
 // single-selection like the other per-file actions.
 const[moving,setMoving]=useState<FileItem|null>(null);
 // WF-23: ids favorited by the caller, the load state of that list, and the row
 // whose toggle is in flight.
 const[favoriteIds,setFavoriteIds]=useState<Set<string>>(()=>new Set<string>());
 const[favoritesState,setFavoritesState]=useState<"loading"|"ready"|"failed">("loading");
 const[favoriteBusy,setFavoriteBusy]=useState("");
 const navigate=useNavigate();

 useEffect(()=>{
  let valid=true;
  setStatus("loading");
  fileApi.list(folder,sort,"",50)
   .then(page=>{
    if(!valid)return;
    setItems(page.items);
    setHasMore(page.nextCursor!=="");
    setCursor(page.nextCursor);
    setStatus("ready");
   })
   .catch(()=>{if(valid)setStatus("failed");});
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

 function announce(text:string,tone:"info"|"error"){
  setMessage(text);
  setMessageTone(tone);
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

 async function onUpload(event:ChangeEvent<HTMLInputElement>){
  const file=event.target.files?.[0];
  event.target.value="";
  if(!file)return;
  setUploading(true);announce("","info");
  try{
   await uploadFile(folder,file,newIdempotencyKey());
   await reload();
   announce(`已上传 ${file.name}，生成 v1 新版本`,"info");
  }catch(error){
   const code=errorCode(error);
   announce(code==="E_NAME_CONFLICT"?"同名文件已存在，请改名后上传":code==="E_FORBIDDEN"?"当前目录没有上传权限":"上传失败，请重试","error");
  }finally{setUploading(false);}
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

 function focusRow(id:string){
  const row=document.querySelector<HTMLTableRowElement>(`tbody tr[data-id="${id}"]`);
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
 // FileItem carries no permission or lock facts, so per-file actions stay
 // single-selection (every endpoint takes one id) and deletion keeps the
 // existing per-item confirmation with partial-failure reporting instead of
 // silently applying to part of a mixed-permission selection.
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

 function startMove(file:FileItem){
  setMoving(file);
 }

 // WF-09: a committed move changes this folder's content and the file's
 // authorization scope, so the source list reloads and the moved row leaves the
 // selection. The destination tree and inspector refresh on their next read.
 function onMoved(file:FileItem){
  setMoving(null);
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

 const selection=items.filter(i=>selectedIds.has(i.id));

 return <div className="work-body">
  <div className="toolbar">
   <label className="upload-button">
    {uploading?"上传中…":"上传文件"}
    <input type="file" onChange={onUpload} disabled={uploading}/>
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
   <button type="button" className="danger" onClick={()=>setPendingDelete(selection)}>删除所选</button>
   <button type="button" className="secondary-action" onClick={()=>{setSelectedIds(new Set<string>());setAnchorId(null);}}>取消选择</button>
  </div>}
  {message&&<p role="status" className={"notice "+messageTone}>{message}</p>}
  <div className="table" onClick={event=>{if(!(event.target as HTMLElement).closest("tr")){setSelectedIds(new Set<string>());setAnchorId(null);}}}>
   <table role="grid" aria-label={folderName+" 文件列表"}>
    <thead><tr><th>文件名</th><th>大小</th><th>版本</th><th>校验值</th><th>修改日期</th><th>操作</th></tr></thead>
    <tbody onKeyDown={onGridKeyDown}>
     {status==="loading"&&<tr><td colSpan={6} className="empty">正在加载文件…</td></tr>}
     {status==="failed"&&<tr><td colSpan={6} className="empty" role="alert">获取文件失败，请刷新重试</td></tr>}
     {status==="ready"&&items.length===0&&<tr><td colSpan={6} className="empty">目录为空。上传第一个文件开始使用。</td></tr>}
     {status==="ready"&&items.map((item,index)=><tr key={item.id} data-id={item.id}
      tabIndex={focusedId===item.id||(focusedId===null&&index===0)?0:-1}
      aria-selected={selectedIds.has(item.id)}
      className={(selectedIds.has(item.id)?"selected":"")+(focusedId===item.id?" focused":"")}
      onClick={event=>onRowClick(event,item)}
      onContextMenu={event=>onRowContextMenu(event,item)}
      onDoubleClick={()=>navigate("/preview/"+item.id)}>
      <td><span className="file-name" title={item.name}>{item.name}</span></td>
      <td>{formatSize(item.sizeBytes)}</td>
      <td>v{item.currentVersionSeq}</td>
      <td className="hash" title={item.sha256}>{item.sha256.slice(0,12)}…</td>
      <td>{item.updatedAt.replace("T"," ").slice(0,16)}</td>
      <td className="row-actions" onClick={event=>event.stopPropagation()}>
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
  {moving&&<MoveDialog file={moving} onClose={()=>setMoving(null)} onMoved={onMoved} onReload={onMoveReload}/>}
  {rowMenu&&<Menu open label="文件操作菜单" items={rowMenuItems(rowMenu.targets)} anchor={rowMenu.anchor}
   point={rowMenu.point} onClose={()=>setRowMenu(null)}/>}
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
function MoveDialog({file,onClose,onMoved,onReload}:{
 file:FileItem;
 onClose:()=>void;
 onMoved:(file:FileItem)=>void;
 onReload:()=>void;
}){
 const[folders,setFolders]=useState<Folder[]>([]);
 const[tree,setTree]=useState<"loading"|"ready"|"failed">("loading");
 const[treeToken,setTreeToken]=useState(0);
 const[flow,setFlow]=useState<MoveFlow>(openFlow);
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

 return <Dialog open title="移动到…" onClose={close} closeGuard={()=>!busy} className="dialog">
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
   title="移动到…"
   folders={folders}
   selectedId={flow.targetId}
   onSelect={choose}
   onClose={close}
   invalidTarget={folder=>fileMoveInvalidTarget(folder,file,folders)}
   notice={flow.notice}
   busy={busy}
   detail={<>
    <p className="hint">来源：{sourcePath||"当前目录"} · 目标：{targetPath||"未选择"}</p>
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
