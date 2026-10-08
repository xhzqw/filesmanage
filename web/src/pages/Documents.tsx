import {useEffect,useState} from "react";
import {Link,useLocation}from "react-router-dom";
import type{User}from "../entities/user/model";
import type{Folder}from "../entities/folder/model";
import{folderApi}from "../features/folders/api";
import{FolderTree}from "../features/folders/FolderTree";
import{NewFolderForm}from "../features/folders/NewFolderForm";
import{FolderActions}from "../features/folders/FolderActions";
import{FileTable}from "../features/documents/FileTable";

export function Documents({user,onLogout}:{user:User;onLogout:()=>void}){
 const[folders,setFolders]=useState<Folder[]>([]);
 const[status,setStatus]=useState("loading");
 const[reloadKey,setReloadKey]=useState(0);
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
 // The default root may be outside this user's visible set; anchor to the
 // first visible top-level folder instead.
 const visibleRoots=folders.filter(f=>f.parentId===null||!folders.some(p=>p.id===f.parentId));
 const selected=folders.find(f=>f.id===requested)??visibleRoots[0];
 return <div className="shell"><header className="header">
   <div className="brand"><span className="logo-placeholder" aria-label="官方 Logo 尚未导入">标志待入库</span>中晟生物科技 <span className="product">文档治理中心</span></div>
   <nav aria-label="主导航"><Link to="/doc">文档管理</Link><Link to="/trash">回收站</Link><span>上传 · 搜索 · 工作中心 · 组管理（持续开发）</span></nav>
   <span className="account">{user.displayName}</span><button onClick={onLogout}>退出</button>
 </header><div className="panels"><aside className="sidebar"><h2>文档管理</h2><p>文件夹</p>
   {status==="loading"&&<p>正在加载目录…</p>}
   {status==="failed"&&<p role="alert" className="error">获取目录失败，请刷新重试</p>}
   {status==="ready"&&<FolderTree items={folders} selected={selected?.id||""}/>}</aside>
   <main className="work">
   {status==="ready"&&selected&&<>
     <div className="breadcrumb">文档管理 / {selected.name}</div>
     <NewFolderForm parentId={selected.id} onCreated={()=>setReloadKey(k=>k+1)}/>
     <FolderActions folder={selected} onChanged={()=>setReloadKey(k=>k+1)}/>
     <FileTable folder={selected.id} folderName={selected.name}/>
   </>}
   {status==="ready"&&!selected&&<p className="empty">当前账号没有可访问的目录，请联系管理员授权。</p>}
   </main></div></div>;
}
