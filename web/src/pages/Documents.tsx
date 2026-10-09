import{useEffect,useRef,useState}from "react";
import{Link,useLocation}from "react-router-dom";
import type{User}from "../entities/user/model";
import type{Folder}from "../entities/folder/model";
import{folderApi}from "../features/folders/api";
import{FolderTree,ancestorPath}from "../features/folders/FolderTree";
import{NewFolderForm}from "../features/folders/NewFolderForm";
import{FolderActions}from "../features/folders/FolderActions";
import{GrantDialog}from "../features/folders/GrantDialog";
import{fileApi}from "../features/documents/api";
import{FileTable}from "../features/documents/FileTable";
import{DropZone}from "../features/documents/DropZone";
import{FileEditor}from "../features/documents/FileEditor";
import{workflowApi}from "../features/workflow/api";
import{PolicyDialog}from "../features/workflow/PolicyDialog";
import{organizationApi}from "../features/organization/api";
import{AppShell}from "../shared/ui/AppShell";
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
 const location=useLocation();
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
    onDeleteFolder={folder=>runFolderAction(folder,"delete")}
    onManageGrants={folder=>setGrantFolder(folder)}
    onManagePolicy={folder=>setPolicyFolder(folder)}/>}</aside>
   <main className="work">
   {status==="ready"&&selected&&<DropZone folderId={selected.id} onCommitted={()=>setReloadKey(k=>k+1)}>
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
   {status==="ready"&&!selected&&<p className="empty">当前账号没有可访问的目录，请联系管理员授权。</p>}
   </main></div>
   {grantFolder&&<GrantDialog folder={grantFolder} subjects={subjects} onClose={()=>setGrantFolder(null)}/>}
   {policyFolder&&<PolicyDialog folder={policyFolder} approvers={subjects} onClose={()=>setPolicyFolder(null)}/>}
   {editingId&&<FileEditorBridge fileId={editingId} requiresApproval={requiresApproval}
    onClose={()=>setEditingId(null)} onSaved={()=>setReloadKey(k=>k+1)}/>}
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
