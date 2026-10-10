import {RareButton,RareInput,RareSelect} from "../../shared/ui/rare";
import {useEffect,useMemo,useState} from "react";
import {request} from "../../shared/http";
import type {Folder} from "../../entities/folder/model";
import {Dialog} from "../../shared/ui/Dialog";
import {FolderPicker} from "../../shared/ui/FolderPicker";
import {AnimatedCounter} from "../../shared/ui/rare";
import {collaborationApi,formatBytes} from "./api";
import "./stats.css";

// Stats page: aggregates over the caller's real visibility scope, with the
// same filter as the CSV export.
export function StatsPanel(){
 const[stats,setStats]=useState<Awaited<ReturnType<typeof collaborationApi.stats>>|null>(null);
 const[status,setStatus]=useState("loading");
 const[folder,setFolder]=useState("");
 const[scope,setScope]=useState<"current"|"descendants"|"all">("current");
 const[kind,setKind]=useState("");
 // Folder scope (AUD-15/WF-29): the target is chosen in the shared FolderPicker
 // instead of being typed as a raw ID. The visible tree is read through the
 // shared JSON client so this feature stays independent of the folders module
 // (features/* may not import features/folders), exactly as RestoreDialog does.
 const[pickerOpen,setPickerOpen]=useState(false);
 const[candidate,setCandidate]=useState("");
 const[folders,setFolders]=useState<Folder[]>([]);
 const[treeState,setTreeState]=useState<"loading"|"ready"|"failed">("loading");
 const[treeToken,setTreeToken]=useState(0);

 // One filter object feeds the stats request and the CSV export, so the table
 // and the export can never describe different scopes (WF-29). The picker only
 // replaces the folder value; scope keeps the range select's meaning.
 const filters={folder:scope==="all"?"":folder,scope:scope==="descendants"?"descendants":"",type:kind};

 useEffect(()=>{
  let valid=true;
  setStatus("loading");
  collaborationApi.stats(filters)
   .then(data=>{if(valid){setStats(data);setStatus("ready");}})
   .catch(()=>{if(valid)setStatus("failed");});
  return()=>{valid=false;};
 },[folder,scope,kind]);

 // Every open reads the visible tree again: a folder that was deleted, or whose
 // grant was revoked, must not stay pickable from a cached list.
 useEffect(()=>{
  if(!pickerOpen)return;
  let valid=true;
  setTreeState("loading");
  request<Folder[]>("/folders/tree")
   .then(data=>{if(valid){setFolders(data);setTreeState("ready");}})
   .catch(()=>{if(valid)setTreeState("failed");});
  return()=>{valid=false;};
 },[pickerOpen,treeToken]);

 // Visible-ancestor path only: a hidden ancestor is never invented, and a
 // chosen folder outside the loaded visible set is reported, not faked.
 const folderPath=useMemo(()=>pathOf(folders,folder),[folders,folder]);
 const folderText=scope==="all"?"（统计全部可见目录）"
  :folder===""?"未选择（统计全部可见目录）"
  :folderPath===null?"该目录当前不可见"
  :folderPath||"（未命名目录）";

 function openPicker(){
  // Synchronous: the dialog must not render the previous tree for a frame
  // before the reload effect flips the state back to loading.
  setCandidate(folder);
  setTreeState("loading");
  setPickerOpen(true);
 }

 function closePicker(){
  setPickerOpen(false);
 }

 function applyFolder(){
  if(candidate==="")return;
  setFolder(candidate);
  setPickerOpen(false);
 }

 return <div className="work-body">
  <div className="toolbar">
   <label className="sort-label">范围
    <RareSelect value={scope} onChange={e=>setScope(e.target.value as "current"|"descendants"|"all")}>
     <option value="current">当前目录</option>
     <option value="descendants">包含子目录</option>
     <option value="all">我可访问的全部</option>
    </RareSelect>
   </label>
   <div className="stats-folder">
    <span className="stats-folder-label">目录</span>
    <span className={"stats-folder-path"+(folder!==""&&scope!=="all"?" chosen":"")} aria-live="polite">{folderText}</span>
    <RareButton type="button" disabled={scope==="all"} onClick={openPicker}>选择目录</RareButton>
    {folder!==""&&<RareButton type="button" className="secondary-action" onClick={()=>setFolder("")}>清除</RareButton>}
    {scope==="all"&&<span className="hint">“我可访问的全部”不需要选择目录</span>}
   </div>
   <label className="sort-label">类型
    <RareInput value={kind} onChange={e=>setKind(e.target.value)} placeholder="如 text / 留空"/>
   </label>
   <a className="primary" href={collaborationApi.exportUrl(filters)}>导出 CSV</a>
  </div>
  {status==="loading"&&<p className="empty">正在统计…</p>}
  {status==="failed"&&<p role="alert" className="notice error">统计失败。</p>}
  {stats&&<>
   <div className="stat-cards">
    <div className="stat-card"><span className="stat-num"><AnimatedCounter value={stats.totalFiles} /></span><span>文件数</span></div>
    <div className="stat-card"><span className="stat-num"><AnimatedCounter value={stats.totalFolders} /></span><span>目录数</span></div>
    <div className="stat-card"><span className="stat-num">{formatBytes(stats.totalBytes)}</span><span>当前版本总字节</span></div>
    <div className="stat-card"><span className="stat-num"><AnimatedCounter value={stats.added30Days} /></span><span>近 30 日新增</span></div>
   </div>
   <div className="table">
    <table>
     <thead><tr><th scope="col">类型</th><th scope="col">数量</th></tr></thead>
     <tbody>
      {stats.byType.length===0&&<tr><td colSpan={2} className="empty">无数据</td></tr>}
      {stats.byType.map(t=><tr key={t.type}><td>{t.type}</td><td>{t.count}</td></tr>)}
     </tbody>
    </table>
   </div>
   <div className="table">
    <table>
     <thead><tr><th scope="col">月份</th><th scope="col">新增文件</th></tr></thead>
     <tbody>
      {stats.byMonth.length===0&&<tr><td colSpan={2} className="empty">无数据</td></tr>}
      {stats.byMonth.map(m=><tr key={m.month}><td>{m.month}</td><td>{m.count}</td></tr>)}
     </tbody>
    </table>
   </div>
   <div className="table">
    <table>
     <thead><tr><th scope="col">上传人</th><th scope="col">上传文件数</th></tr></thead>
     <tbody>
      {stats.byUploader.length===0&&<tr><td colSpan={2} className="empty">无数据</td></tr>}
      {stats.byUploader.map(u=><tr key={u.uploaderId}><td>{u.uploaderName||u.uploaderId}</td><td>{u.count}</td></tr>)}
     </tbody>
    </table>
   </div>
  </>}
  {/* The FolderPicker is a panel, so it lives inside the shared modal Dialog;
      a click only sets the candidate and "应用" commits it to the stats scope. */}
  {pickerOpen&&<Dialog open title="选择统计目录" onClose={closePicker} className="dialog">
   {treeState==="loading"&&<p className="empty">正在读取目录…</p>}
   {treeState==="failed"&&<>
    <p role="alert" className="notice error">获取目录失败，请重试。</p>
    <div className="dialog-actions">
     <RareButton type="button" className="secondary-action" onClick={closePicker}>取消</RareButton>
     <RareButton type="button" className="primary" onClick={()=>setTreeToken(token=>token+1)}>重试</RareButton>
    </div>
   </>}
   {treeState==="ready"&&<FolderPicker open title="选择统计目录" folders={folders}
    selectedId={candidate}
    onSelect={setCandidate}
    onClose={closePicker}
    detail={<p className="hint">应用后统计范围：{scope==="descendants"?"所选目录及其子目录":"仅所选目录"}</p>}
    footer={<div className="dialog-actions">
     <RareButton type="button" className="secondary-action" onClick={closePicker}>取消</RareButton>
     <RareButton type="button" className="primary" disabled={candidate===""} onClick={applyFolder}>应用</RareButton>
    </div>}/>}
  </Dialog>}
 </div>;
}

// Visible-ancestor path only: an ancestor outside the loaded visible set is
// never invented, and a chosen folder that is no longer visible returns null.
function pathOf(folders:Folder[],id:string):string|null{
 const byId=new Map(folders.map(folder=>[folder.id,folder]));
 if(!byId.has(id))return null;
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
