import{useEffect,useState}from "react";
import{Link,useLocation}from "react-router-dom";
import type{User}from "../entities/user/model";
import type{Folder}from "../entities/folder/model";
import{folderApi}from "../features/folders/api";
import{FolderTree}from "../features/folders/FolderTree";
import{NewFolderForm}from "../features/folders/NewFolderForm";
import{FolderActions}from "../features/folders/FolderActions";
import{GrantDialog}from "../features/folders/GrantDialog";
import{fileApi}from "../features/documents/api";
import{FileTable}from "../features/documents/FileTable";
import{FileEditor}from "../features/documents/FileEditor";
import{workflowApi}from "../features/workflow/api";
import{PolicyDialog}from "../features/workflow/PolicyDialog";
import{organizationApi}from "../features/organization/api";
import type {FileItem} from "../entities/file/model";

type Subject={id:string;displayName:string;login?:string};

export function Documents({user,onLogout}:{user:User;onLogout:()=>void}){
 const[folders,setFolders]=useState<Folder[]>([]);
 const[status,setStatus]=useState("loading");
 const[reloadKey,setReloadKey]=useState(0);
 const[grantOpen,setGrantOpen]=useState(false);
 const[policyOpen,setPolicyOpen]=useState(false);
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
  if((!grantOpen&&!policyOpen)||!user.isAdmin)return;
  let valid=true;
  organizationApi.users()
   .then(users=>{
    if(!valid)return;
    setSubjects(users.filter(u=>!u.disabled).map(u=>({id:u.id,displayName:u.displayName,login:u.login})));
   })
   .catch(()=>{if(valid)setSubjects([]);});
  return()=>{valid=false;};
 },[grantOpen,policyOpen,user.isAdmin]);
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
 return <div className="shell"><header className="header">
   <div className="brand"><span className="logo-placeholder" aria-label="官方 Logo 尚未导入">标志待入库</span>中晟生物科技 <span className="product">文档治理中心</span></div>
   <nav aria-label="主导航"><Link to="/doc">文档管理</Link><Link to="/workspace">共享/关注</Link><Link to="/stats">统计</Link><Link to="/approvals">审批</Link><Link to="/trash">回收站</Link><Link to="/org">组织管理</Link></nav>
   <span className="account">{user.displayName}</span><button onClick={onLogout}>退出</button>
 </header><div className="panels"><aside className="sidebar"><h2>文档管理</h2><p>文件夹</p>
   {status==="loading"&&<p>正在加载目录…</p>}
   {status==="failed"&&<p role="alert" className="error">获取目录失败，请刷新重试</p>}
   {status==="ready"&&<FolderTree items={folders} selected={selected?.id||""}/>}</aside>
   <main className="work">
   {status==="ready"&&selected&&<>
     <div className="breadcrumb">文档管理 / {selected.name}</div>
     <NewFolderForm parentId={selected.id} onCreated={()=>setReloadKey(k=>k+1)}/>
     <FolderActions folder={selected} isAdmin={user.isAdmin} onChanged={()=>setReloadKey(k=>k+1)} onManageGrants={()=>setGrantOpen(true)} onManagePolicy={()=>setPolicyOpen(true)}/>
     <FileTable folder={selected.id} folderName={selected.name} onEdit={setEditingId}/>
   </>}
   {status==="ready"&&!selected&&<p className="empty">当前账号没有可访问的目录，请联系管理员授权。</p>}
   </main></div>
   {grantOpen&&selected&&<GrantDialog folder={selected} subjects={subjects} onClose={()=>setGrantOpen(false)}/>}
   {policyOpen&&selected&&<PolicyDialog folder={selected} approvers={subjects} onClose={()=>setPolicyOpen(false)}/>}
   {editingId&&<FileEditorBridge fileId={editingId} requiresApproval={requiresApproval}
    onClose={()=>setEditingId(null)} onSaved={()=>setReloadKey(k=>k+1)}/>}
 </div>;
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
