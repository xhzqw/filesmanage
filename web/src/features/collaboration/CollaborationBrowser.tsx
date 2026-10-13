import {useEffect,useMemo,useState} from "react";
import {Link,useNavigate} from "react-router-dom";
import {RareBadge,RareButton,RareDataTable,RareInput,RareRowActions,RareSelect} from "../../shared/ui/rare";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {FileResourceIcon,FolderResourceIcon} from "../../shared/ui/ResourceIcons";
import {EXPLORER_VIEWS,ExplorerViewGlyph,type ExplorerViewMode} from "../../shared/ui/ExplorerView";
import {Menu,type MenuItem} from "../../shared/ui/Menu";
import type {Favorite,Share} from "./api";

type Scope="favorites"|"received"|"sent";
type StateTone="success"|"warning"|"danger";
type ResourceEntry={
 key:string;kind:"file"|"folder";name:string;url:string|null;createdAt:string;
 status:string;tone:StateTone;description:string;permission:string;
 favorite?:Favorite;share?:Share;
};

/** A scoped resource browser, not a second administration table. All three
 * views share the same list/tiles, selection, sorting and command surfaces. */
export function CollaborationBrowser({tab,favorites,shares,status,nextCursor,moreStatus,viewMode,onViewModeChange,
 pickerOpen,onCreate,onRefresh,onLoadMore,onShareFavorite,onUnfavorite,onRevoke}:{
 tab:Scope;favorites:Favorite[];shares:Share[];status:string;nextCursor:string;
 moreStatus:"idle"|"loading"|"failed";viewMode:ExplorerViewMode;
 onViewModeChange:(mode:ExplorerViewMode)=>void;pickerOpen:boolean;
 onCreate:()=>void;onRefresh:()=>void;onLoadMore:()=>void;
 onShareFavorite:(favorite:Favorite)=>void;onUnfavorite:(id:string,kind:string)=>void;onRevoke:(share:Share)=>void;
}){
 const navigate=useNavigate();
 const[query,setQuery]=useState("");
 const[sort,setSort]=useState<"recent"|"oldest"|"name">("recent");
 const[selectedId,setSelectedId]=useState<string|null>(null);
 const[menu,setMenu]=useState<{id:string;anchor:HTMLElement}|null>(null);
 useEffect(()=>{setQuery("");setSelectedId(null);setMenu(null);},[tab]);
 const entries=useMemo<ResourceEntry[]>(()=>{
  if(tab==="favorites")return favorites.map((f):ResourceEntry=>{
   const resourceId=f.kind==="file"?f.fileId:f.folderId;
   return {
    key:f.id,kind:f.kind,name:f.resourceName||"不可访问的资源",
    url:!f.unavailable&&resourceId?(f.kind==="file"?"/preview/":"/doc?folder=")+encodeURIComponent(resourceId):null,
    createdAt:f.createdAt,status:f.unavailable?"已删除或不可访问":"可访问",
    tone:f.unavailable?"danger":"success",description:f.kind==="file"?"文件":"文件夹",
    permission:"",favorite:f
   };
  });
  return shares.map((s):ResourceEntry=>{
   const expired=Boolean(s.expiresAt&&Date.parse(s.expiresAt)<=Date.now());
   const unavailable=s.revoked||expired;
   return {
    key:s.id,kind:s.resourceKind,name:s.resourceName||"未命名资源",
    url:unavailable?null:(s.resourceKind==="file"?"/preview/":"/doc?folder=")+encodeURIComponent(s.resourceId),
    createdAt:s.createdAt,status:s.revoked?"已撤销":expired?"已过期":"有效",
    tone:s.revoked?"danger":expired?"warning":"success",
    description:tab==="sent"?(s.recipientName||"未命名接收方"):(s.resourceKind==="file"?"文件":"文件夹"),
    permission:s.actions.join("、")||"无",share:s
   };
  });
 },[tab,favorites,shares]);
 const visible=useMemo(()=>{
  const needle=query.trim().toLocaleLowerCase();
  const result=entries.filter(item=>!needle||[item.name,item.description,item.permission,item.status].some(text=>text.toLocaleLowerCase().includes(needle)));
  return result.sort((a,b)=>sort==="name"?a.name.localeCompare(b.name,"zh-CN"):sort==="oldest"?a.createdAt.localeCompare(b.createdAt):b.createdAt.localeCompare(a.createdAt));
 },[entries,query,sort]);
 const selected=visible.find(item=>item.key===selectedId)??visible[0]??null;
 const menuEntry=entries.find(item=>item.key===menu?.id);
 const menuItems:MenuItem[]=[];
 if(menuEntry){
  if(menuEntry.url)menuItems.push({id:"open",label:"打开",onSelect:()=>navigate(menuEntry.url!)});
  if(menuEntry.favorite){
   menuItems.push({id:"share",label:"分享",disabled:!menuEntry.url,onSelect:()=>onShareFavorite(menuEntry.favorite!)});
   menuItems.push({id:"unfavorite",label:"取消关注",onSelect:()=>onUnfavorite(menuEntry.kind==="file"?menuEntry.favorite?.fileId??"":menuEntry.favorite?.folderId??"",menuEntry.kind)});
  }
  if(tab==="sent"&&menuEntry.share&&!menuEntry.share.revoked)menuItems.push({id:"revoke",label:"撤销分享",danger:true,onSelect:()=>onRevoke(menuEntry.share!)});
 }
 const resourceIcon=(entry:ResourceEntry,size:number)=>entry.kind==="file"
  ?<FileResourceIcon name={entry.name} size={size}/>:<FolderResourceIcon size={size}/>;
 const actions=(entry:ResourceEntry)=> <RareRowActions className="collab-inline-actions">
  {entry.url&&<Link className="collab-action" to={entry.url}>打开</Link>}
  {entry.favorite&&<>
   <RareButton type="button" tone="ghost" className="collab-action" disabled={!entry.url}
    onClick={()=>onShareFavorite(entry.favorite!)}>分享</RareButton>
   <RareButton type="button" tone="ghost" className="collab-action"
    onClick={()=>onUnfavorite(entry.kind==="file"?entry.favorite?.fileId??"":entry.favorite?.folderId??"",entry.kind)}>取消关注</RareButton>
  </>}
  {tab==="sent"&&entry.share&&!entry.share.revoked&&<RareButton type="button" tone="danger" className="collab-action"
   onClick={()=>onRevoke(entry.share!)}>撤销</RareButton>}
 </RareRowActions>;
 const tile=(entry:ResourceEntry)=><div key={entry.key} className={"explorer-item collab-explorer-item"+(selected?.key===entry.key?" selected":"")}
  role="gridcell" tabIndex={0} aria-selected={selected?.key===entry.key}
  onClick={()=>setSelectedId(entry.key)}
  onDoubleClick={()=>{if(entry.url)navigate(entry.url);}}
  onKeyDown={event=>{if(event.key==="Enter"&&entry.url){event.preventDefault();navigate(entry.url);}}}>
  <div className="explorer-item-art">{resourceIcon(entry,48)}</div>
  {entry.url?<Link to={entry.url} className="explorer-item-name" onClick={event=>event.stopPropagation()}>{entry.name}</Link>
   :<span className="explorer-item-name collab-muted-name" title="资源不可访问">{entry.name}</span>}
  <span className="explorer-item-sub">{entry.description}</span>
  <div className="collab-tile-actions" onClick={event=>event.stopPropagation()}>{actions(entry)}</div>
 </div>;
 const detail=(entry:ResourceEntry)=><div className="collab-resource-detail">
  <div className="collab-detail-art">{resourceIcon(entry,66)}</div>
  <strong title={entry.name}>{entry.name}</strong>
  <RareBadge dot tone={entry.tone}>{entry.status}</RareBadge>
  <dl>
   <dt>类型</dt><dd>{entry.kind==="file"?"文件":"文件夹"}</dd>
   {tab==="sent"&&<><dt>接收方</dt><dd>{entry.description}</dd></>}
   {entry.share&&<><dt>权限</dt><dd>{entry.permission}</dd><dt>截止</dt><dd>{entry.share.expiresAt?.slice(0,10)||"长期"}</dd>
    <dt>子目录</dt><dd>{entry.share.includeDescendants?"包含":"不包含"}</dd></>}
   <dt>{tab==="favorites"?"关注时间":"分享时间"}</dt><dd>{entry.createdAt.replace("T"," ").slice(0,16)}</dd>
  </dl>
  {actions(entry)}
 </div>;
 const empty=status==="ready"&&visible.length===0;
 return <section className="collab-results" aria-label={tab==="favorites"?"我的关注":tab==="received"?"与我共享":"我共享的"}>
  <div className="collab-results-head">
   <strong className="sr-only">{tab==="favorites"?"我的关注":tab==="received"?"与我共享":"我共享的"}</strong>
   <RareButton type="button" className="primary collab-create-action" aria-expanded={tab==="favorites"&&pickerOpen}
    onClick={onCreate}>{tab==="favorites"?(pickerOpen?"收起选择":"添加关注 / 分享"):"创建分享"}</RareButton>
   <span className="collab-results-count" aria-live="polite">{status==="ready"?"已加载 "+entries.length+" 项"+(nextCursor?" · 还有更多":""):""}</span>
   <div className="collab-filter-controls">
    <RareInput type="search" aria-label="过滤当前已加载的关注与分享" placeholder="筛选名称…" value={query}
     onChange={event=>setQuery(event.target.value)}/>
    <RareSelect aria-label="资源排序" value={sort} onChange={event=>setSort(event.target.value as typeof sort)}>
     <option value="recent">最近添加</option><option value="oldest">最早添加</option><option value="name">名称</option>
    </RareSelect>
    <div className="folder-view-switch" role="group" aria-label="资源显示方式">
     {EXPLORER_VIEWS.map(mode=><RareButton type="button" key={mode.id} tone="ghost"
      aria-label={mode.label} title={mode.label} aria-pressed={viewMode===mode.id}
      onClick={()=>onViewModeChange(mode.id)}><ExplorerViewGlyph mode={mode.id}/></RareButton>)}
    </div>
    <RareButton type="button" tone="ghost" className="collab-refresh" aria-label="刷新资源" title="刷新资源" onClick={onRefresh}>
     <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.8 9a7 7 0 0 1 12.5-2L20 12M4 12l1.7 5a7 7 0 0 0 12.5-2"/></svg>
    </RareButton>
   </div>
  </div>
  <div className="collab-table-scroll">
   {viewMode==="list"&&<RareDataTable className={"collab-resource-table "+(tab==="favorites"?"collab-favorites-table":"collab-shares-table")}>
    <thead><tr><th scope="col">名称</th><th scope="col" className="collab-description-column">{tab==="favorites"?"关注时间":tab==="sent"?"接收方":"权限"}</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead>
    <tbody>
     {status!=="ready"&&<tr><td colSpan={4} className="empty" role="status">{status==="loading"?<BrandLoadingLabel size="sm">正在加载…</BrandLoadingLabel>:"加载失败，请刷新重试"}</td></tr>}
     {empty&&<tr><td colSpan={4} className="empty"><span className="empty-title">{query?"没有匹配的资源":tab==="favorites"?"暂无关注":tab==="received"?"暂无收到的分享":"暂无发出的分享"}</span></td></tr>}
     {status==="ready"&&visible.map(entry=><tr key={entry.key} className="collab-resource-row">
      <td><div className="file-cell-wrap">{resourceIcon(entry,20)}
       <div className="collab-resource-name">{entry.url?<Link to={entry.url} title={entry.name}>{entry.name}</Link>:<span className="collab-muted-name" title="资源已失效或无权访问">{entry.name}</span>}
        <small className="collab-mobile-meta">{entry.description} · {entry.createdAt.slice(0,10)}</small>
       </div></div></td>
      <td className="collab-description-column">{tab==="favorites"?entry.createdAt.replace("T"," ").slice(0,16):tab==="sent"?entry.description:entry.permission}</td>
      <td><RareBadge dot tone={entry.tone}>{entry.status}</RareBadge></td>
      <td className="collab-action-cell">{actions(entry)}
       <RareButton type="button" tone="ghost" className="collab-compact-trigger"
        aria-label={"操作 "+entry.name} aria-haspopup="menu" aria-expanded={menu?.id===entry.key}
        onClick={event=>setMenu({id:entry.key,anchor:event.currentTarget})}>···</RareButton>
      </td>
     </tr>)}
    </tbody>
   </RareDataTable>}
   {viewMode!=="list"&&<div className={"collab-visual explorer-surface explorer-surface-"+viewMode}>
    {status!=="ready"&&<div className="explorer-empty" role="status">{status==="loading"?<BrandLoadingLabel size="sm">正在加载…</BrandLoadingLabel>:"加载失败，请刷新重试"}</div>}
    {empty&&<div className="explorer-empty">{query?"没有匹配的资源":tab==="favorites"?"暂无关注":tab==="received"?"暂无收到的分享":"暂无发出的分享"}</div>}
    {status==="ready"&&visible.length>0&&viewMode==="icons"&&<div className="explorer-icon-grid" role="grid" aria-label="资源图标">{visible.map(tile)}</div>}
    {status==="ready"&&visible.length>0&&viewMode==="columns"&&<div className="explorer-columns">
     <div className="explorer-column-list" role="grid" aria-label="资源分栏">{visible.map(tile)}</div>
     <div className="explorer-column-detail">{selected&&detail(selected)}</div>
    </div>}
    {status==="ready"&&visible.length>0&&viewMode==="gallery"&&<div className="explorer-gallery">
     <div className="explorer-gallery-stage">{selected&&detail(selected)}</div>
     <div className="explorer-gallery-strip" role="grid" aria-label="资源画廊">{visible.map(tile)}</div>
    </div>}
   </div>}
  </div>
  {(nextCursor||moreStatus==="failed")&&<div className="collab-pagination">
   <span>已加载 {entries.length} 项</span>
   <RareButton type="button" tone="ghost" disabled={moreStatus==="loading"} onClick={onLoadMore}>{moreStatus==="loading"?"加载中…":moreStatus==="failed"?"重试加载":"加载更多"}</RareButton>
   {moreStatus==="failed"&&<span role="alert">后续记录加载失败</span>}
  </div>}
  <Menu open={menu!==null} label="资源操作" anchor={menu?.anchor} items={menuItems} onClose={()=>setMenu(null)}/>
 </section>;
}
