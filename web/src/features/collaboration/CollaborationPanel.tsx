import {useEffect,useMemo,useState} from "react";
import {Link} from "react-router-dom";
import {collaborationApi,formatBytes,type Favorite,type Share} from "./api";
import {ShareDialog,type ShareResource} from "./ShareDialog";
import {errorCopy} from "../../shared/errors";
import {Dialog} from "../../shared/ui/Dialog";
import type {FileItem} from "../../entities/file/model";
import type {Folder} from "../../entities/folder/model";

// Bounded page over the loaded folder tree; the filter narrows the remainder
// instead of rendering an unbounded list (DESKTOP-INTERACTION-v1 §5/§9).
const PICKER_PAGE=100;
const MAX_DEPTH=32;

type PickRow={folder:Folder;depth:number;path:string};

// Sharing workbench: received shares, sent shares and per-user favorites, plus
// the resource a share or a favorite is created for (COMPLEX-WORKFLOWS-v1 §9,
// WF-21/WF-23). The resource set is the user's favorites plus an in-panel picker
// over the visible folder tree and the files of a chosen folder, so both the
// 分享 and the 关注 entry act on one explicitly chosen file or folder. Every
// write is submitted to the server, which stays the authority on recipients,
// actions and expiry.
export function CollaborationPanel(){
 const[tab,setTab]=useState<"received"|"sent"|"favorites">("received");
 const[shares,setShares]=useState<Share[]>([]);
 const[favorites,setFavorites]=useState<Favorite[]>([]);
 const[status,setStatus]=useState("loading");
 const[message,setMessage]=useState("");
 const[messageTone,setMessageTone]=useState<"info"|"error">("info");
 // Write revision: a successful create/revoke/favorite reloads the active list
 // even when the same result text is announced twice in a row.
 const[revision,setRevision]=useState(0);
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
  setStatus("loading");
  if(tab==="favorites"){
   collaborationApi.favorites()
    .then(data=>{if(valid){setFavorites(data);setStatus("ready");}})
    .catch(()=>{if(valid)setStatus("failed");});
  }else{
   collaborationApi.shares(tab)
    .then(data=>{if(valid){setShares(data);setStatus("ready");}})
    .catch(()=>{if(valid)setStatus("failed");});
  }
  return()=>{valid=false;};
 },[tab,revision]);

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
  collaborationApi.folderFiles(folderId)
   .then(page=>{if(valid){setFiles(page.items);setFilesState("ready");}})
   .catch(()=>{if(valid){setFiles([]);setFilesState("failed");}});
  return()=>{valid=false;};
 },[folderId,pickKind]);

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
  const walk=(parentId:string,depth:number)=>{
   if(depth>MAX_DEPTH)return;
   for(const folder of childrenOf.get(parentId)??[]){
    out.push({folder,depth,path:chainOf(folder.id).map(item=>item.name).join(" / ")});
    walk(folder.id,depth+1);
   }
  };
  walk("",0);
  return out;
 },[folders]);

 const keyword=filter.trim().toLowerCase();
 const shownFolders=(keyword===""?rows:rows.filter(row=>row.path.toLowerCase().includes(keyword))).slice(0,PICKER_PAGE);
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

 function say(text:string,tone:"info"|"error"="info"){
  setMessage(text);
  setMessageTone(tone);
 }

 function refresh(){
  setRevision(value=>value+1);
 }

 function openCreate(){
  setTab("favorites");
  say("请在上方选择要分享的资源（目录或文件），然后点击「分享」。");
 }

 function pickFolder(id:string){
  setFolderId(id);
  setFileId("");
 }

 async function unfavorite(id:string,kind:string){
  setMessage("");
  try{
   await collaborationApi.setFavorite(kind,id,false);
   say("已取消关注");
   refresh();
  }catch(error){say(errorCopy(error,"操作失败"),"error");}
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
   setRevokeMessage(errorCopy(error,"撤销失败"));
   setRevokeBusy(false);
   return;
  }
  setRevokeTarget(null);
  say("已撤销分享");
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
   refresh();
  }catch(error){
   say(errorCopy(error,"关注失败"),"error");
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
  setTab("sent");
  refresh();
 }

 return <div className="work-body">
  <div className="toolbar">
   <button type="button" className={tab==="received"?"on":""} onClick={()=>setTab("received")}>与我共享</button>
   <button type="button" className={tab==="sent"?"on":""} onClick={()=>setTab("sent")}>我共享的</button>
   <button type="button" className={tab==="favorites"?"on":""} onClick={()=>setTab("favorites")}>我的关注</button>
   <button type="button" className="primary" onClick={openCreate}>创建分享</button>
   <span className="toolbar-hint">分享仅传递 查看列表/预览/下载，不含写操作</span>
  </div>
  {message&&<p role="status" className={"notice"+(messageTone==="error"?" error":"")}>{message}</p>}
  {tab==="favorites"&&<section className="share-workbench" aria-label="创建分享或关注">
   <div className="share-workbench-head">
    <h3>创建分享 / 关注</h3>
    <p className="hint">选择「目录」或「文件」，或直接使用下方关注列表的「分享」。前端列表只作提示，最终授权由服务端判定。</p>
   </div>
   {treeState==="loading"&&<p className="hint">正在读取目录…</p>}
   {treeState==="failed"&&<>
    <p role="alert" className="notice error">获取目录失败，请稍后重试。</p>
    <button type="button" className="secondary-action" disabled={pickBusy} onClick={()=>setTreeToken(token=>token+1)}>重试</button>
   </>}
   {treeState==="ready"&&<>
    <div className="share-kind-switch" role="group" aria-label="资源类型">
     <button type="button" className={pickKind==="folder"?"on":""} aria-pressed={pickKind==="folder"} disabled={pickBusy}
      onClick={()=>{setPickKind("folder");setFileId("");}}>目录</button>
     <button type="button" className={pickKind==="file"?"on":""} aria-pressed={pickKind==="file"} disabled={pickBusy}
      onClick={()=>{setPickKind("file");setFileId("");}}>文件</button>
    </div>
    <label htmlFor="share-picker-filter">{pickKind==="folder"?"选择目录":"选择文件所在目录"}</label>
    <input id="share-picker-filter" type="search" value={filter} placeholder="按名称或可见路径筛选"
     autoComplete="off" disabled={pickBusy} onChange={event=>setFilter(event.target.value)}/>
    {rows.length===0
     ?<p className="share-list-empty">当前账号没有可访问的目录。</p>
     :<div role="radiogroup" aria-label={pickKind==="folder"?"选择目录":"选择文件所在目录"} className="share-picker-list">
      {shownFolders.length===0&&<p className="share-list-empty">没有匹配的目录。</p>}
      {shownFolders.map(row=><button key={row.folder.id} type="button" role="radio"
       aria-checked={folderId===row.folder.id}
       className={"share-picker-row"+(folderId===row.folder.id?" on":"")}
       style={{paddingLeft:String(8+Math.min(row.depth,8)*14)+"px"}} disabled={pickBusy}
       title={row.path} onClick={()=>pickFolder(row.folder.id)}>{row.folder.name}</button>)}
     </div>}
    {rows.length>PICKER_PAGE&&keyword===""&&<p className="hint">目录较多，仅显示前 {PICKER_PAGE} 个，请先按名称筛选。</p>}
    {pickKind==="file"&&<>
     {folderId===""&&<p className="hint">请先选择文件所在的目录。</p>}
     {filesState==="loading"&&<p className="hint">正在读取文件…</p>}
     {filesState==="failed"&&<p role="alert" className="notice error">获取文件失败，请重新选择目录或稍后重试。</p>}
     {filesState==="ready"&&files.length>0&&<p className="hint">目录「{browseFolder?.name??folderId}」中的文件（最多显示 50 个）。</p>}
     {filesState==="ready"&&files.length===0&&<p className="share-list-empty">该目录没有文件。</p>}
     {filesState==="ready"&&files.length>0&&<div role="radiogroup" aria-label="选择文件" className="share-picker-list">
      {files.map(file=><button key={file.id} type="button" role="radio" aria-checked={fileId===file.id}
       className={"share-picker-row"+(fileId===file.id?" on":"")} disabled={pickBusy}
       onClick={()=>setFileId(file.id)}>
       <span className="share-option-kind">文件</span>
       <span className="share-option-name" title={file.name}>{file.name}</span>
       <span className="share-option-detail">{file.updatedAt.replace("T"," ").slice(0,16)}</span>
      </button>)}
     </div>}
    </>}
    <p className="share-chosen" aria-live="polite">已选资源：
     {chosen===null
      ?<span className="share-chosen-none">尚未选择</span>
      :<strong>{chosen.name}</strong>}
     {chosen!==null&&<span className="share-chosen-none">（{chosen.kind==="file"?"文件":"目录"}）</span>}
    </p>
    <div className="share-workbench-actions">
     <button type="button" className="secondary-action" disabled={pickBusy||chosen===null}
      onClick={()=>{setFileId("");setFolderId("");}}>清除选择</button>
     <button type="button" disabled={pickBusy||chosen===null||chosenFavorited} onClick={favoriteChosen}>
      {chosenFavorited?"已关注":"关注"}
     </button>
     <button type="button" className="primary" disabled={pickBusy||chosen===null}
      onClick={()=>{if(chosen)setShareTarget(chosen);}}>分享…</button>
    </div>
   </>}
  </section>}
  <div className="table">
   {tab==="favorites"?<table>
    <thead><tr><th scope="col">资源</th><th scope="col">类型</th><th scope="col">状态</th><th scope="col">关注时间</th><th scope="col">操作</th></tr></thead>
    <tbody>
     {status==="loading"&&<tr><td colSpan={5} className="empty">正在加载…</td></tr>}
     {status==="failed"&&<tr><td colSpan={5} className="empty" role="alert">获取关注列表失败，请刷新重试。</td></tr>}
     {status==="ready"&&favorites.length===0&&<tr><td colSpan={5} className="empty">没有关注内容。</td></tr>}
     {status==="ready"&&favorites.map(f=><tr key={f.id}>
      <td>{f.kind==="file"?<Link to={"/preview/"+f.fileId}>{f.resourceName}</Link>:<Link to={"/doc?folder="+f.folderId}>{f.resourceName}</Link>}</td>
      <td>{f.kind==="file"?"文件":"目录"}</td>
      <td>{f.unavailable?"已删除或不可访问":"正常"}</td>
      <td>{f.createdAt.replace("T"," ").slice(0,16)}</td>
      <td className="row-actions">
       <button type="button" disabled={f.unavailable}
        title={f.unavailable?"资源已删除或不可访问，无法分享":undefined}
        onClick={()=>shareFavorite(f)}>分享</button>
       <button type="button" onClick={()=>unfavorite(f.kind==="file"?f.fileId??"":f.folderId??"",f.kind)}>取消关注</button>
      </td>
     </tr>)}
    </tbody>
   </table>:<table>
    <thead><tr><th scope="col">资源</th><th scope="col">类型</th><th scope="col">接收方/来源</th><th scope="col">权限</th><th scope="col">继承子目录</th><th scope="col">截止</th><th scope="col">操作</th></tr></thead>
    <tbody>
     {status==="loading"&&<tr><td colSpan={7} className="empty">正在加载…</td></tr>}
     {status==="failed"&&<tr><td colSpan={7} className="empty" role="alert">获取分享列表失败，请刷新重试。</td></tr>}
     {status==="ready"&&shares.length===0&&<tr><td colSpan={7} className="empty">没有{tab==="received"?"收到的":"发出的"}分享。</td></tr>}
     {status==="ready"&&shares.map(s=><tr key={s.id}>
      <td>{s.resourceKind==="file"?<Link to={"/preview/"+s.resourceId}>{s.resourceName}</Link>:<Link to={"/doc?folder="+s.resourceId}>{s.resourceName}</Link>}</td>
      <td>{s.resourceKind==="file"?"文件":"目录"}</td>
      <td>{tab==="received"?s.recipientName:(s.recipientName||"—")}</td>
      <td>{s.actions.join("、")}</td>
      <td>{s.includeDescendants?"是":"否"}</td>
      <td>{s.expiresAt?s.expiresAt.slice(0,10):"长期"}</td>
      <td className="row-actions">{tab==="sent"&&!s.revoked&&<button type="button" className="danger" onClick={()=>askRevoke(s)}>撤销</button>}</td>
     </tr>)}
    </tbody>
   </table>}
  </div>
  <p className="hint">{formatBytes(0)==="0 B"?"":" "}统计与导出请前往「统计」页。</p>
  {shareTarget&&<ShareDialog resource={shareTarget} onClose={()=>setShareTarget(null)} onCreated={createdShare}/>}
  {revokeTarget&&<Dialog open title="撤销分享确认" onClose={()=>setRevokeTarget(null)} closeGuard={()=>!revokeBusy} className="dialog">
   <p className="hint">撤销后该分享立即失效；下一次列表与搜索读取不会返回基于该分享的内容，最终授权仍由服务端判定。</p>
   <p>资源：{revokeTarget.resourceKind==="file"?"文件":"目录"}「{revokeTarget.resourceName}」</p>
   <p>接收方：{revokeTarget.recipientKind==="user"?"用户":"工作组"}「{revokeTarget.recipientName||revokeTarget.recipientId}」</p>
   <p>权限：{revokeTarget.actions.join("、")}</p>
   <p>继承子目录：{revokeTarget.includeDescendants?"是":"否"}；截止：{revokeTarget.expiresAt?revokeTarget.expiresAt.slice(0,10):"长期"}</p>
   {revokeMessage&&<p role="alert" className="notice error">{revokeMessage}</p>}
   <div className="dialog-actions">
    <button type="button" className="secondary-action" onClick={()=>setRevokeTarget(null)} disabled={revokeBusy}>取消</button>
    <button type="button" className="danger" onClick={confirmRevoke} disabled={revokeBusy}>{revokeBusy?"撤销中…":"确认撤销"}</button>
   </div>
  </Dialog>}
 </div>;
}
