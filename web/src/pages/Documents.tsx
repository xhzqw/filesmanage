import {RareButton} from "../shared/ui/rare";
import {BrandLoadingLabel} from "../shared/ui/BrandLoader";
import {observeResourceChange,observeWindowReturn} from "../shared/resourceSync";
import{useEffect,useLayoutEffect,useMemo,useRef,useState,type KeyboardEvent as ReactKeyboardEvent,type PointerEvent as ReactPointerEvent}from "react";
import{Link,useLocation,useNavigate}from "react-router-dom";
import type{User}from "../entities/user/model";
import type{Folder}from "../entities/folder/model";
import{folderApi}from "../features/folders/api";
import{ancestorPath}from "../features/folders/FolderTree";
import{FinderSidebar,type DocumentSection}from "../features/collaboration/FinderSidebar";
import{TagExplorer}from "../features/documents/TagExplorer";
import{CollaborationPanel}from "../features/collaboration/CollaborationPanel";
import{NewFolderForm}from "../features/folders/NewFolderForm";
import{FolderActions}from "../features/folders/FolderActions";
import{QuickGrantsDialog}from "../features/organization/QuickGrantsDialog";
import{folderMoveBusy,folderMoveCanSubmit,folderMoveFailure,folderMoveFailed,folderMoveIdle,folderMoveInvalidTarget,folderMovePickTarget,folderMoveSubmitStarted,type FolderMoveState}from "../features/folders/moveFolderFlow";
import{fileApi}from "../features/documents/api";
import{FileTable}from "../features/documents/FileTable";
import{DropZone}from "../features/documents/DropZone";
import type {DocumentUploadTarget} from "../features/documents/GlobalUploadDrop";
import{FileEditor}from "../features/documents/FileEditor";
import{workflowApi}from "../features/workflow/api";
import{AppShell}from "../shared/ui/AppShell";
import{Dialog}from "../shared/ui/Dialog";
import{FolderPicker}from "../shared/ui/FolderPicker";
import type {FileItem} from "../entities/file/model";
import type {ExplorerViewMode} from "../features/documents/explorerView";
import {EXPLORER_VIEWS,readExplorerViewMode,saveExplorerViewMode} from "../features/documents/explorerView";
import {ExplorerViewGlyph} from "../shared/ui/ExplorerView";
import "../features/documents/explorerChrome.css";

// The sidebar width is a user preference, not layout state (SPEC §3.1: 240px
// default, 180~360px draggable): read once per mount, written back on every
// change, so a reload lands on the width the user left behind. A value outside
// the range (an older build, a hand-edited store) is clamped, never trusted.
const SIDEBAR_WIDTH_KEY="filesmanage.sidebar-width";
const SIDEBAR_MIN=180;
const SIDEBAR_MAX=360;
const SIDEBAR_DEFAULT=240;

function clampSidebarWidth(width:number){
 return Math.min(SIDEBAR_MAX,Math.max(SIDEBAR_MIN,width));
}

function readSidebarWidth(){
 let width=SIDEBAR_DEFAULT;
 try{
  const stored=localStorage.getItem(SIDEBAR_WIDTH_KEY);
  const parsed=stored===null?NaN:parseInt(stored,10);
  if(!Number.isNaN(parsed))width=parsed;
 }catch{}
 return clampSidebarWidth(width);
}

function persistSidebarWidth(width:number){
 try{localStorage.setItem(SIDEBAR_WIDTH_KEY,String(width));}catch{}
}

export function Documents({user,onLogout,onUploadFolderChange}:{user:User;onLogout:()=>void;onUploadFolderChange:(target:DocumentUploadTarget|null)=>void}){
 const[folders,setFolders]=useState<Folder[]>([]);
 const[resolvedFolder,setResolvedFolder]=useState<{id:string;folder:Folder|null}|null>(null);
 const[status,setStatus]=useState("loading");
 const[reloadKey,setReloadKey]=useState(0);
 // File contents and folder hierarchy are independently invalidated. A CAD
 // preview finishing must never make the entire folder tree show "刷新中".
 const[treeReloadKey,setTreeReloadKey]=useState(0);
 const[grantsFolder,setGrantsFolder]=useState<Folder|null>(null);
 const[collaborationRevision,setCollaborationRevision]=useState(0);
 const[requiresApproval,setRequiresApproval]=useState(false);
 const[editingId,setEditingId]=useState<string|null>(null);
 // Folder move (AUD-02/WF-04) is dialog-scoped: the source is the right-clicked
 // folder, the candidate target and its notice live in the flow state machine.
 const[movingFolder,setMovingFolder]=useState<Folder|null>(null);
 const[move,setMove]=useState<FolderMoveState>(folderMoveIdle);
 const[moveMessage,setMoveMessage]=useState("");
 const[sidebarWidth,setSidebarWidth]=useState(readSidebarWidth);
 const[viewMode,setViewMode]=useState<ExplorerViewMode>(readExplorerViewMode);
 // Dragging is transient state the handle alone reads: it drives its own hit
 // area and the data-dragging laser rail, never the persisted width.
 const[resizing,setResizing]=useState(false);
 const resizeStart=useRef({x:0,width:sidebarWidth});
 const latestWidth=useRef(sidebarWidth);
 const location=useLocation();
 const navigate=useNavigate();
 const params=new URLSearchParams(location.search);
 const explicitFolder=params.get("folder");
 const requestedView=params.get("view");
 const section:DocumentSection=requestedView==="favorites"||requestedView==="received"||requestedView==="sent"||requestedView==="labels"?requestedView:"files";
 const requested=explicitFolder||"folder_root";
 // Only directory visits enter this history, not browser visits to preview
 // and organization pages. A new visit discards the forward branch.
 const folderHistory=useRef<string[]>([requested]);
 const folderHistoryIndex=useRef(0);
 const[historyIndex,setHistoryIndex]=useState(0);
 useEffect(()=>{
  if(folderHistory.current[folderHistoryIndex.current]===requested)return;
  const next=folderHistory.current.slice(0,folderHistoryIndex.current+1);
  next.push(requested);
  folderHistory.current=next;
  folderHistoryIndex.current=next.length-1;
  setHistoryIndex(next.length-1);
 },[requested]);
 function travelFolder(delta:-1|1){
  const next=folderHistoryIndex.current+delta;
  const target=folderHistory.current[next];
  if(target===undefined)return;
  folderHistoryIndex.current=next;
  setHistoryIndex(next);
  navigate(target==="folder_root"?"/doc":"/doc?folder="+encodeURIComponent(target));
 }
 function switchView(mode:ExplorerViewMode){
  setViewMode(mode);
  saveExplorerViewMode(mode);
 }
 const refreshTreeAndFiles=()=>{
  setTreeReloadKey(value=>value+1);
  setReloadKey(value=>value+1);
 };
 useEffect(()=>{
  const fileChanged=observeResourceChange("file",()=>setReloadKey(value=>value+1));
  const folderChanged=observeResourceChange("folder",refreshTreeAndFiles);
  const returned=observeWindowReturn(refreshTreeAndFiles);
  return()=>{fileChanged();folderChanged();returned();};
 },[]);
 useEffect(()=>{
  let valid=true;
  setStatus("loading");
  folderApi.tree()
   .then(data=>{if(valid){setFolders(data);setStatus("ready");}})
   .catch(()=>{if(valid)setStatus("failed");});
  return()=>{valid=false;};
 },[treeReloadKey]);
 const {folderById,visibleRoots}=useMemo(()=>{
  const folderById=new Map(folders.map(folder=>[folder.id,folder]));
  // The compatibility tree contains at most 500 hints. A membership index
  // avoids O(n²) scans as its limit grows.
  const visibleRoots=folders.filter(folder=>folder.parentId===null||!folderById.has(folder.parentId));
  return {folderById,visibleRoots};
 },[folders]);
 useEffect(()=>{
  if(!explicitFolder||folderById.has(requested)){
   setResolvedFolder(null);
   return;
  }
  let active=true;
  setResolvedFolder(null);
  // A paged search result or direct URL may identify a folder beyond the
  // first 500. Resolve exactly that id; never silently display root files.
  folderApi.get(requested)
   .then(folder=>{if(active)setResolvedFolder({id:requested,folder});})
   .catch(()=>{if(active)setResolvedFolder({id:requested,folder:null});});
  return()=>{active=false;};
 },[explicitFolder,requested,folderById,reloadKey]);
 const linkedFolder=resolvedFolder?.id===requested?resolvedFolder.folder:null;
 const selected=folderById.get(requested)??linkedFolder??(explicitFolder?null:visibleRoots[0]);
 // Only the visible, resolved directory is a direct OS-file drop destination.
 // A favorites/shared view always asks for a target folder, even when the URL
 // retains an older ?folder= selection.
 useLayoutEffect(()=>{
  onUploadFolderChange(section==="files"&&selected?{
   routeKey:location.pathname+location.search,folderId:selected.id,folderName:selected.name,userId:user.id,
  }:null);
  return()=>onUploadFolderChange(null);
 },[section,selected?.id,selected?.name,location.pathname,location.search,user.id,onUploadFolderChange]);
 const knownFolders=useMemo(()=>linkedFolder?[...folders,linkedFolder]:folders,[folders,linkedFolder]);
 const resolving=Boolean(explicitFolder&&!folderById.has(requested)&&resolvedFolder?.id!==requested);
 const inaccessible=Boolean(explicitFolder&&!folderById.has(requested)&&resolvedFolder?.id===requested&&!linkedFolder);
 // The page resolves the selected folder's approval policy and hands the flag
 // to the editor, keeping feature modules independent of each other.
 useEffect(()=>{
  if(!selected){setRequiresApproval(false);return;}
  let valid=true;
  workflowApi.policy(selected.id)
   .then(policy=>{if(valid)setRequiresApproval(policy.configured&&policy.enabled===true);})
   .catch(()=>{if(valid)setRequiresApproval(false);});
  return()=>{valid=false;};
 },[selected?.id]);
 // Structural target rules for the folder picker: the same function backs both
 // the per-row reason and the confirm gate, so a candidate that vanished from a
 // reloaded tree is judged by the flow's own visibility rule.
 function moveInvalidFor(folder:Folder):string|null{
  const source=movingFolder;
  return source?folderMoveInvalidTarget(folder,source,folders):null;
 }
 const moveTarget=move.targetId;
 const moveTargetFolder=knownFolders.find(f=>f.id===moveTarget);
 const moveBusy=folderMoveBusy(move);
 const moveInvalid=moveTarget===""?null:moveInvalidFor(moveTargetFolder??{id:moveTarget,name:"",parentId:null});
 const moveCanSubmit=movingFolder!==null&&moveInvalid===null&&folderMoveCanSubmit(move);
 // The default candidate is the visible current folder unless it is the source
 // itself, which the structure rules already forbid (COMPLEX-WORKFLOWS §2.1).
 function openMove(folder:Folder){
  setMoveMessage("");
  const preferred=selected&&selected.id!==folder.id&&folderMoveInvalidTarget(selected,folder,knownFolders)===null?selected.id:"";
  setMovingFolder(folder);
  setMove(folderMovePickTarget(folderMoveIdle(),preferred));
 }
 function closeMove(){
  setMovingFolder(null);
  setMove(folderMoveIdle());
 }
 async function submitMove(){
  const source=movingFolder;
  const target=moveTargetFolder;
  if(!source||!target||!moveCanSubmit)return;
  // No preflight step for folders: POST /api/moves/preflight accepts file
  // resources only, so the target is judged structurally on the client and the
  // server re-validates the cycle and the permissions in the move transaction.
  setMove(prev=>folderMoveSubmitStarted(prev));
  try{
   await folderApi.move(source.id,target.id);
   closeMove();
   setMoveMessage(`已移动「${source.name}」到「${target.name}」。`);
   refreshTreeAndFiles();
   // The URL still names the moved folder: land on its new parent so the
   // breadcrumb and the file table never describe a stale path (WF-09).
   if(selected?.id===source.id)navigate("/doc?folder="+encodeURIComponent(target.id));
  }catch(error){
   // Keep the dialog open on the candidate: the notice states the recovery the
   // server's code allows (other target, refresh after an interrupted request).
   const failure=folderMoveFailure(error);
   setMove(prev=>folderMoveFailed(prev,failure.notice,failure.unknown));
  }
 }
 function folderActionChanged(action:"rename"|"delete",folder:Folder){
  if(action==="delete"&&selected){
   // A subtree deletion invalidates an open descendant just as it invalidates
   // the deleted folder. Navigate to the surviving parent before reloading
   // instead of silently rendering the root behind a stale URL.
   const isInside=ancestorPath(knownFolders,selected.id).some(node=>node.id===folder.id);
   if(isInside){
    const destination=folders.find(item=>item.id===folder.parentId)??visibleRoots[0];
    navigate(destination?"/doc?folder="+encodeURIComponent(destination.id):"/doc",{replace:true});
   }
  }
  refreshTreeAndFiles();
 }
 // Pointer capture keeps the drag alive once the cursor leaves the 4px hit area
 // (SPEC §3.1), so the width tracks the pointer instead of the handle.
 function startResize(event:ReactPointerEvent<HTMLDivElement>){
  event.currentTarget.setPointerCapture(event.pointerId);
  resizeStart.current={x:event.clientX,width:sidebarWidth};
  setResizing(true);
 }
 function onResizeMove(event:ReactPointerEvent<HTMLDivElement>){
  if(!resizing)return;
  const width=clampSidebarWidth(resizeStart.current.width+(event.clientX-resizeStart.current.x));
  latestWidth.current=width;
  setSidebarWidth(width);
 }
 function endResize(event:ReactPointerEvent<HTMLDivElement>){
  if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
  setResizing(false);
  // The last pointermove may not have committed yet, so persist the measured
  // value rather than the one this closure was rendered with.
  persistSidebarWidth(latestWidth.current);
 }
 // Keyboard parity with the drag: 16px steps, 48px with shift, Home/End jump to
 // the spec bounds; the separator is a real focusable widget either way.
 function onResizeKey(event:ReactKeyboardEvent<HTMLDivElement>){
  const step=event.shiftKey?48:16;
  let next=sidebarWidth;
  if(event.key==="ArrowRight")next=sidebarWidth+step;
  else if(event.key==="ArrowLeft")next=sidebarWidth-step;
  else if(event.key==="Home")next=SIDEBAR_MIN;
  else if(event.key==="End")next=SIDEBAR_MAX;
  else return;
  event.preventDefault();
  const width=clampSidebarWidth(next);
  setSidebarWidth(width);
  persistSidebarWidth(width);
 }
 return <AppShell user={user} onLogout={onLogout}>
  <div className="panels document-explorer"><aside className="sidebar finder-sidebar" style={{width:sidebarWidth+"px"}}>
   <div className="sidebar-scroll">
    <FinderSidebar section={section} revision={collaborationRevision}/>
   </div>
   {/* The handle is a sibling of the scroll port, not a child of it: a 40-row
       tree would otherwise scroll the handle off screen while it stays
       focusable, and overflow-x:hidden would clip half of its 4px hot zone. */}
   <div className="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="调整侧边栏宽度" tabIndex={0}
    data-dragging={resizing?"true":"false"}
    onPointerDown={startResize} onPointerMove={onResizeMove} onPointerUp={endResize} onPointerCancel={endResize}
    onKeyDown={onResizeKey}/>
   </aside>
   <main className="work">
    {section==="labels"&&<TagExplorer viewMode={viewMode} onViewModeChange={switchView} onEdit={setEditingId}/>}
    {section!=="files"&&section!=="labels"&&<CollaborationPanel embedded activeTab={section} viewMode={viewMode} onViewModeChange={switchView}
    onSelectTab={tab=>navigate("/doc?view="+tab)}
    onChanged={()=>setCollaborationRevision(value=>value+1)}/>}
   {section==="files"&&<>
   {/* The path is a docked strip here, not inside the 40px top bar: it has to
       stay a <nav> landmark (DI-15) and VIS-11 allows only one nav in the
       header. Docked at 24px it costs a fraction of the row the old 44px
       breadcrumb bar used to take. */}
   {selected&&<div className="folder-context-bar">
     <div className="folder-history-controls" role="group" aria-label="目录浏览历史">
      <RareButton type="button" tone="ghost" aria-label="返回上一个目录" title="后退"
       disabled={historyIndex===0} onClick={()=>travelFolder(-1)}>
       <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m14.5 5-7 7 7 7"/></svg>
      </RareButton>
      <RareButton type="button" tone="ghost" aria-label="前往下一个目录" title="前进"
       disabled={historyIndex>=folderHistory.current.length-1} onClick={()=>travelFolder(1)}>
       <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9.5 5 7 7-7 7"/></svg>
      </RareButton>
     </div>
     <FolderBreadcrumb folders={knownFolders} folder={selected}/>
     <div className="folder-view-switch" role="group" aria-label="文件显示方式">
      {EXPLORER_VIEWS.map(mode=><RareButton type="button" key={mode.id} tone="ghost"
       aria-label={mode.label} title={mode.label} aria-pressed={viewMode===mode.id}
       onClick={()=>switchView(mode.id)}><ExplorerViewGlyph mode={mode.id}/></RareButton>)}
     </div>
     <div className="folder-actions-slot">
      <FolderActions folder={selected} isAdmin={user.isAdmin} onChanged={folderActionChanged}
       onMove={()=>openMove(selected)} onManageGrants={()=>setGrantsFolder(selected)}/>
     </div>
   </div>}
   {moveMessage&&<p role="status" className="notice">{moveMessage}</p>}
   {selected&&<DropZone folderId={selected.id} userId={user.id} onCommitted={()=>setReloadKey(k=>k+1)}>
     <FileTable folder={selected.id} folderName={selected.name} childFolders={knownFolders.filter(item=>item.parentId===selected.id)}
      folderPath={ancestorPath(knownFolders,selected.id)}
      onEdit={setEditingId} reloadKey={reloadKey} viewMode={viewMode} onFolderChanged={refreshTreeAndFiles}
      newFolderSlot={<NewFolderForm parentId={selected.id} onCreated={refreshTreeAndFiles}/>}/>
   </DropZone>}
   {!selected&&resolving&&<p role="status" className="empty"><BrandLoadingLabel decorative>正在核验所选目录…</BrandLoadingLabel></p>}
   {!selected&&status==="loading"&&!resolving&&<p role="status" className="empty"><BrandLoadingLabel>正在加载目录…</BrandLoadingLabel></p>}
   {!selected&&inaccessible&&<p role="alert" className="empty">目录不存在或当前账号无权访问。<Link to="/doc">返回根目录</Link></p>}
   {!selected&&!resolving&&!inaccessible&&status!=="loading"&&<p className="empty">当前账号没有可访问的目录，请联系管理员授权。</p>}
   </>}
   </main></div>
   {grantsFolder&&<QuickGrantsDialog folder={grantsFolder} onClose={()=>setGrantsFolder(null)}/>}
   {editingId&&<FileEditorBridge fileId={editingId} requiresApproval={requiresApproval}
    onClose={()=>setEditingId(null)} onSaved={()=>setReloadKey(k=>k+1)}/>}
   {/* The FolderPicker is a panel, so it lives inside the shared modal Dialog;
       the same closing callback (with candidate clearing) goes to both. */}
   {movingFolder&&<Dialog open title="移动到…" onClose={()=>{if(!moveBusy)closeMove();}} closeGuard={()=>!moveBusy} className="dialog">
    <FolderPicker open title="移动到…" folders={folders} selectedId={moveTarget}
     onSelect={id=>setMove(prev=>folderMovePickTarget(prev,id))}
     onClose={()=>{if(!moveBusy)closeMove();}}
     invalidTarget={moveInvalidFor}
     notice={move.notice||moveInvalid||undefined}
     busy={moveBusy}
     detail={<div>
      <p>源目录：{movePath(folders,movingFolder.id)}</p>
      <p>目标目录：{moveTargetFolder?movePath(folders,moveTargetFolder.id):"未选择"}</p>
     </div>}
     footer={<div className="dialog-actions">
      {move.unknown&&<RareButton type="button" className="secondary-action" disabled={moveBusy}
       onClick={refreshTreeAndFiles}>刷新查看状态</RareButton>}
      <RareButton type="button" className="secondary-action" disabled={moveBusy} onClick={closeMove}>取消</RareButton>
      <RareButton type="button" className="primary" loading={moveBusy} disabled={!moveCanSubmit}
       onClick={submitMove}>确认移动</RareButton>
     </div>}/>
   </Dialog>}
  </AppShell>;
}

// FileEditorBridge loads the file row for the editor dialog; the page owns the
// selection state and the editor stays presentational.
function FileEditorBridge({fileId,requiresApproval,onClose,onSaved}:{fileId:string;requiresApproval:boolean;onClose:()=>void;onSaved:()=>void}){
 const[file,setFile]=useState<FileItem|null>(null);
 useEffect(()=>{
  let valid=true;
  fileApi.meta(fileId)
   .then(data=>{if(valid)setFile(data.file);})
   .catch(()=>{if(valid)onClose();});
  return()=>{valid=false;};
 },[fileId,onClose]);
 if(!file)return null;
 return <FileEditor file={file} requiresApproval={requiresApproval} onClose={onClose} onSaved={onSaved}/>;
}

// The path belongs in the top bar (SPEC §3.1), not in a work-area row: the
// visible ancestor chain of the selected folder, root first, current last.
function FolderBreadcrumb({folders,folder}:{folders:Folder[];folder:Folder}){
 const navigate=useNavigate();
 const segments:{id:string|null;name:string}[]=[{id:null,name:"文档管理"},
  ...ancestorPath(folders,folder.id).map(ancestor=>({id:ancestor.id,name:ancestor.name}))];
 // Keep shallow paths fully visible; hidden ancestors in deep paths remain
 // reachable by keyboard and pointer rather than becoming an inert ellipsis.
 const collapsed=segments.length>5;
 const hidden=collapsed?segments.slice(1,-2):[];
 const tail=collapsed?segments.slice(-2):segments.slice(1);
 const[root]=segments;
 return <nav className="breadcrumb crumb-bar" aria-label="当前位置">
  {tail.length===0
   ?<span className="crumb-current" aria-current="page">{root?.name??"文档管理"}</span>
   :<Link className="crumb-root" to="/doc" title={root?.name??"文档管理"}>{root?.name??"文档管理"}</Link>}
  {hidden.length>0&&<span className="crumb-segment crumb-hidden">
   <span className="crumb-sep" aria-hidden="true">›</span>
   <select className="crumb-collapse-picker" aria-label="选择隐藏的上级目录" value="" onChange={event=>{
    if(event.target.value)navigate("/doc?folder="+encodeURIComponent(event.target.value));
   }}>
    <option value="">…</option>
    {hidden.map(segment=><option key={segment.id} value={segment.id??""}>{segment.name}</option>)}
   </select>
  </span>}
  {tail.map((segment,index)=><span className="crumb-segment" key={segment.id??"root"}>
   <span className="crumb-sep" aria-hidden="true">›</span>
   {index===tail.length-1
    ?<span className="crumb-current" aria-current="page" title={segment.name}>{segment.name}</span>
    :<Link title={segment.name} to={segment.id===null?"/doc":"/doc?folder="+encodeURIComponent(segment.id)}>{segment.name}</Link>}
  </span>)}
 </nav>;
}

// Visible-ancestor path only (the tree's own walk), so a path segment the
// caller cannot see is never invented for the move comparison.
function movePath(items:Folder[],id:string):string{
 return ancestorPath(items,id).map(folder=>folder.name).join(" / ");
}
