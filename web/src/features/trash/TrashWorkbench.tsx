import {Link} from "react-router-dom";
import {BrandLogo} from "../../shared/ui/AppShell";
import {useEffect,useMemo,useState} from "react";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {toast} from "../../shared/ui/feedback";
import type {TrashEntry} from "../../entities/trash/model";
import type {Folder} from "../../entities/folder/model";
import {request} from "../../shared/http";
import {errorCode,errorCopy} from "../../shared/errors";
import {observeResourceChange,observeWindowReturn} from "../../shared/resourceSync";
import {Dialog} from "../../shared/ui/Dialog";
import {Menu} from "../../shared/ui/Menu";
import {FileResourceIcon,FolderResourceIcon} from "../../shared/ui/ResourceIcons";
import {MicroHoldToDelete,RareButton,RareDataTable,RareInput,RareRowActions,RareSelect} from "../../shared/ui/rare";
import {trashApi} from "./api";
import {RestoreDialog} from "./RestoreDialog";
import {FileHistoryPanel} from "../../shared/ui/FileHistoryPanel";
import "./trashWorkbench.css";

const PAGE_SIZE=40;
type Notice={text:string;error:boolean;warning?:boolean;announced?:boolean};
type MenuState={entry:TrashEntry;anchor:HTMLElement};

function since(period:string):string{
 if(period==="all")return "";
 const d=new Date();
 if(period==="today")d.setHours(0,0,0,0);
 else d.setDate(d.getDate()-(period==="week"?7:30));
 return d.toISOString();
}

function dateLabel(raw:string):string{
 const d=new Date(raw);
 return Number.isNaN(d.valueOf())?raw:d.toLocaleString("zh-CN",{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false});
}

function EntryIcon({folder,name}:{folder:boolean;name:string}){
 return folder?<FolderResourceIcon size={20}/>:<FileResourceIcon name={name} size={20}/>;
}

function visibleParentPath(entry:TrashEntry,byId:Map<string,Folder>):string{
 if(entry.oldParentPath)return entry.oldParentPath;
 if(!entry.oldParentTrail?.length)return "历史路径未记录 · 恢复时请选择位置";
 if(!entry.oldParentId)return "原位置不可用";
 const parts:string[]=[];
 let id:string|null|undefined=entry.oldParentId;
 const seen=new Set<string>();
 while(id&&!seen.has(id)){
  seen.add(id);
  const f=byId.get(id);
  if(!f)return "原目录已删除或不可访问";
  parts.unshift(f.name);id=f.parentId;
 }
 return parts.length?"/"+parts.join("/"): "原位置不可用";
}

export function TrashWorkbench({onRestored}:{onRestored:()=>void}){
 const[entries,setEntries]=useState<TrashEntry[]>([]);
 const[hasMore,setHasMore]=useState(false);
 const[status,setStatus]=useState<"loading"|"ready"|"failed">("loading");
 const[search,setSearch]=useState("");
 const[debouncedSearch,setDebouncedSearch]=useState("");
 const[deletedBy,setDeletedBy]=useState("");
 const[debouncedBy,setDebouncedBy]=useState("");
 const[kind,setKind]=useState("all");
 const[period,setPeriod]=useState("all");
 const[sort,setSort]=useState("recent");
 const[offset,setOffset]=useState(0);
 const[reload,setReload]=useState(0);
 const[expanded,setExpanded]=useState(false);
 const[selected,setSelected]=useState<Set<string>>(new Set());
 const[notice,setNotice]=useState<Notice|null>(null);
 const[isAdmin,setIsAdmin]=useState(false);
 const[folders,setFolders]=useState<Folder[]>([]);
 const[restoring,setRestoring]=useState<TrashEntry|null>(null);
 const[historyEntry,setHistoryEntry]=useState<TrashEntry|null>(null);
 const[menu,setMenu]=useState<MenuState|null>(null);
 const[purgeTargets,setPurgeTargets]=useState<TrashEntry[]>([]);
 const[purgeStage,setPurgeStage]=useState<"impact"|"final">("impact");
 const[busy,setBusy]=useState(false);
 const[purgeError,setPurgeError]=useState("");

 useEffect(()=>{
  const invalidate=()=>setReload(token=>token+1);
  const changed=observeResourceChange("trash",invalidate);
  const returned=observeWindowReturn(invalidate);
  return()=>{changed();returned();};
 },[]);

 useEffect(()=>{
  const timer=window.setTimeout(()=>{setOffset(0);setDebouncedSearch(search.trim());},300);
  return()=>window.clearTimeout(timer);
 },[search]);
 useEffect(()=>{
  const timer=window.setTimeout(()=>{setOffset(0);setDebouncedBy(deletedBy.trim());},300);
  return()=>window.clearTimeout(timer);
 },[deletedBy]);
 useEffect(()=>{
  let alive=true;
  setStatus("loading");
  trashApi.page({limit:PAGE_SIZE,offset,search:debouncedSearch,kind,deletedBy:debouncedBy,sort,from:since(period)})
   .then(page=>{
    if(!alive)return;
    // Other tabs may have restored/purged the last record on this page.
    // Never strand the user on an empty page when an earlier page exists.
    if(page.items.length===0&&offset>0){setOffset(Math.max(0,offset-PAGE_SIZE));return;}
    setEntries(page.items);setHasMore(page.hasMore);setStatus("ready");setSelected(new Set());
   })
   .catch(error=>{if(alive){setStatus("failed");setNotice({text:errorCopy(error,"加载回收站失败"),error:true});}});
  return()=>{alive=false;};
 },[offset,debouncedSearch,kind,debouncedBy,period,sort,reload]);
 useEffect(()=>{
  let alive=true;
  request<{isAdmin:boolean}>("/me").then(u=>{if(alive)setIsAdmin(u.isAdmin);}).catch(()=>{if(alive)setIsAdmin(false);});
  request<Folder[]>("/folders/tree").then(items=>{if(alive)setFolders(items);}).catch(()=>{if(alive)setFolders([]);});
  return()=>{alive=false;};
 },[reload]);

 const byId=useMemo(()=>new Map(folders.map(f=>[f.id,f])),[folders]);
 const selectedRows=entries.filter(e=>selected.has(e.id));
 const allSelected=entries.length>0&&selectedRows.length===entries.length;
 const locked=busy||status!=="ready"||restoring!==null||purgeTargets.length>0;
 function refresh(){setReload(n=>n+1);}
 function updateKind(value:string){setKind(value);setOffset(0);}
 function updatePeriod(value:string){setPeriod(value);setOffset(0);}
 function updateSort(value:string){setSort(value);setOffset(0);}
 function notify(text:string,tone:"success"|"warning"|"danger"="success"){
  // Partial/uncertain results need persistent actionable details. A fully
  // completed success should only appear in the shared toast.
  setNotice(tone==="success"?null:{text,error:tone==="danger",warning:tone==="warning",announced:true});
  (tone==="danger"?toast.error:tone==="warning"?toast.warning:toast.success)(text);
 }
 function chooseOne(id:string,checked:boolean){
  setSelected(current=>{const next=new Set(current);if(checked)next.add(id);else next.delete(id);return next;});
 }
 function askPurge(targets:TrashEntry[]){
  if(!targets.length)return;
  setMenu(null);setPurgeError("");setPurgeStage("impact");setPurgeTargets(targets);
 }
 async function batchRestore(){
  if(locked||!selectedRows.length)return;
  setBusy(true);setNotice(null);
  let ok=0;const errors:string[]=[];let uncertain=false;
  for(const entry of selectedRows){
   if(!entry.oldParentTrail?.length){
    errors.push(entry.oldName+"：历史位置未记录，请单独选择恢复目录");
    continue;
   }
   try{await trashApi.restore(entry.id,"","");ok++;}
   catch(error){
    if(errorCode(error)==="E_NETWORK"){
     errors.push(entry.oldName+"：请求中断，恢复结果未确认");
     uncertain=true;break;
    }
    errors.push(entry.oldName+"："+errorCopy(error,"恢复失败"));
   }
  }
  setBusy(false);setSelected(new Set());refresh();
  if(ok)onRestored();
  const summary=`已确认恢复 ${ok} 项`+
   (errors.length?`；${uncertain?"包含结果未确认项":"未恢复"} ${errors.length} 项：${errors.slice(0,2).join("；")}`:"");
  notify(summary,uncertain||ok>0&&errors.length>0?"warning":errors.length>0?"danger":"success");
 }
 async function confirmPurge(){
  if(busy||purgeTargets.length===0)return;
  setBusy(true);setPurgeError("");
  let ok=0;const errors:string[]=[];let uncertain=false;
  for(const entry of purgeTargets){
   try{await trashApi.purge(entry.id);ok++;}
   catch(error){
    if(errorCode(error)==="E_NETWORK"){
     errors.push(entry.oldName+"：请求中断，永久删除结果未确认；请刷新核实");
     uncertain=true;break;
    }
    errors.push(entry.oldName+"："+errorCopy(error,"永久删除失败"));
   }
  }
  setBusy(false);setPurgeTargets([]);setSelected(new Set());refresh();
  notify(`已确认永久删除 ${ok} 项`+(errors.length?`；${errors.slice(0,3).join("；")}`:""),
   uncertain||ok>0&&errors.length>0?"warning":errors.length>0?"danger":"success");
 }

 return <>
  <aside className="sidebar finder-sidebar" style={{width:"240px"}}>
   <Link to="/doc" className="finder-sidebar-home" aria-label="中晟生物 · 返回文档首页">
    <BrandLogo size={27} className="finder-sidebar-logo" transparent/><span>中晟生物</span>
   </Link>
   <div className="sidebar-scroll">
    <div className="finder-navigation trash-sidebar-nav" role="navigation" aria-label="回收站分类导航">
     <div className="finder-nav-section">
      <div className="finder-nav-label">资源类型</div>
      <RareButton type="button" className={"finder-nav-item"+(kind==="all"?" is-current":"")} onClick={()=>updateKind("all")}>
       <span className="finder-nav-bullet" aria-hidden="true">▤</span><span>全部类型</span>
      </RareButton>
      <RareButton type="button" className={"finder-nav-item"+(kind==="folder"?" is-current":"")} onClick={()=>updateKind("folder")}>
       <span className="finder-nav-bullet" aria-hidden="true">📁</span><span>仅文件夹</span>
      </RareButton>
      <RareButton type="button" className={"finder-nav-item"+(kind==="file"?" is-current":"")} onClick={()=>updateKind("file")}>
       <span className="finder-nav-bullet" aria-hidden="true">📄</span><span>仅文件</span>
      </RareButton>
     </div>
     <div className="finder-nav-section">
      <div className="finder-nav-label">删除时间</div>
      <RareButton type="button" className={"finder-nav-item"+(period==="all"?" is-current":"")} onClick={()=>updatePeriod("all")}>
       <span>全部时间</span>
      </RareButton>
      <RareButton type="button" className={"finder-nav-item"+(period==="today"?" is-current":"")} onClick={()=>updatePeriod("today")}>
       <span>今天</span>
      </RareButton>
      <RareButton type="button" className={"finder-nav-item"+(period==="week"?" is-current":"")} onClick={()=>updatePeriod("week")}>
       <span>最近 7 天</span>
      </RareButton>
      <RareButton type="button" className={"finder-nav-item"+(period==="month"?" is-current":"")} onClick={()=>updatePeriod("month")}>
       <span>最近 30 天</span>
      </RareButton>
     </div>
     <div className="finder-nav-section">
      <div className="finder-nav-label">排序方式</div>
      <RareButton type="button" className={"finder-nav-item"+(sort==="recent"?" is-current":"")} onClick={()=>updateSort("recent")}>
       <span>最近删除</span>
      </RareButton>
      <RareButton type="button" className={"finder-nav-item"+(sort==="oldest"?" is-current":"")} onClick={()=>updateSort("oldest")}>
       <span>最早删除</span>
      </RareButton>
      <RareButton type="button" className={"finder-nav-item"+(sort==="name"?" is-current":"")} onClick={()=>updateSort("name")}>
       <span>名称排序</span>
      </RareButton>
     </div>
     <div className="finder-nav-section">
      <div className="finder-nav-label">快捷操作</div>
      <RareButton type="button" className="finder-nav-item trash-refresh" disabled={busy} onClick={refresh} aria-label="刷新回收站">
       <span>↻ 刷新回收站</span>
      </RareButton>
     </div>
    </div>
   </div>
   <div className="sidebar-resizer" role="separator" aria-orientation="vertical" tabIndex={-1}/>
  </aside>
  <main className="work trash-work">
   <div className="folder-context-bar trash-context-bar">
    <div className="folder-history-controls"><span className="trash-context-icon" aria-hidden="true">🗑</span></div>
    <strong className="folder-current-title">回收站</strong>
    <div className="trash-filters">
     <RareInput type="search" aria-label="搜索删除记录" placeholder="搜索已删除文件或目录名称…" value={search} maxLength={120} onChange={e=>setSearch(e.target.value)}/>
    </div>
    {selected.size>0&&<div className="trash-selection">
     <span>已选 {selectedRows.length} 项</span>
     <RareButton type="button" disabled={locked} tone="primary" onClick={batchRestore}>批量恢复</RareButton>
     {isAdmin&&<RareButton type="button" disabled={locked} className="danger" onClick={()=>askPurge(selectedRows)}>永久删除</RareButton>}
     <RareButton type="button" disabled={locked} tone="ghost" onClick={()=>setSelected(new Set())}>取消选择</RareButton>
    </div>}
    <div className="trash-context-tools">
     <RareButton type="button" aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)} className={"trash-extra-toggle"+(expanded?" on":"")} tone="ghost">高级筛选 ▾</RareButton>
     <RareButton type="button" className="trash-refresh-btn" disabled={busy} onClick={refresh} aria-label="刷新回收站" title="刷新回收站" tone="ghost">↻ 刷新</RareButton>
    </div>
   </div>
   {expanded&&<div className="trash-extra"><label htmlFor="trash-delete-user">删除人</label><RareInput id="trash-delete-user" placeholder="按删除人筛选" maxLength={80} value={deletedBy} onChange={e=>setDeletedBy(e.target.value)}/>
    <RareButton type="button" onClick={()=>{setDeletedBy("");setSearch("");updateKind("all");updatePeriod("all");updateSort("recent");}}>重置筛选</RareButton>
   </div>}
   {notice&&<div role={notice.announced?undefined:notice.error?"alert":"status"} className={"trash-notice"+(notice.error?" error":notice.warning?" warning":"")}>{notice.text}<RareButton type="button" aria-label="关闭提示" onClick={()=>setNotice(null)}>×</RareButton></div>}
   <div className="work-body trash-table-scroll">
   <RareDataTable className="trash-table">
    <thead><tr>
     <th scope="col"><RareInput type="checkbox" aria-label="全选当前页" checked={allSelected} disabled={locked||entries.length===0} onChange={e=>setSelected(new Set(e.target.checked?entries.map(item=>item.id):[]))}/></th>
     <th scope="col">名称 / 原位置</th><th scope="col">类型</th><th scope="col">删除人</th><th scope="col">删除时间</th><th scope="col">操作</th>
    </tr></thead>
    <tbody>
     {status==="loading"&&<tr><td colSpan={6} className="trash-empty"><BrandLoadingLabel size="sm">正在加载回收站…</BrandLoadingLabel></td></tr>}
     {status==="failed"&&<tr><td colSpan={6} className="trash-empty"><span role="alert">加载失败</span> <RareButton type="button" onClick={refresh}>重试</RareButton></td></tr>}
     {status==="ready"&&entries.length===0&&<tr><td colSpan={6} className="trash-empty">{offset>0?"当前页无记录，请返回上一页":"没有符合条件的记录"}</td></tr>}
     {status==="ready"&&entries.map(entry=><tr key={entry.id}>
      <td><RareInput type="checkbox" aria-label={`选择 ${entry.oldName}`} checked={selected.has(entry.id)} disabled={locked} onChange={e=>chooseOne(entry.id,e.target.checked)}/></td>
      <td><div className="trash-resource"><EntryIcon folder={!!entry.folderId} name={entry.oldName}/><div className="trash-resource-text"><strong title={entry.oldName}>{entry.oldName}</strong><small title={visibleParentPath(entry,byId)}>{visibleParentPath(entry,byId)}</small><small className="trash-mobile-meta">{entry.folderId?"目录":"文件"} · {entry.deletedByName||"—"} · {dateLabel(entry.deletedAt)}</small></div></div></td>
      <td>{entry.folderId?`目录${entry.subtreeCount?` · ${entry.subtreeCount} 子项`:""}`:"文件"}</td>
      <td className="trash-muted">{entry.deletedByName||"—"}</td>
      <td className="trash-muted">{dateLabel(entry.deletedAt)}</td>
      <td><RareRowActions className="trash-row-actions">
       <RareButton type="button" disabled={locked} onClick={()=>{setNotice(null);setRestoring(entry);}}>恢复</RareButton>
       {entry.fileId&&<RareButton type="button" disabled={locked} onClick={()=>setHistoryEntry(entry)}>历史</RareButton>}
       {isAdmin&&<RareButton type="button" aria-label={`更多操作：${entry.oldName}`} title="更多操作" disabled={locked} onClick={e=>setMenu({entry,anchor:e.currentTarget})}>···</RareButton>}
      </RareRowActions></td>
     </tr>)}
    </tbody>
   </RareDataTable>
  </div>
   <div className="status-bar finder-bottom-bar">
    <span className="finder-bottom-node">类型：{kind==="all"?"全部类型":kind==="folder"?"文件夹":"文件"}</span>
    <span className="finder-bottom-count">每页 {PAGE_SIZE} 项 · 第 {Math.floor(offset/PAGE_SIZE)+1} 页 · 共 {entries.length} 项</span>
    <div className="finder-bottom-actions">
     <RareButton type="button" tone="ghost" disabled={locked||status!=="ready"||offset===0} onClick={()=>setOffset(v=>Math.max(0,v-PAGE_SIZE))}>上一页</RareButton>
     <RareButton type="button" tone="ghost" disabled={locked||status!=="ready"||!hasMore} onClick={()=>setOffset(v=>v+PAGE_SIZE)}>下一页</RareButton>
    </div>
   </div>
  </main>
  <Menu open={menu!==null} onClose={()=>setMenu(null)} label="回收站操作" anchor={menu?.anchor} items={menu?[{id:"purge",label:"永久删除",danger:true,onSelect:()=>askPurge([menu.entry])}]:[]}/>
  {historyEntry?.fileId&&<Dialog open title={historyEntry.oldName+" · 历史"} onClose={()=>setHistoryEntry(null)} className="trash-history-dialog">
   <FileHistoryPanel fileId={historyEntry.fileId} revision={reload}/>
  </Dialog>}
  {restoring&&<RestoreDialog entry={restoring} onClose={()=>setRestoring(null)} onReload={()=>{setRestoring(null);refresh();}} onRestored={()=>{setRestoring(null);refresh();onRestored();}}/>}
  {purgeTargets.length>0&&<Dialog open title={purgeTargets.length===1?"永久删除":"批量永久删除"} onClose={()=>{if(!busy)setPurgeTargets([]);}} closeGuard={()=>!busy} className="dialog">
   <p role="alert" className="trash-danger-note">将永久移除 {purgeTargets.length} 项资源及其版本历史，无法撤销。</p>
   <p className="trash-purge-summary">{purgeTargets.slice(0,3).map(e=>e.oldName).join("、")}{purgeTargets.length>3?` 等 ${purgeTargets.length} 项`:""}</p>
   {purgeStage==="final"&&<p className="trash-danger-note">再次确认：请长按删除按钮执行。</p>}
   {purgeError&&<p role="alert">{purgeError}</p>}
   <div className="dialog-actions">
    <RareButton type="button" disabled={busy} onClick={()=>setPurgeTargets([])}>取消</RareButton>
    {purgeStage==="impact"
     ?<RareButton type="button" disabled={busy} onClick={()=>setPurgeStage("final")}>继续</RareButton>
     :<><RareButton type="button" disabled={busy} onClick={()=>setPurgeStage("impact")}>返回</RareButton>
       <MicroHoldToDelete label="确认永久删除" tone="danger" disabled={busy} onConfirm={confirmPurge}/></>}
   </div>
  </Dialog>}
 </>;
}
