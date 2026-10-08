import{useEffect,useState}from "react";
import{Link,useLocation}from "react-router-dom";
import type{User}from "../entities/user/model";
import type{Folder}from "../entities/folder/model";
import{folderApi}from "../features/folders/api";
import{FolderTree}from "../features/folders/FolderTree";
export function Documents({user,onLogout}:{user:User;onLogout:()=>void}){
 const[folders,setFolders]=useState<Folder[]>([]);
 const[status,setStatus]=useState("loading");
 const location=useLocation();
 const requested=new URLSearchParams(location.search).get("folder")||"folder_root";
 useEffect(()=>{
  let valid=true;
  folderApi.tree()
   .then(data=>{if(valid){setFolders(data);setStatus("ready");}})
   .catch(()=>{if(valid){setStatus("failed");}});
  return()=>{valid=false;};
 },[]);
 // Fallback selection: the requested folder (or the default root) may sit outside this
 // user's visible set, so anchor the breadcrumb to the first visible top-level folder.
 const visibleRoots=folders.filter(f=>f.parentId===null||!folders.some(p=>p.id===f.parentId));
 const selected=folders.find(f=>f.id===requested)??visibleRoots[0];
 return <div className="shell"><header className="header">
   <div className="brand"><span className="logo-placeholder" aria-label="官方 Logo 尚未导入">标志待入库</span>中晟生物科技 <span className="product">文档治理中心</span></div>
   <nav aria-label="主导航"><Link to="/doc">文档管理</Link><span>上传 · 搜索 · 工作中心 · 组管理（待开发）</span></nav>
   <span className="account">{user.displayName}</span><button onClick={onLogout}>退出</button>
 </header><div className="panels"><aside className="sidebar"><h2>文档管理</h2><p>文件夹</p>
   {status==="loading"&&<p>正在加载目录…</p>}
   {status==="failed"&&<p role="alert" className="error">获取目录失败</p>}
   {status==="ready"&&<FolderTree items={folders} selected={selected?.id||""}/>}</aside>
   <main className="work"><div className="breadcrumb">文档管理 / {selected?.name||"请选择目录"}</div>
   <div className="toolbar" aria-label="未开放的文件操作">菜单 · 查看 · 新建文件夹 · 上传 · 下载 · 预览 · 修改 · 版本</div>
   <div className="table"><table><thead><tr><th>文件名</th><th>大小</th><th>上传人</th><th>修改日期</th></tr></thead>
   <tbody><tr><td colSpan={4} className="empty">仅真实登录与目录树已接入。后续文件操作仍在开发中，不提供虚假按钮。</td></tr></tbody></table></div>
 </main></div></div>;
}
