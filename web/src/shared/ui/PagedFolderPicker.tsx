import {useEffect,useMemo,useRef,useState,type KeyboardEvent,type ReactNode} from "react";
import {RareButton,RareInput} from "./rare";
import {BrandLoadingLabel} from "./BrandLoader";
import {FolderResourceIcon} from "./ResourceIcons";
import type {FolderPickerProps,FolderPickerPageFolder,FolderPickerRemote} from "./FolderPicker";

type PageLevel={items:FolderPickerPageFolder[];nextCursor:string;status:"loading"|"ready"|"error"};
type SearchState=PageLevel&{keyword:string};
const MAX_DEPTH=32;

// The paged picker is the same shared selection surface as FolderPicker's
// small-tree mode, but never treats /folders/tree (500 hints) as complete.
// Its data comes only from listable roots, per-level children and server search.
export function PagedFolderPicker({
 open,title,selectedId,onSelect,onClose,invalidTarget,notice,busy=false,footer,detail,remote
}:FolderPickerProps&{remote:FolderPickerRemote}){
 const tree=useRef<HTMLUListElement>(null);
 const searchInput=useRef<HTMLInputElement>(null);
 const versions=useRef(new Map<string,number>());
 const requestSequence=useRef(0);
 const searchVersion=useRef(0);
 const[levels,setLevels]=useState<Map<string,PageLevel>>(()=>new Map());
 const[expanded,setExpanded]=useState<Set<string>>(()=>new Set());
 const[query,setQuery]=useState("");
 const[searchState,setSearchState]=useState<SearchState>({keyword:"",items:[],nextCursor:"",status:"ready"});
 const[focusedId,setFocusedId]=useState("");
 const[chosenPath,setChosenPath]=useState("");
 const[blocked,setBlocked]=useState("");
 const keyword=query.trim();

 function loadLevel(parentId:string,cursor="",append=false){
  const version=++requestSequence.current;
  versions.current.set(parentId,version);
  setLevels(old=>{
   const next=new Map(old),current=old.get(parentId);
   next.set(parentId,{items:append?(current?.items??[]):[],nextCursor:append?cursor:"",status:"loading"});
   return next;
  });
  void remote.children(parentId,cursor).then(page=>{
   if(versions.current.get(parentId)!==version)return;
   setLevels(old=>{
    const next=new Map(old),current=old.get(parentId);
    const items=append?[...(current?.items??[]),...page.items.filter(item=>!current?.items.some(existing=>existing.id===item.id))]:page.items;
    next.set(parentId,{items,nextCursor:page.nextCursor===cursor&&cursor!==""?"":page.nextCursor,status:"ready"});
    return next;
   });
   // Automatically reveal the only company root instead of presenting it as
   // the sole destination. Other branches remain lazy and paginated.
   const singleRoot=parentId===""&&!cursor&&page.items.length===1?page.items[0]:undefined;
   if(singleRoot?.hasChildren&&!versions.current.has(singleRoot.id)){
    setExpanded(old=>new Set(old).add(singleRoot.id));
    loadLevel(singleRoot.id);
   }
  }).catch(()=>{
   if(versions.current.get(parentId)!==version)return;
   setLevels(old=>{
    const next=new Map(old),current=old.get(parentId);
    next.set(parentId,{items:current?.items??[],nextCursor:append?cursor:"",status:"error"});
    return next;
   });
  });
 }

 function loadSearch(term:string,cursor="",append=false){
  const version=++searchVersion.current;
  setSearchState(old=>({keyword:term,items:append&&old.keyword===term?old.items:[],nextCursor:append?cursor:"",status:"loading"}));
  void remote.search(term,cursor).then(page=>{
   if(searchVersion.current!==version)return;
   setSearchState(old=>({
    keyword:term,
    items:append&&old.keyword===term?[...old.items,...page.items.filter(item=>!old.items.some(existing=>existing.id===item.id))]:page.items,
    nextCursor:page.nextCursor===cursor&&cursor!==""?"":page.nextCursor,status:"ready"
   }));
  }).catch(()=>{
   if(searchVersion.current!==version)return;
   setSearchState(old=>({...old,keyword:term,status:"error",nextCursor:append?cursor:""}));
  });
 }

 useEffect(()=>{
  if(open){loadLevel("");searchInput.current?.focus();}
  return()=>{versions.current.clear();searchVersion.current++;};
 // The loader is a stable API function; changing it means a different source.
 },[open,remote.children]);

 useEffect(()=>{
  searchVersion.current++;
  if(!keyword){
   setSearchState({keyword:"",items:[],nextCursor:"",status:"ready"});
   return;
  }
  setSearchState({keyword,items:[],nextCursor:"",status:"loading"});
  const timer=window.setTimeout(()=>loadSearch(keyword),220);
  return()=>{window.clearTimeout(timer);searchVersion.current++;};
 },[keyword,remote.search]);

 const byId=useMemo(()=>{
  const map=new Map<string,FolderPickerPageFolder>();
  for(const level of levels.values())for(const item of level.items)map.set(item.id,item);
  for(const item of searchState.items)map.set(item.id,item);
  return map;
 },[levels,searchState.items]);
 function visiblePath(folder:FolderPickerPageFolder):string{
  if(folder.path)return folder.path;
  const names:string[]=[],seen=new Set<string>();
  let current:FolderPickerPageFolder|undefined=folder;
  while(current&&!seen.has(current.id)){
   seen.add(current.id);names.unshift(current.name);
   current=current.parentId?byId.get(current.parentId):undefined;
  }
  return names.join(" / ");
 }
 function reasonOf(folder:FolderPickerPageFolder):string|null{
  return invalidTarget?.(folder)??(!folder.canSelect?(folder.disabledReason||"没有上传权限"):null);
 }
 function choose(folder:FolderPickerPageFolder){
  if(busy)return;
  const reason=reasonOf(folder);
  if(reason){setBlocked("“"+folder.name+"”"+reason);return;}
  setBlocked("");
  setChosenPath(visiblePath(folder));
  onSelect(folder.id);
 }
 function toggle(folder:FolderPickerPageFolder,force?:boolean){
  if(!folder.hasChildren)return;
  const nextOpen=force??!expanded.has(folder.id);
  setExpanded(old=>{
   const next=new Set(old);
   if(nextOpen)next.add(folder.id);else next.delete(folder.id);
   return next;
  });
  if(nextOpen&&!levels.has(folder.id))loadLevel(folder.id);
 }
 const visibleRows=useMemo(()=>{
  const rows:FolderPickerPageFolder[]=[];
  function walk(parentId:string,depth:number){
   if(depth>MAX_DEPTH)return;
   for(const folder of levels.get(parentId)?.items??[]){
    rows.push(folder);
    if(expanded.has(folder.id))walk(folder.id,depth+1);
   }
  }
  walk("",0);
  return rows;
 },[levels,expanded]);

 function focusFolder(id:string){
  setFocusedId(id);
  for(const node of tree.current?.querySelectorAll<HTMLElement>('li[data-folder-id]')??[]){
   if(node.dataset.folderId===id){node.focus();return;}
  }
 }
 function focusIndex(position:number){
  const row=visibleRows[Math.max(0,Math.min(position,visibleRows.length-1))];
  if(row)focusFolder(row.id);
 }
 function onTreeKeyDown(event:KeyboardEvent<HTMLUListElement>){
  const item=event.target instanceof Element?event.target.closest<HTMLElement>('li[data-folder-id]'):null;
  const id=item?.dataset.folderId??focusedId;
  const index=visibleRows.findIndex(folder=>folder.id===id);
  if(index<0)return;
  const current=visibleRows[index];
  if(!current)return;
  const parent=current.parentId?byId.get(current.parentId):undefined;
  switch(event.key){
   case "ArrowDown":event.preventDefault();focusIndex(index+1);break;
   case "ArrowUp":event.preventDefault();focusIndex(index-1);break;
   case "ArrowRight":
    event.preventDefault();
    if(current.hasChildren&&!expanded.has(id))toggle(current,true);
    else if(expanded.has(id)){
     const first=levels.get(id)?.items[0];
     if(first)focusFolder(first.id);
    }
    break;
   case "ArrowLeft":
    event.preventDefault();
    if(expanded.has(id))toggle(current,false);
    else if(parent)focusFolder(parent.id);
    break;
   case "Enter":event.preventDefault();choose(current);break;
   case "Home":event.preventDefault();focusIndex(0);break;
   case "End":event.preventDefault();focusIndex(visibleRows.length-1);break;
  }
 }
 const selected=byId.get(selectedId);
 const selectedPath=selectedId?chosenPath|| (selected?visiblePath(selected):""): "";
 const tabStop=visibleRows.some(item=>item.id===focusedId)?focusedId:(visibleRows[0]?.id??"");

 function levelNotice(parentId:string):ReactNode{
  const level=levels.get(parentId);
  if(!level)return null;
  return <>
   {level.status==="loading"&&<li role="none" className="folder-picker-level-status"><BrandLoadingLabel>正在加载目录…</BrandLoadingLabel></li>}
   {level.status==="error"&&<li role="none" className="folder-picker-level-status">读取失败 <RareButton type="button" className="folder-picker-page-action" onClick={()=>loadLevel(parentId,level.nextCursor,Boolean(level.items.length&&level.nextCursor))}>重试</RareButton></li>}
   {level.status==="ready"&&level.nextCursor&&<li role="none" className="folder-picker-level-status"><RareButton type="button" className="folder-picker-page-action" onClick={()=>loadLevel(parentId,level.nextCursor,true)}>加载更多</RareButton></li>}
  </>;
 }
 function branch(parentId:string,depth:number):ReactNode{
  if(depth>MAX_DEPTH)return null;
  return (levels.get(parentId)?.items??[]).map(folder=>{
   const isOpen=expanded.has(folder.id),reason=reasonOf(folder),isSelected=selectedId===folder.id;
   return <li key={folder.id} role="treeitem" data-folder-id={folder.id}
    aria-expanded={folder.hasChildren?isOpen:undefined} aria-selected={isSelected}
    aria-disabled={reason?true:undefined} tabIndex={tabStop===folder.id?0:-1}
    onFocus={event=>{if(event.target===event.currentTarget)setFocusedId(folder.id);}}>
    <div className={"folder-picker-row"+(isSelected?" candidate":"")+(reason?" invalid":"")} style={{paddingLeft:depth*16+"px"}}>
     {folder.hasChildren
      ?<RareButton type="button" className="folder-picker-chevron" tabIndex={-1} aria-label={(isOpen?"折叠":"展开")+folder.name} aria-expanded={isOpen}
       onClick={event=>{event.currentTarget.closest<HTMLElement>("li[data-folder-id]")?.focus();toggle(folder);}}>
       <span aria-hidden="true">{isOpen?"▾":"▸"}</span>
      </RareButton>
      :<span className="folder-picker-chevron-spacer" aria-hidden="true"/>}
     <RareButton type="button" className="folder-picker-name" tabIndex={-1} title={reason??folder.name}
      aria-disabled={reason?true:undefined}
      onClick={event=>{event.currentTarget.closest<HTMLElement>("li[data-folder-id]")?.focus();choose(folder);}}>
      <FolderResourceIcon size={16} open={isOpen}/><span className="folder-picker-name-label">{folder.name}</span>
     </RareButton>
    </div>
    {isOpen&&folder.hasChildren&&<ul role="group">{branch(folder.id,depth+1)}{levelNotice(folder.id)}</ul>}
   </li>;
  });
 }
 if(!open)return null;
 return <div className="folder-picker folder-picker-paged" role="group" aria-label={title}>
  <div className="folder-picker-search-row">
   <RareInput ref={searchInput} className="folder-picker-search" type="search" value={query} disabled={busy}
    autoComplete="off" placeholder="搜索全部目录" aria-label="搜索目标目录"
    onChange={event=>{setQuery(event.target.value);setBlocked("");}}
    onKeyDown={event=>{if(event.key==="Enter")event.preventDefault();if(event.key==="Escape"&&query){event.stopPropagation();setQuery("");}}}/>
  </div>
  {notice&&<p className="folder-picker-notice" role="status">{notice}</p>}
  <p className="folder-picker-candidate" aria-live="polite" title={selectedPath||undefined}>
   <span className="folder-picker-candidate-label">目标</span>
   {selectedPath?<span className="folder-picker-candidate-path">{selectedPath}</span>:<span className="folder-picker-candidate-none">请选择文件夹</span>}
  </p>
  {blocked&&<p className="folder-picker-blocked" role="status">{blocked}</p>}
  {keyword?<>
   {searchState.status==="loading"&&!searchState.items.length&&<p className="folder-picker-level-status" role="status"><BrandLoadingLabel decorative>正在搜索…</BrandLoadingLabel></p>}
   {searchState.status==="error"&&<p className="folder-picker-level-status" role="alert">搜索失败 <RareButton type="button" className="folder-picker-page-action" onClick={()=>loadSearch(keyword,searchState.nextCursor,Boolean(searchState.items.length&&searchState.nextCursor))}>重试</RareButton></p>}
   {searchState.status==="ready"&&!searchState.items.length&&<p className="folder-picker-empty">没有匹配的目录</p>}
   {searchState.items.length>0&&<ul className="folder-picker-results" aria-label="搜索结果">
    {searchState.items.map(folder=>{
     const reason=reasonOf(folder);
     return <li key={folder.id}><RareButton type="button" className={"folder-picker-result"+(selectedId===folder.id?" candidate":"")}
      aria-disabled={reason?true:undefined} title={reason??folder.path??folder.name} onClick={()=>choose(folder)}>
      <FolderResourceIcon size={16}/><span className="folder-picker-result-name">{folder.name}</span>
      <span className="folder-picker-result-path">{folder.path??folder.name}</span>
     </RareButton></li>;
    })}
    {searchState.nextCursor&&<li className="folder-picker-level-status"><RareButton type="button" className="folder-picker-page-action"
     disabled={searchState.status==="loading"} onClick={()=>loadSearch(keyword,searchState.nextCursor,true)}>加载更多</RareButton></li>}
   </ul>}
  </>:<>
   <ul ref={tree} className="folder-picker-tree" role="tree" aria-label="目标目录"
    aria-multiselectable={false} aria-busy={levels.get("")?.status==="loading"}
    onKeyDown={onTreeKeyDown}>
    {branch("",0)}
    {levelNotice("")}
   </ul>
   {levels.get("")?.status==="ready"&&!levels.get("")?.items.length&&<p className="folder-picker-empty">没有可选择的目标目录</p>}
  </>}
  {detail&&<div className="folder-picker-detail">{detail}</div>}
  {footer&&<div className="folder-picker-footer">{footer}</div>}
 </div>;
}
