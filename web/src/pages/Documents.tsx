import {RareButton} from "../shared/ui/rare";
import{useEffect,useRef,useState,type KeyboardEvent as ReactKeyboardEvent,type PointerEvent as ReactPointerEvent}from "react";
import{Link,useLocation,useNavigate}from "react-router-dom";
import type{User}from "../entities/user/model";
import type{Folder}from "../entities/folder/model";
import{folderApi}from "../features/folders/api";
import{FolderTree,ancestorPath}from "../features/folders/FolderTree";
import{NewFolderForm}from "../features/folders/NewFolderForm";
import{FolderActions}from "../features/folders/FolderActions";
import{folderMoveBusy,folderMoveCanSubmit,folderMoveFailure,folderMoveFailed,folderMoveIdle,folderMoveInvalidTarget,folderMovePickTarget,folderMoveSubmitStarted,type FolderMoveState}from "../features/folders/moveFolderFlow";
import{fileApi}from "../features/documents/api";
import{FileTable}from "../features/documents/FileTable";
import{DropZone}from "../features/documents/DropZone";
import{FileEditor}from "../features/documents/FileEditor";
import{workflowApi}from "../features/workflow/api";
import{PolicyDialog}from "../features/workflow/PolicyDialog";
import{organizationApi}from "../features/organization/api";
import{AppShell}from "../shared/ui/AppShell";
import{Dialog}from "../shared/ui/Dialog";
import{FolderPicker}from "../shared/ui/FolderPicker";
import type {FileItem} from "../entities/file/model";

type Subject={id:string;displayName:string;login?:string};

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

export function Documents({user,onLogout}:{user:User;onLogout:()=>void}){
 const[folders,setFolders]=useState<Folder[]>([]);
 const[status,setStatus]=useState("loading");
 const[reloadKey,setReloadKey]=useState(0);
 // Approval policy is scoped to the folder the tree menu acted on.
 const[policyFolder,setPolicyFolder]=useState<Folder|null>(null);
 // Rename/delete from the tree menu reuse FolderActions' own dialogs: the bar
 // follows the right-clicked folder until the selection moves again.
 const[actionsFolder,setActionsFolder]=useState<Folder|null>(null);
 const actionsRef=useRef<HTMLDivElement>(null);
 const[subjects,setSubjects]=useState<Subject[]>([]);
 const[requiresApproval,setRequiresApproval]=useState(false);
 const[editingId,setEditingId]=useState<string|null>(null);
 // Folder move (AUD-02/WF-04) is dialog-scoped: the source is the right-clicked
 // folder, the candidate target and its notice live in the flow state machine.
 const[movingFolder,setMovingFolder]=useState<Folder|null>(null);
 const[move,setMove]=useState<FolderMoveState>(folderMoveIdle);
 const[moveMessage,setMoveMessage]=useState("");
 const[sidebarWidth,setSidebarWidth]=useState(readSidebarWidth);
 // Dragging is transient state the handle alone reads: it drives its own hit
 // area and the data-dragging laser rail, never the persisted width.
 const[resizing,setResizing]=useState(false);
 const resizeStart=useRef({x:0,width:sidebarWidth});
 const latestWidth=useRef(sidebarWidth);
 const location=useLocation();
 const navigate=useNavigate();
 const requested=new URLSearchParams(location.search).get("folder")||"folder_root";
 useEffect(()=>{
  let valid=true;
  setStatus("loading");
  folderApi.tree()
   .then(data=>{if(valid){setFolders(data);setStatus("ready");}})
   .catch(()=>{if(valid)setStatus("failed");});
  return()=>{valid=false;};
 },[reloadKey]);
 // Approval policy dialog consumes the admin-only subject listing on demand.
 useEffect(()=>{
  if(!policyFolder||!user.isAdmin)return;
  let valid=true;
  organizationApi.users()
   .then(users=>{
    if(!valid)return;
    setSubjects(users.filter(u=>!u.disabled).map(u=>({id:u.id,displayName:u.displayName,login:u.login})));
   })
   .catch(()=>{if(valid)setSubjects([]);});
  return()=>{valid=false;};
 },[policyFolder,user.isAdmin]);
 const visibleRoots=folders.filter(f=>f.parentId===null||!folders.some(p=>p.id===f.parentId));
 const selected=folders.find(f=>f.id===requested)??visibleRoots[0];
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
 const moveTargetFolder=folders.find(f=>f.id===moveTarget);
 const moveBusy=folderMoveBusy(move);
 const moveInvalid=moveTarget===""?null:moveInvalidFor(moveTargetFolder??{id:moveTarget,name:"",parentId:null});
 const moveCanSubmit=movingFolder!==null&&moveInvalid===null&&folderMoveCanSubmit(move);
 // The default candidate is the visible current folder unless it is the source
 // itself, which the structure rules already forbid (COMPLEX-WORKFLOWS §2.1).
 function openMove(folder:Folder){
  setMoveMessage("");
  const preferred=selected&&selected.id!==folder.id&&folderMoveInvalidTarget(selected,folder,folders)===null?selected.id:"";
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
   setReloadKey(k=>k+1);
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
 // The actions bar follows the right-clicked tree node only until the
 // selection moves again; navigation restores it to the selected folder.
 useEffect(()=>{setActionsFolder(null);},[selected?.id]);
 // Rename/delete from the tree menu reuse FolderActions' own dialogs instead
 // of duplicating them: the bar switches to the target folder and its matching
 // button is triggered programmatically (first button renames, last deletes).
 function runFolderAction(folder:Folder,action:"rename"|"delete"){
  setActionsFolder(folder);
  requestAnimationFrame(()=>{
   const buttons=actionsRef.current?.querySelectorAll<HTMLButtonElement>(".folder-actions button");
   if(!buttons||buttons.length===0)return;
   const target=action==="rename"
    ? Array.from(buttons).find(b=>b.textContent?.includes("重命名"))
    : Array.from(buttons).find(b=>b.textContent?.includes("删除"));
   target?.click();
  });
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
  <div className="panels"><aside className="sidebar" style={{width:sidebarWidth+"px"}}>
   <div className="sidebar-scroll">
   {/* The tree stays mounted across reloadKey cycles (an upload commit, a folder
       change, an edit save): unmounting it would drop keyboard focus and the
       expand state, so the previous folders keep rendering while the fresh tree
       loads and only the first load shows the loading/error states. */}
   {folders.length===0&&status==="loading"&&<p>正在加载目录…</p>}
   {folders.length===0&&status==="failed"&&<p role="alert" className="error">获取目录失败，请刷新重试</p>}
   {folders.length>0&&<FolderTree items={folders} selected={selected?.id||""} isAdmin={user.isAdmin}
    onRenameFolder={folder=>runFolderAction(folder,"rename")}
    onMoveFolder={openMove}
    onDeleteFolder={folder=>runFolderAction(folder,"delete")}
    onManageGrants={folder=>navigate("/org?tab=permissions&view=folder&folder="+encodeURIComponent(folder.id))}
    onManagePolicy={folder=>setPolicyFolder(folder)}/>}
   {folders.length>0&&status==="loading"&&<p className="hint">正在刷新目录…</p>}
   {folders.length>0&&status==="failed"&&<p role="alert" className="error">目录刷新失败，以下为上次数据。</p>}
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
   {/* The path is a docked strip here, not inside the 40px top bar: it has to
       stay a <nav> landmark (DI-15) and VIS-11 allows only one nav in the
       header. Docked at 24px it costs a fraction of the row the old 44px
       breadcrumb bar used to take. */}
   {selected&&<div className="folder-context-bar">
     <FolderBreadcrumb folders={folders} folder={selected}/>
     <div ref={actionsRef} className="folder-actions-slot">
      <FolderActions folder={actionsFolder??selected} isAdmin={user.isAdmin} onChanged={()=>setReloadKey(k=>k+1)}
       onManageGrants={()=>navigate("/org?tab=permissions&view=folder&folder="+encodeURIComponent((actionsFolder??selected).id))} onManagePolicy={()=>setPolicyFolder(actionsFolder??selected)}/>
     </div>
   </div>}
   {moveMessage&&<p role="status" className="notice">{moveMessage}</p>}
   {selected&&<DropZone folderId={selected.id} onCommitted={()=>setReloadKey(k=>k+1)}>
     <FileTable folder={selected.id} folderName={selected.name} onEdit={setEditingId} reloadKey={reloadKey}
      newFolderSlot={<NewFolderForm parentId={selected.id} onCreated={()=>setReloadKey(k=>k+1)}/>}/>
   </DropZone>}
   {!selected&&status!=="loading"&&<p className="empty">当前账号没有可访问的目录，请联系管理员授权。</p>}
   </main></div>
   {policyFolder&&<PolicyDialog folder={policyFolder} approvers={subjects} onClose={()=>setPolicyFolder(null)}/>}
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
       onClick={()=>setReloadKey(k=>k+1)}>刷新查看状态</RareButton>}
      <RareButton type="button" className="secondary-action" disabled={moveBusy} onClick={closeMove}>取消</RareButton>
      <RareButton type="button" className="primary" disabled={moveBusy||!moveCanSubmit}
       onClick={submitMove}>{moveBusy?"移动中…":"确认移动"}</RareButton>
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
 const segments:{id:string|null;name:string}[]=[{id:null,name:"文档管理"},
  ...ancestorPath(folders,folder.id).map(ancestor=>({id:ancestor.id,name:ancestor.name}))];
 // A deep chain would squeeze the command trigger out of the 40px bar, so only
 // the root and the last two segments stay, with the gap marked as a collapse.
 // The fold waits for a sixth segment: DI-15 walks root + three levels and
 // asserts every visible ancestor is still named, so folding one level earlier
 // would hide a real ancestor the gate requires.
 const collapsed=segments.length>5;
 const tail=collapsed?segments.slice(-2):segments.slice(1);
 const[root]=segments;
 return <nav className="breadcrumb crumb-bar" aria-label="当前位置">
  {tail.length===0
   ?<span className="crumb-current" aria-current="page">{root?.name??"文档管理"}</span>
   :<Link to="/doc">{root?.name??"文档管理"}</Link>}
  {collapsed?<span className="crumb-collapse">…</span>:null}
  {tail.map((segment,index)=><span key={segment.id??"root"}>
   <span className="crumb-sep" aria-hidden="true">›</span>
   {index===tail.length-1
    ?<span className="crumb-current" aria-current="page">{segment.name}</span>
    :<Link to={segment.id===null?"/doc":"/doc?folder="+encodeURIComponent(segment.id)}>{segment.name}</Link>}
  </span>)}
 </nav>;
}

// Visible-ancestor path only (the tree's own walk), so a path segment the
// caller cannot see is never invented for the move comparison.
function movePath(items:Folder[],id:string):string{
 return ancestorPath(items,id).map(folder=>folder.name).join(" / ");
}
