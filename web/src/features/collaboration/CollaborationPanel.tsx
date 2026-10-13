import {RareButton,RareInput} from "../../shared/ui/rare";
import {toast} from "../../shared/ui/feedback";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {observeWorkspaceChange} from "../../shared/resourceSync";
import {useEffect,useMemo,useRef,useState} from "react";
import {CollaborationBrowser} from "./CollaborationBrowser";
import {readExplorerViewMode,saveExplorerViewMode,type ExplorerViewMode} from "../../shared/ui/ExplorerView";
import {collaborationApi,type Favorite,type Share} from "./api";
import {ShareDialog,type ShareResource} from "./ShareDialog";
import {errorCode,errorCopy} from "../../shared/errors";
import {Dialog} from "../../shared/ui/Dialog";
import type {FileItem} from "../../entities/file/model";
import type {Folder} from "../../entities/folder/model";
import {FileResourceIcon,FolderResourceIcon} from "../../shared/ui/ResourceIcons";
import "./collaborationLayout.css";

// Progressive directory rendering over the authorized tree: every row remains
// reachable by scrolling through pages or filtering, without a silent cut-off.
const PICKER_PAGE=100;

type PickRow={folder:Folder;depth:number;path:string};

// Sharing workbench: received shares, sent shares and per-user favorites, plus
// the resource a share or a favorite is created for (COMPLEX-WORKFLOWS-v1 §9,
// WF-21/WF-23). The resource set is the user's favorites plus an in-panel picker
// over the visible folder tree and the files of a chosen folder, so both the
// 分享 and the 关注 entry act on one explicitly chosen file or folder. Every
// write is submitted to the server, which stays the authority on recipients,
// actions and expiry.
type CollaborationTab="received"|"sent"|"favorites";
export function CollaborationPanel({embedded=false,activeTab,onSelectTab,onChanged,viewMode,onViewModeChange}:{
 embedded?:boolean;activeTab?:CollaborationTab;onSelectTab?:(tab:CollaborationTab)=>void;onChanged?:()=>void;
 viewMode?:ExplorerViewMode;onViewModeChange?:(mode:ExplorerViewMode)=>void;
}){
 const[localTab,setLocalTab]=useState<CollaborationTab>("favorites");
 const tab=activeTab??localTab;
 const setTab=(next:CollaborationTab)=>{if(onSelectTab)onSelectTab(next);else setLocalTab(next);};
 const[localViewMode,setLocalViewMode]=useState<ExplorerViewMode>(readExplorerViewMode);
 const displayMode=viewMode??localViewMode;
 const setDisplayMode=(mode:ExplorerViewMode)=>{
  if(onViewModeChange)onViewModeChange(mode);
  else{setLocalViewMode(mode);saveExplorerViewMode(mode);}
 };
 const[pickerOpen,setPickerOpen]=useState(!embedded);
 const[shares,setShares]=useState<Share[]>([]);
 const[favorites,setFavorites]=useState<Favorite[]>([]);
 const[status,setStatus]=useState("loading");
 const[nextCursor,setNextCursor]=useState("");
 const[moreStatus,setMoreStatus]=useState<"idle"|"loading"|"failed">("idle");
 const pageEpoch=useRef(0);
 const pageBusy=useRef(false);
 const[folderShownLimit,setFolderShownLimit]=useState(PICKER_PAGE);
 const[expandedFolders,setExpandedFolders]=useState<Set<string>>(()=>new Set());
 const[fileCursor,setFileCursor]=useState("");
 const[fileMoreState,setFileMoreState]=useState<"idle"|"loading"|"failed">("idle");
 const fileEpoch=useRef(0);
 const fileBusy=useRef(false);
 // Write revision: a successful create/revoke/favorite reloads the active list
 // even when the same result text is announced twice in a row.
 const[revision,setRevision]=useState(0);
 useEffect(()=>observeWorkspaceChange(()=>{
  setRevision(n=>n+1);
  setTreeToken(n=>n+1);
 },["collaboration","permissions","file","folder"]),[]);
 const[shareTarget,setShareTarget]=useState<ShareResource|null>(null);
 const[folders,setFolders]=useState<Folder[]>([]);
 const[treeState,setTreeState]=useState<"loading"|"ready"|"failed">("loading");
 const[treeToken,setTreeToken]=useState(0);
 const[pickKind,setPickKind]=useState<"folder"|"file">("folder");
 const[filter,setFilter]=useState("");
 // Candidate folder for the 目录 kind; the folder being browsed for the 文件 kind.
 const[folderId,setFolderId]=useState("");
 const[files,setFiles]=useState<FileItem[]>([]);
 const[filesState,setFilesState]=useState<"idle"|"loading"|"ready"|"failed">("idle");
 const[fileId,setFileId]=useState("");
 const[pickBusy,setPickBusy]=useState(false);
 // The share awaiting explicit revocation confirmation; the write is mutually
 // excluded through revokeBusy and blocks closing while it is in flight.
 const[revokeTarget,setRevokeTarget]=useState<Share|null>(null);
 const[revokeBusy,setRevokeBusy]=useState(false);
 const[revokeMessage,setRevokeMessage]=useState("");

 useEffect(()=>{
  let valid=true;
  const epoch=++pageEpoch.current;
  pageBusy.current=false;
  setStatus("loading");setNextCursor("");setMoreStatus("idle");
  if(tab==="favorites"){
   collaborationApi.favoritesPage()
    .then(page=>{if(valid&&epoch===pageEpoch.current){setFavorites(page.items);setNextCursor(page.nextCursor);setStatus("ready");}})
    .catch(()=>{if(valid&&epoch===pageEpoch.current)setStatus("failed");});
  }else{
   collaborationApi.sharesPage(tab)
    .then(page=>{if(valid&&epoch===pageEpoch.current){setShares(page.items);setNextCursor(page.nextCursor);setStatus("ready");}})
    .catch(()=>{if(valid&&epoch===pageEpoch.current)setStatus("failed");});
  }
  return()=>{valid=false;pageEpoch.current++;};
 },[tab,revision]);

 async function loadMore(){
  if(!nextCursor||pageBusy.current||status!=="ready")return;
  const cursor=nextCursor,epoch=pageEpoch.current,activeTab=tab;
  pageBusy.current=true;setMoreStatus("loading");
  try{
   if(activeTab==="favorites"){
    const page=await collaborationApi.favoritesPage(cursor);
    if(epoch!==pageEpoch.current)return;
    setFavorites(old=>{const seen=new Set(old.map(f=>f.id));return old.concat(page.items.filter(f=>!seen.has(f.id)));});
    setNextCursor(page.nextCursor);
   }else{
    const page=await collaborationApi.sharesPage(activeTab,cursor);
    if(epoch!==pageEpoch.current)return;
    setShares(old=>{const seen=new Set(old.map(f=>f.id));return old.concat(page.items.filter(f=>!seen.has(f.id)));});
    setNextCursor(page.nextCursor);
   }
   setMoreStatus("idle");
  }catch{if(epoch===pageEpoch.current)setMoreStatus("failed");}
  finally{if(epoch===pageEpoch.current)pageBusy.current=false;}
 }

 // The visible tree is read through the shared client so this feature stays
 // independent of the folders module (the architecture gate forbids
 // features/collaboration -> features/folders), exactly as RestoreDialog does.
 // It is loaded lazily: only the resource picker needs it.
 useEffect(()=>{
  if(tab!=="favorites")return;
  let valid=true;
  setTreeState("loading");
  collaborationApi.folderTree()
   .then(data=>{if(valid){setFolders(data);setTreeState("ready");}})
   .catch(()=>{if(valid)setTreeState("failed");});
  return()=>{valid=false;};
 },[tab,treeToken]);

 // The files of the selected folder are only read for the 文件 kind: in 目录
 // mode the same tree selection is the resource itself.
 useEffect(()=>{
  if(pickKind!=="file"||folderId===""){
   setFiles([]);setFilesState("idle");
   return;
  }
  let valid=true;
  setFiles([]);setFilesState("loading");
  const epoch=++fileEpoch.current;
  fileBusy.current=false;setFileCursor("");setFileMoreState("idle");
  collaborationApi.folderFiles(folderId)
   .then(page=>{if(valid&&epoch===fileEpoch.current){setFiles(page.items);setFileCursor(page.nextCursor);setFilesState("ready");}})
   .catch(()=>{if(valid&&epoch===fileEpoch.current){setFiles([]);setFilesState("failed");}});
  return()=>{valid=false;fileEpoch.current++;};
 },[folderId,pickKind]);

 async function loadFilesMore(){
  if(pickKind!=="file"||!folderId||!fileCursor||fileBusy.current||filesState!=="ready")return;
  fileBusy.current=true;const epoch=fileEpoch.current,cursor=fileCursor;
  setFileMoreState("loading");
  try{
   const page=await collaborationApi.folderFiles(folderId,cursor);
   if(epoch!==fileEpoch.current)return;
   setFiles(old=>{const seen=new Set(old.map(f=>f.id));return old.concat(page.items.filter(f=>!seen.has(f.id)));});
   setFileCursor(page.nextCursor);setFileMoreState("idle");
  }catch{if(epoch===fileEpoch.current)setFileMoreState("failed");}
  finally{if(epoch===fileEpoch.current)fileBusy.current=false;}
 }

 // Flat order with depth from visible parents only: a folder whose parent is
 // outside the visible set renders as a root, and hidden ancestors are never
 // invented.
 const rows=useMemo<PickRow[]>(()=>{
  const byId=new Map(folders.map(folder=>[folder.id,folder]));
  const childrenOf=new Map<string,Folder[]>();
  for(const folder of folders){
   const key=folder.parentId!==null&&byId.has(folder.parentId)?folder.parentId:"";
   const list=childrenOf.get(key);
   if(list)list.push(folder);else childrenOf.set(key,[folder]);
  }
  const chainOf=(id:string)=>{
   const chain:Folder[]=[];
   const seen=new Set<string>();
   let current=byId.get(id);
   while(current&&!seen.has(current.id)){
    seen.add(current.id);
    chain.unshift(current);
    current=current.parentId!==null?byId.get(current.parentId):undefined;
   }
   return chain;
  };
  const out:PickRow[]=[];
  const pending=(childrenOf.get("")??[]).slice().reverse().map(folder=>({folder,depth:0}));
  const visited=new Set<string>();
  while(pending.length){
   const next=pending.pop()!;
   if(visited.has(next.folder.id))continue;
   visited.add(next.folder.id);
   out.push({folder:next.folder,depth:next.depth,path:chainOf(next.folder.id).map(item=>item.name).join(" / ")});
   for(const child of (childrenOf.get(next.folder.id)??[]).slice().reverse()){
    pending.push({folder:child,depth:next.depth+1});
   }
  }
  return out;
 },[folders]);

 // Build the accessible hierarchy once. Orphans are visible roots; no hidden
 // parent is invented. Default to roots expanded, children independently fold.
 const byFolderId=useMemo(()=>new Map(folders.map(folder=>[folder.id,folder])),[folders]);
 const childCounts=useMemo(()=>{
  const counts=new Map<string,number>();
  for(const folder of folders){
   if(folder.parentId!==null&&byFolderId.has(folder.parentId))
    counts.set(folder.parentId,(counts.get(folder.parentId)??0)+1);
  }
  return counts;
 },[folders,byFolderId]);
 useEffect(()=>{
  setExpandedFolders(new Set(folders.filter(folder=>folder.parentId===null||!byFolderId.has(folder.parentId)).map(folder=>folder.id)));
 },[folders,byFolderId]);
 const keyword=filter.trim().toLowerCase();
 useEffect(()=>{setFolderShownLimit(PICKER_PAGE);},[filter]);
 // Searching keeps each matching folder's visible ancestor chain. Outside
 // search, descendants appear only under an explicitly expanded parent.
 const matchingFolders=useMemo(()=>{
  if(keyword!==""){
   const visible=new Set<string>();
   for(const row of rows){
    if(!row.path.toLowerCase().includes(keyword))continue;
    let current:Folder|undefined=row.folder;
    const seen=new Set<string>();
    while(current&&!seen.has(current.id)){
     seen.add(current.id);visible.add(current.id);
     current=current.parentId!==null?byFolderId.get(current.parentId):undefined;
    }
   }
   return rows.filter(row=>visible.has(row.folder.id));
  }
  return rows.filter(row=>{
   let parentId=row.folder.parentId;
   const seen=new Set<string>();
   while(parentId!==null&&byFolderId.has(parentId)){
    if(seen.has(parentId)||!expandedFolders.has(parentId))return false;
    seen.add(parentId);
    parentId=byFolderId.get(parentId)!.parentId;
   }
   return true;
  });
 },[rows,keyword,expandedFolders,byFolderId]);
 const shownFolders=matchingFolders.slice(0,folderShownLimit);
 const browseFolder=folders.find(folder=>folder.id===folderId);
 const chosenFile=files.find(file=>file.id===fileId);
 const chosen:ShareResource|null=pickKind==="folder"
  ?(browseFolder?{kind:"folder",id:browseFolder.id,name:browseFolder.name}:null)
  :(chosenFile?{kind:"file",id:chosenFile.id,name:chosenFile.name}:null);

 // Favorited state for the chosen resource: the picker never offers a second
 // write for something already in the favorites list.
 const favoriteKeys=useMemo(()=>{
  const keys=new Set<string>();
  for(const favorite of favorites){
   const id=favorite.kind==="file"?favorite.fileId:favorite.folderId;
   if(id)keys.add(favorite.kind+":"+id);
  }
  return keys;
 },[favorites]);
 const chosenFavorited=chosen!==null&&favoriteKeys.has(chosen.kind+":"+chosen.id);

 function say(text:string,tone:"info"|"error"|"warning"="info"){
  if(text.trim())(tone==="error"?toast.error:tone==="warning"?toast.warning:toast.success)(text);
 }

 function refresh(){
  setRevision(value=>value+1);
 }

 function openCreate(){
  setTab("favorites");
 }

 function pickFolder(id:string){
  setFolderId(id);
  setFileId("");
  setExpandedFolders(old=>{
   const next=new Set(old);
   let parentId=byFolderId.get(id)?.parentId;
   const seen=new Set<string>();
   while(parentId!==null&&parentId!==undefined&&!seen.has(parentId)){
    seen.add(parentId);next.add(parentId);
    parentId=byFolderId.get(parentId)?.parentId;
   }
   return next;
  });
 }
 function toggleFolder(id:string){
  // A search chevron switches to browsing that branch of the real tree.
  if(keyword)setFilter("");
  setExpandedFolders(old=>{
   const next=new Set(old);
   if(next.has(id))next.delete(id);else next.add(id);
   return next;
  });
 }

 async function unfavorite(id:string,kind:string){
  try{
   await collaborationApi.setFavorite(kind,id,false);
   say("已取消关注");
   onChanged?.();
   refresh();
  }catch(error){say(errorCode(error)==="E_NETWORK"?"网络中断，取消关注结果未确认；请刷新列表核对":errorCopy(error,"操作失败"),errorCode(error)==="E_NETWORK"?"warning":"error");}
 }

 function askRevoke(share:Share){
  setRevokeMessage("");
  setRevokeTarget(share);
 }

 // The confirmation dialog is the only caller. The revocation commits first and
 // the panel then re-reads the active list (the revision mechanism below), so
 // the next request already excludes the revoked share instead of reusing a
 // stale in-memory row (WF-22).
 async function confirmRevoke(){
  const share=revokeTarget;
  if(!share||revokeBusy)return;
  setRevokeBusy(true);setRevokeMessage("");
  try{
   await collaborationApi.revokeShare(share.id);
  }catch(error){
   if(errorCode(error)==="E_NETWORK"){
    setRevokeTarget(null);
    say("网络中断，撤销分享结果未确认；请刷新分享列表核对","warning");
    refresh();
   }else setRevokeMessage(errorCopy(error,"撤销失败"));
   setRevokeBusy(false);
   return;
  }
  setRevokeTarget(null);
  say("已撤销分享");
  onChanged?.();
  refresh();
  setRevokeBusy(false);
 }

 async function favoriteChosen(){
  const target=chosen;
  if(!target||pickBusy)return;
  setPickBusy(true);
  try{
   await collaborationApi.setFavorite(target.kind,target.id,true);
   say(`已关注「${target.name}」`);
   onChanged?.();
   refresh();
  }catch(error){
    say(errorCode(error)==="E_NETWORK"?"网络中断，关注结果未确认；请刷新列表核对":errorCopy(error,"关注失败"),errorCode(error)==="E_NETWORK"?"warning":"error");
  }finally{
   setPickBusy(false);
  }
 }

 function shareFavorite(favorite:Favorite){
  const id=favorite.kind==="file"?favorite.fileId:favorite.folderId;
  if(!id||favorite.unavailable)return;
  setShareTarget({kind:favorite.kind,id,name:favorite.resourceName});
 }

 function createdShare(){
  setShareTarget(null);
  say("已创建分享");
  onChanged?.();
  setTab("sent");
  refresh();
 }

 function toggleCreate(){
  if(tab==="favorites")setPickerOpen(value=>!value);
  else{setPickerOpen(true);openCreate();}
 }

 return <div className={"work-body collab-root"+(embedded?" is-embedded":"")}>
  {!embedded&&<div className="toolbar collab-tabs"><div className="collab-tablist" role="tablist" aria-label="共享与关注">
   <RareButton type="button" role="tab" aria-selected={tab==="favorites"} className={tab==="favorites"?"on":""} onClick={()=>setTab("favorites")}>关注</RareButton>
   <RareButton type="button" role="tab" aria-selected={tab==="received"} className={tab==="received"?"on":""} onClick={()=>setTab("received")}>与我共享</RareButton>
   <RareButton type="button" role="tab" aria-selected={tab==="sent"} className={tab==="sent"?"on":""} onClick={()=>setTab("sent")}>我共享的</RareButton>
   </div>
  </div>}
  <div className={"collab-workspace"+(tab==="favorites"&&pickerOpen?" with-picker":"")}>
  {tab==="favorites"&&pickerOpen&&<section className={"share-workbench"+(pickKind==="file"?" is-file-mode":"")} aria-label="选择关注或分享资源">
   <div className="share-workbench-head"><h3>选择资源</h3></div>
   {treeState==="loading"&&<p className="hint"><BrandLoadingLabel>正在读取目录…</BrandLoadingLabel></p>}
   {treeState==="failed"&&<>
    <p role="alert" className="notice error">获取目录失败，请稍后重试。</p>
    <RareButton type="button" className="secondary-action" disabled={pickBusy} onClick={()=>setTreeToken(token=>token+1)}>重试</RareButton>
   </>}
   {treeState==="ready"&&<>
    <div className="share-kind-switch" role="group" aria-label="资源类型">
     <RareButton type="button" className={pickKind==="folder"?"on":""} aria-pressed={pickKind==="folder"} disabled={pickBusy}
      onClick={()=>{setPickKind("folder");setFileId("");}}>目录</RareButton>
     <RareButton type="button" className={pickKind==="file"?"on":""} aria-pressed={pickKind==="file"} disabled={pickBusy}
      onClick={()=>{setPickKind("file");setFileId("");}}>文件</RareButton>
    </div>
    <label htmlFor="share-picker-filter" className="share-picker-label">{pickKind==="folder"?"目录":"文件所在目录"}</label>
    <RareInput id="share-picker-filter" type="search" value={filter} placeholder="按名称或可见路径筛选"
     autoComplete="off" disabled={pickBusy} onChange={event=>setFilter(event.target.value)}/>
    {rows.length===0
     ?<p className="share-list-empty">当前账号没有可访问的目录。</p>
     :<div role="radiogroup" aria-label={pickKind==="folder"?"选择目录":"选择文件所在目录"} className="share-picker-list share-folder-tree">
      {shownFolders.length===0&&<p className="share-list-empty">没有匹配的目录。</p>}
      {shownFolders.map(row=>{
       const hasChildren=(childCounts.get(row.folder.id)??0)>0;
       const isOpen=keyword!==""||expandedFolders.has(row.folder.id);
       const isSelected=folderId===row.folder.id;
       return <div className="share-tree-entry" key={row.folder.id}
        style={{paddingInlineStart:String(4+Math.min(row.depth,8)*18)+"px"}}>
        {hasChildren
         ?<RareButton type="button" className="share-tree-expander" disabled={pickBusy}
           aria-label={isOpen?`折叠 ${row.folder.name}`:`展开 ${row.folder.name}`}
           aria-expanded={isOpen} onClick={()=>toggleFolder(row.folder.id)}>
           <svg viewBox="0 0 16 16" aria-hidden="true"><path d={isOpen?"m4.5 6 3.5 3.5L11.5 6":"m6 4.5 3.5 3.5L6 11.5"}/></svg>
          </RareButton>
         :<span className="share-tree-expander-spacer" aria-hidden="true"/>}
        <RareButton type="button" role="radio" aria-checked={isSelected}
         className={"share-picker-row"+(isSelected?" on":"")} disabled={pickBusy}
         title={row.path} onClick={()=>pickFolder(row.folder.id)}>
         <FolderResourceIcon open={isOpen&&hasChildren} size={16}/>
         <span className="share-option-name">{row.folder.name}</span>
         {isSelected&&<span className="share-picker-check" aria-hidden="true">✓</span>}
        </RareButton>
       </div>;
      })}
     </div>}
    {matchingFolders.length>folderShownLimit&&<RareButton type="button" className="secondary-action" disabled={pickBusy} onClick={()=>setFolderShownLimit(n=>n+PICKER_PAGE)}>加载更多目录（已显示 {shownFolders.length}/{matchingFolders.length}）</RareButton>}
    {pickKind==="file"&&<>
     {folderId===""&&<p className="hint">请先选择文件所在的目录。</p>}
     {filesState==="loading"&&<p className="hint"><BrandLoadingLabel>正在读取文件…</BrandLoadingLabel></p>}
     {filesState==="failed"&&<p role="alert" className="notice error">获取文件失败，请重新选择目录或稍后重试。</p>}
     {filesState==="ready"&&files.length>0&&<p className="hint">目录「{browseFolder?.name??folderId}」 · 已显示 {files.length} 个文件</p>}
     {filesState==="ready"&&files.length===0&&<p className="share-list-empty">该目录没有文件。</p>}
     {filesState==="ready"&&files.length>0&&<div role="radiogroup" aria-label="选择文件" className="share-picker-list">
      {files.map(file=><RareButton key={file.id} type="button" role="radio" aria-checked={fileId===file.id}
       className={"share-picker-row"+(fileId===file.id?" on":"")} disabled={pickBusy}
       onClick={()=>setFileId(file.id)}>
       <FileResourceIcon name={file.name} size={18}/>
       <span className="share-option-name" title={file.name}>{file.name}</span>
       <span className="share-option-detail">{file.updatedAt.replace("T"," ").slice(0,16)}</span>{fileId===file.id&&<span className="share-picker-check" aria-hidden="true">✓</span>}
      </RareButton>)}
     </div>}
     {fileCursor&&filesState==="ready"&&<RareButton type="button" className="secondary-action" disabled={fileMoreState==="loading"||pickBusy} onClick={()=>void loadFilesMore()}>{fileMoreState==="loading"?"加载中…":fileMoreState==="failed"?"重试加载文件":"加载更多文件"}</RareButton>}
     {fileMoreState==="failed"&&<span role="alert" className="hint">后续文件读取失败，已加载的文件仍可选择。</span>}
    </>}
    <p className="share-chosen" aria-live="polite"><span>已选：</span>
     {chosen===null?<span className="share-chosen-none">无</span>:<strong title={chosen.name}>{chosen.name}</strong>}
    </p>
    <div className="share-workbench-actions">
     <RareButton type="button" className="secondary-action" disabled={pickBusy||chosen===null}
      onClick={()=>{setFileId("");setFolderId("");}}>清除选择</RareButton>
     <RareButton type="button" disabled={pickBusy||chosen===null||chosenFavorited} onClick={favoriteChosen}>
      {chosenFavorited?"已关注":"关注"}
     </RareButton>
     <RareButton type="button" className="primary" disabled={pickBusy||chosen===null}
      onClick={()=>{if(chosen)setShareTarget(chosen);}}>分享…</RareButton>
    </div>
   </>}
  </section>}
  <CollaborationBrowser tab={tab} favorites={favorites} shares={shares} status={status}
   nextCursor={nextCursor} moreStatus={moreStatus} viewMode={displayMode}
   onViewModeChange={setDisplayMode} pickerOpen={pickerOpen} onCreate={toggleCreate}
   onRefresh={refresh} onLoadMore={()=>void loadMore()} onShareFavorite={shareFavorite}
   onUnfavorite={(id,kind)=>void unfavorite(id,kind)} onRevoke={askRevoke}/>
  </div>
  {shareTarget&&<ShareDialog resource={shareTarget} onClose={()=>setShareTarget(null)} onCreated={createdShare}/>}
  {revokeTarget&&<Dialog open title="撤销分享确认" onClose={()=>setRevokeTarget(null)} closeGuard={()=>!revokeBusy} className="dialog">
   <p className="hint">撤销后该分享立即失效；下一次列表与搜索读取不会返回基于该分享的内容，最终授权仍由服务端判定。</p>
   <p>资源：{revokeTarget.resourceKind==="file"?"文件":"目录"}「{revokeTarget.resourceName}」</p>
   <p>接收方：{revokeTarget.recipientKind==="user"?"用户":"工作组"}「{revokeTarget.recipientName||revokeTarget.recipientId}」</p>
   <p>权限：{revokeTarget.actions.join("、")}</p>
   <p>继承子目录：{revokeTarget.includeDescendants?"是":"否"}；截止：{revokeTarget.expiresAt?revokeTarget.expiresAt.slice(0,10):"长期"}</p>
   {revokeMessage&&<p role="alert" className="notice error">{revokeMessage}</p>}
   <div className="dialog-actions">
    <RareButton type="button" className="secondary-action" onClick={()=>setRevokeTarget(null)} disabled={revokeBusy}>取消</RareButton>
    <RareButton type="button" className="danger" onClick={confirmRevoke} disabled={revokeBusy}>{revokeBusy?"撤销中…":"确认撤销"}</RareButton>
   </div>
  </Dialog>}
 </div>;
}
