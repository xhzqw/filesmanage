import {useCallback,useEffect,useState} from "react";
import {Link,useLocation,useNavigate} from "react-router-dom";
import type {FileItem} from "../../entities/file/model";
import type {Folder} from "../../entities/folder/model";
import {RareButton} from "../../shared/ui/rare";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {ExplorerViewGlyph} from "../../shared/ui/ExplorerView";
import {EXPLORER_VIEWS,type ExplorerViewMode} from "./explorerView";
import {FileTable} from "./FileTable";
import {errorCopy} from "../../shared/errors";
import {finderColor,labelApi,type FinderLabel} from "../../shared/finderLabels";
import "./tagExplorer.css";

// This is the same resource explorer as an ordinary directory; only the source
// of the rows changes. Keep selection, keyboard, drag, menus and density owned
// by FileTable so the Finder UIs cannot drift apart.
export function TagExplorer({viewMode,onViewModeChange,onEdit}:{
 viewMode:ExplorerViewMode;onViewModeChange:(mode:ExplorerViewMode)=>void;onEdit:(id:string)=>void;
}){
 const location=useLocation(),navigate=useNavigate();
 const labelId=new URLSearchParams(location.search).get("label")||"";
 const [labels,setLabels]=useState<FinderLabel[]>([]);
 const [files,setFiles]=useState<FileItem[]>([]);
 const [folders,setFolders]=useState<Folder[]>([]);
 const [state,setState]=useState<"loading"|"ready"|"failed">("loading");
 const [error,setError]=useState("");
 const [revision,setRevision]=useState(0);
 const active=labels.find(label=>label.id===labelId);
 const refresh=useCallback(async()=>{
  if(!labelId){setFiles([]);setFolders([]);setState("ready");return;}
  const page=await labelApi.resources(labelId);
  setFiles(page.items);setFolders(page.folders);
  setRevision(n=>n+1);
  setState("ready");
 },[labelId]);
 useEffect(()=>{
  let live=true;setState("loading");setError("");
  labelApi.list().then(async all=>{
   if(!live)return;
   setLabels(all);
   if(labelId&&!all.some(label=>label.id===labelId))throw Error("标签不存在或已被删除");
   if(!labelId){setFiles([]);setFolders([]);setState("ready");return;}
   const page=await labelApi.resources(labelId);
   if(live){setFiles(page.items);setFolders(page.folders);setState("ready");setRevision(n=>n+1);}
  }).catch(error=>{if(live){setState("failed");setError(errorCopy(error,"无法读取标签资源"));}});
  return()=>{live=false;};
 },[labelId]);
 useEffect(()=>{
  const onChange=()=>{void refresh().catch(error=>{setState("failed");setError(errorCopy(error,"刷新标签失败"));});};
  window.addEventListener("filesmanage:labels-change",onChange);
  return()=>window.removeEventListener("filesmanage:labels-change",onChange);
 },[refresh]);
 return <section className="tag-explorer" aria-label="标签文件管理">
  <div className="folder-context-bar tag-context-bar">
   <div className="tag-path">
    <RareButton type="button" tone="ghost" aria-label="返回所有文档" title="返回所有文档" onClick={()=>navigate("/doc")}>
     <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m14.5 5-7 7 7 7"/></svg>
    </RareButton>
    <Link to="/doc?view=labels" className="tag-path-all">所有标签</Link>
    {active&&<><span className="tag-path-divider">/</span><span className="finder-tag-dot" style={{backgroundColor:finderColor(active.color)}}/><strong>{active.name}</strong></>}
   </div>
   {labelId&&<div id="tag-file-toolbar-host" className="folder-file-toolbar-host"/>}
  </div>
  {!labelId&&state==="ready"&&<div className="tag-explorer-overview">
   {labels.map(label=><Link key={label.id} to={"/doc?view=labels&label="+encodeURIComponent(label.id)} className="tag-explorer-choice">
    <span className="finder-tag-dot" style={{backgroundColor:finderColor(label.color)}}/>
    <span>{label.name}</span>
   </Link>)}
   <p className="tag-explorer-hint">将文件或文件夹拖至左侧标签，即可归类；原目录不会改变。</p>
  </div>}
  {state==="loading"&&<p className="tag-explorer-message" role="status"><BrandLoadingLabel>正在加载标签…</BrandLoadingLabel></p>}
  {state==="failed"&&<div className="tag-explorer-message" role="alert">{error}
   <RareButton type="button" onClick={()=>{setState("loading");void refresh().catch(error=>{setState("failed");setError(errorCopy(error,"刷新失败"));});}}>重试</RareButton>
  </div>}
  {labelId&&state==="ready"&&<FileTable key={labelId} folder="folder_root" folderName={active?.name??"标签"}
   childFolders={folders} labelId={labelId} taggedItems={files} reloadKey={revision}
   onTagRefresh={refresh} viewMode={viewMode} onEdit={onEdit} toolbarHostId="tag-file-toolbar-host"
   viewControls={<div className="folder-view-switch" role="group" aria-label="文件显示方式">
    {EXPLORER_VIEWS.map(mode=><RareButton key={mode.id} type="button" tone="ghost"
     title={mode.label} aria-label={mode.label} aria-pressed={viewMode===mode.id}
     onClick={()=>onViewModeChange(mode.id)}><ExplorerViewGlyph mode={mode.id}/></RareButton>)}
   </div>}/>}
 </section>;
}
