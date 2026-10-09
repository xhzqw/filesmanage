import{useEffect,useRef,useState}from "react";
import{Link,useLocation,useNavigate}from "react-router-dom";
import type{User}from "../entities/user/model";
import type{Folder}from "../entities/folder/model";
import{folderApi}from "../features/folders/api";
import{FolderTree,ancestorPath}from "../features/folders/FolderTree";
import{NewFolderForm}from "../features/folders/NewFolderForm";
import{FolderActions}from "../features/folders/FolderActions";
import{GrantDialog}from "../features/folders/GrantDialog";
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

export function Documents({user,onLogout}:{user:User;onLogout:()=>void}){
 const[folders,setFolders]=useState<Folder[]>([]);
 const[status,setStatus]=useState("loading");
 const[reloadKey,setReloadKey]=useState(0);
 // Grant/policy dialogs are scoped to the folder the tree menu acted on, which
 // is not necessarily the currently selected folder.
 const[grantFolder,setGrantFolder]=useState<Folder|null>(null);
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
 // Only admins may manage grants and policies; both dialogs consume the
 // admin-only listings, loaded lazily when a dialog opens.
 useEffect(()=>{
  if((!grantFolder&&!policyFolder)||!user.isAdmin)return;
  let valid=true;
  organizationApi.users()
   .then(users=>{
    if(!valid)return;
    setSubjects(users.filter(u=>!u.disabled).map(u=>({id:u.id,displayName:u.displayName,login:u.login})));
   })
   .catch(()=>{if(valid)setSubjects([]);});
  return()=>{valid=false;};
 },[grantFolder,policyFolder,user.isAdmin]);
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
   const buttons=actionsRef.current?.querySelectorAll<HTMLButtonElement>(".folder-actions>button");
   if(!buttons||buttons.length===0)return;
   const target=action==="rename"?buttons[0]:buttons[buttons.length-1];
   target?.click();
  });
 }
 return <AppShell user={user} onLogout={onLogout}>
  <div className="panels"><aside className="sidebar"><h2>文档管理</h2><p>文件夹</p>
   {status==="loading"&&<p>正在加载目录…</p>}
   {status==="failed"&&<p role="alert" className="error">获取目录失败，请刷新重试</p>}
   {status==="ready"&&<FolderTree items={folders} selected={selected?.id||""} isAdmin={user.isAdmin}
    onRenameFolder={folder=>runFolderAction(folder,"rename")}
    onMoveFolder={openMove}
    onDeleteFolder={folder=>runFolderAction(folder,"delete")}
    onManageGrants={folder=>setGrantFolder(folder)}
    onManagePolicy={folder=>setPolicyFolder(folder)}/>}</aside>
   <main className="work">
   {moveMessage&&<p role="status" className="notice">{moveMessage}</p>}
   {/* The work area is gated on the resolved folder, not on the tree load
       state: a reloadKey cycle keeps the previous folders until the fresh
       tree lands, so the explorer (and any in-flight upload queue) is not
       torn down and remounted on every folder change. */}
   {selected&&<DropZone folderId={selected.id} onCommitted={()=>setReloadKey(k=>k+1)}>
     <nav className="breadcrumb" aria-label="当前位置">
      <span>文档管理</span>
      {ancestorPath(folders,selected.id).map((folder,index,chain)=><span key={folder.id}>
       {" / "}
       {index===chain.length-1
        ?<span aria-current="page">{folder.name}</span>
        :<Link to={"/doc?folder="+encodeURIComponent(folder.id)}>{folder.name}</Link>}
      </span>)}
     </nav>
     <NewFolderForm parentId={selected.id} onCreated={()=>setReloadKey(k=>k+1)}/>
     <div ref={actionsRef}><FolderActions folder={actionsFolder??selected} isAdmin={user.isAdmin} onChanged={()=>setReloadKey(k=>k+1)}
      onManageGrants={()=>setGrantFolder(actionsFolder??selected)} onManagePolicy={()=>setPolicyFolder(actionsFolder??selected)}/></div>
     <FileTable folder={selected.id} folderName={selected.name} onEdit={setEditingId} reloadKey={reloadKey}/>
   </DropZone>}
   {!selected&&status!=="loading"&&<p className="empty">当前账号没有可访问的目录，请联系管理员授权。</p>}
   </main></div>
   {grantFolder&&<GrantDialog folder={grantFolder} subjects={subjects} onClose={()=>setGrantFolder(null)}/>}
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
      {move.unknown&&<button type="button" className="secondary-action" disabled={moveBusy}
       onClick={()=>setReloadKey(k=>k+1)}>刷新查看状态</button>}
      <button type="button" className="secondary-action" disabled={moveBusy} onClick={closeMove}>取消</button>
      <button type="button" className="primary" disabled={moveBusy||!moveCanSubmit}
       onClick={submitMove}>{moveBusy?"移动中…":"确认移动"}</button>
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

// Visible-ancestor path only (the tree's own walk), so a path segment the
// caller cannot see is never invented for the move comparison.
function movePath(items:Folder[],id:string):string{
 return ancestorPath(items,id).map(folder=>folder.name).join(" / ");
}
