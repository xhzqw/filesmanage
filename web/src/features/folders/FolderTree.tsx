import {useEffect,useId,useMemo,useRef,useState,type KeyboardEvent,type ReactNode}from "react";
import {Link,useNavigate}from "react-router-dom";
import type{Folder}from"../../entities/folder/model";
import {Menu,type MenuItem,type MenuPoint}from"../../shared/ui/Menu";
import {request}from"../../shared/http";
import "./folderTree.css";

// Toggles insert/remove ids at runtime, so Set is the correct membership structure.
const DEFAULT_EXPANDED=["folder_root","folder_market","folder_rd"];

// ADR-UX-07 fixes the compatibility switch: while the page's full GET
// /folders/tree list is small the tree stays exactly as before (one
// parentId->children index, no extra request); above PAGED_THRESHOLD it uses the
// on-demand children/search protocol (COMPLEX-WORKFLOWS-v1 §2.3) so a 10k
// directory tree never recurses over the whole list in render
// (DESKTOP-INTERACTION-v1 §5, PERF-03, DI-07, WF-10). 300 is the documented
// cutoff: at that size the single page payload and the one-off index are still
// cheap and the sidebar only ever shows ~30 rows, while 300 sits far below the
// 10k acceptance dataset so the acceptance gates exercise the paged path.
const PAGED_THRESHOLD=300;
// One page per expanded level and per search. The server owns the real cap; a
// remainder stays reachable through 加载更多 (levels) or a narrower keyword.
const PAGE_LIMIT=200;
const SEARCH_LIMIT=50;
// Typing is not yet a query: let the keystrokes settle before asking the server.
const SEARCH_DEBOUNCE_MS=250;
const MAX_DEPTH=32;

// children/search payload of COMPLEX-WORKFLOWS-v1 §2.3. canSelect is a UI hint
// only: the server re-checks the real permission whenever an action commits.
type FolderNode={id:string;name:string;parentId:string|null;hasChildren:boolean;canSelect:boolean;disabledReason?:string};
type TreeEntry=Folder&FolderNode;
type SearchNode=FolderNode&{path:string};
type NodePage<T>={items:T[];nextCursor:string};
// One loaded level, keyed by its parent id ("" is the visible root level).
type Level={items:TreeEntry[];status:"loading"|"ready"|"error";nextCursor:string;mode:"replace"|"append"};
// One search row: the name plus the path the server was willing to disclose.
type Hit={id:string;name:string;parentId:string|null;path:string};
type Row={entry:TreeEntry;depth:number};
// Per level: the AbortController cancels the fetch, and the generation drops a
// response that was superseded (or unmounted) before it could write state.
type LevelRequest={generation:number;controller:AbortController};

// Navigation tree contract (DESKTOP-INTERACTION-v1 §5): ARIA tree semantics,
// roving tabindex, full keyboard roaming, one parent->children index instead
// of per-render filtering, and orphaned subtrees (a parent outside the visible
// set) surfacing as accessible roots without leaking hidden ancestors. Above
// PAGED_THRESHOLD expansion fetches one level on demand, with per-node
// loading/empty/error states and an in-place retry.
export function FolderTree({items,selected,isAdmin=false,onRenameFolder,onMoveFolder,onDeleteFolder,onManageGrants,onManagePolicy}:{
 items:Folder[];
 selected:string;
 // Admin-only entries are hidden for non-admins instead of being offered and
 // then rejected by the server (WF-11).
 isAdmin?:boolean;
 onRenameFolder?:(folder:Folder)=>void;
 // Moving is offered to every folder the user can act on: whether the user may
 // move the source and write the target is decided by the server, so the entry
 // is never hidden behind isAdmin.
 onMoveFolder?:(folder:Folder)=>void;
 onDeleteFolder?:(folder:Folder)=>void;
 onManageGrants?:(folder:Folder)=>void;
 onManagePolicy?:(folder:Folder)=>void;
}){
 const[expanded,setExpanded]=useState<Set<string>>(()=>new Set<string>(DEFAULT_EXPANDED));
 const[focusedId,setFocusedId]=useState<string|null>(null);
 // Transient context-menu target (DESKTOP-INTERACTION §1.1 contextTarget):
 // it exists only while the node menu is open and is never business state.
 const[nodeMenu,setNodeMenu]=useState<{folder:Folder;point:MenuPoint|null;anchor:HTMLElement|null}|null>(null);
 // Paged mode only: parent id -> loaded level. Small-tree mode never fills it.
 const[levels,setLevels]=useState<Map<string,Level>>(()=>new Map());
 const[query,setQuery]=useState("");
 const[remoteHits,setRemoteHits]=useState<SearchNode[]>([]);
 const[searchStatus,setSearchStatus]=useState<"idle"|"loading"|"ready"|"error">("idle");
 const[searchTruncated,setSearchTruncated]=useState(false);
 const requests=useRef(new Map<string,LevelRequest>());
 const searchRequest=useRef<AbortController|null>(null);
 const searchGeneration=useRef(0);
 // The page's list identity: a new array means the page reloaded the folder
 // set (create/move/delete/upload commit), which paged levels must re-validate.
 const pageRevision=useRef(items);
 const navigate=useNavigate();
 const searchId=useId();
 const searchHintId=useId();
 const keyword=query.trim();
 const paged=items.length>PAGED_THRESHOLD;

 // Small-tree index: parentId -> children, built once per data change; the
 // render never filters (DESKTOP-INTERACTION-v1 §5). In paged mode the page's
 // list is not structure at all, so no index is built from it.
 const small=useMemo(()=>{
  const ids=new Set<string>();
  const childrenOf=new Map<string,TreeEntry[]>();
  const byId=new Map<string,TreeEntry>();
  if(paged)return{childrenOf,byId};
  // ids is complete before any parent lookup: an array order where a child
  // precedes its parent must not turn that child into a false root.
  for(const folder of items)ids.add(folder.id);
  for(const folder of items)byId.set(folder.id,{...folder,hasChildren:false,canSelect:true});
  for(const folder of items){
   const entry=byId.get(folder.id);
   if(!entry)continue;
   const key=entry.parentId!==null&&ids.has(entry.parentId)?entry.parentId:"";
   const list=childrenOf.get(key);
   if(list)list.push(entry);else childrenOf.set(key,[entry]);
  }
  // hasChildren is read after the whole index exists, so a child that precedes
  // its parent in the page's array cannot turn that parent into a leaf.
  for(const key of childrenOf.keys()){
   if(key==="")continue;
   const parent=byId.get(key);
   if(parent)parent.hasChildren=true;
  }
  return{childrenOf,byId};
 },[items,paged]);

 // One metadata map for both modes: the page's list in small mode, every loaded
 // level in paged mode.
 const entries=useMemo(()=>{
  if(!paged)return small.byId;
  const map=new Map<string,TreeEntry>();
  for(const level of levels.values())for(const item of level.items)map.set(item.id,item);
  return map;
 },[paged,small,levels]);

 // Children currently available for rendering under a level.
 function levelItems(parentId:string):TreeEntry[]{
  return paged?(levels.get(parentId)?.items??[]):(small.childrenOf.get(parentId)??[]);
 }

 // A node can expand while the server says it may have children (paged mode) or
 // while the page's own list already contains them (small mode). A level that
 // has been loaded keeps its chevron even when it came back empty, so the
 // empty/error note and its retry stay reachable.
 function canExpandNode(entry:TreeEntry):boolean{
  return entry.hasChildren!==false||levelItems(entry.id).length>0;
 }

 // Flattened visible order: the keyboard walks this list, never the DOM. Only
 // loaded levels contribute rows, so a loading node cannot shift focus onto a
 // row that is not really its child.
 const rows=useMemo(()=>{
  const out:Row[]=[];
  const walk=(parentId:string,depth:number)=>{
   if(depth>MAX_DEPTH)return;
   for(const entry of levelItems(parentId)){
    out.push({entry,depth});
    if(expanded.has(entry.id))walk(entry.id,depth+1);
   }
  };
  walk("",0);
  return out;
  // levelItems reads paged/levels/small, so those are the real dependencies.
 },[paged,levels,small,expanded]);

 useEffect(()=>{
  // While the node menu is open it owns keyboard focus; stealing it back to
  // the treeitem here would break "focus moves into the menu on open".
  if(!focusedId||nodeMenu)return;
  const node=document.querySelector<HTMLElement>(`li[data-folder-id="${focusedId}"]`);
  node?.focus();
 },[focusedId,nodeMenu]);

 // Unmount: nothing in flight may write state afterwards. Aborting rejects the
 // fetch; clearing the map makes the late rejection a no-op even synchronously.
 useEffect(()=>()=>{
  for(const pending of requests.current.values())pending.controller.abort();
  requests.current.clear();
  searchRequest.current?.abort();
 },[]);

 // A level needs a request when it has no record yet, or when its record is
 // stuck in "loading" with no in-flight request (the StrictMode
 // mount/unmount/mount cycle aborts the first one before it can settle).
 function needsLoad(parentId:string):boolean{
  const level=levels.get(parentId);
  return !level||(level.status==="loading"&&!requests.current.has(parentId));
 }

 // The root level is always loaded in paged mode. Leaving paged mode drops the
 // fetched levels so a later flip cannot render a stale branch, and small-tree
 // mode keeps exactly the pre-ADR-UX-07 behavior.
 useEffect(()=>{
  if(!paged){
   if(levels.size>0)setLevels(new Map());
   for(const pending of requests.current.values())pending.controller.abort();
   requests.current.clear();
   return;
  }
  if(needsLoad(""))loadLevel("","","replace");
 },[paged,levels]);

 // Expanding a node is the only thing that fetches its children: a level that
 // already has a settled record is never silently refetched, so a failed node
 // stays in its error state until the user retries it in place.
 useEffect(()=>{
  if(!paged)return;
  for(const id of expanded)if(needsLoad(id)&&entries.has(id))loadLevel(id,"","replace");
 },[paged,expanded,levels,entries]);

 // A new page list means the server-side folder set changed. The open levels
 // are re-read in place (their rows stay visible while the refresh runs) and
 // the closed ones are dropped, so a folder created in the explorer appears
 // here as it does in small-tree mode (WF-09).
 useEffect(()=>{
  if(!paged||pageRevision.current===items)return;
  pageRevision.current=items;
  for(const key of levels.keys()){
   if(key===""||expanded.has(key))continue;
   // A dropped level must not come back: forget its in-flight request so a
   // late response is ignored instead of resurrecting the branch.
   const pending=requests.current.get(key);
   if(pending){pending.controller.abort();requests.current.delete(key);}
  }
  setLevels(old=>{
   const next=new Map<string,Level>();
   for(const[key,level]of old)if(key===""||expanded.has(key))next.set(key,level);
   return next;
  });
  for(const key of["",...expanded])if(levels.has(key))loadLevel(key,"","replace");
 },[paged,items,levels,expanded]);

 // Paged search: one debounced request per settled keyword, cancelled and
 // generation-guarded, so the results always belong to the current keyword.
 useEffect(()=>{
  if(!paged||keyword===""){
   searchGeneration.current+=1;
   searchRequest.current?.abort();
   // Idempotent resets: a small tree re-rendering on every keystroke would be
   // pure waste.
   setSearchStatus(old=>old==="idle"?old:"idle");
   setRemoteHits(old=>old.length===0?old:[]);
   setSearchTruncated(old=>old?false:old);
   return;
  }
  const generation=searchGeneration.current+1;
  searchGeneration.current=generation;
  const controller=new AbortController();
  searchRequest.current?.abort();
  searchRequest.current=controller;
  setSearchStatus("loading");
  setRemoteHits([]);
  setSearchTruncated(false);
  const timer=window.setTimeout(()=>{
   request<NodePage<SearchNode>>("/folders/search?q="+encodeURIComponent(keyword)+"&limit="+String(SEARCH_LIMIT),{signal:controller.signal})
    .then(page=>{
     if(searchGeneration.current!==generation||controller.signal.aborted)return;
     setRemoteHits(page.items);
     setSearchTruncated(page.nextCursor!=="");
     setSearchStatus("ready");
    })
    .catch(()=>{
     // An aborted request (newer keystroke, mode switch, unmount) is not a
     // failure: the generation and signal checks drop it instead of claiming
     // the search failed.
     if(searchGeneration.current!==generation||controller.signal.aborted)return;
     setSearchStatus("error");
    });
  },SEARCH_DEBOUNCE_MS);
  return()=>{window.clearTimeout(timer);controller.abort();};
 },[paged,keyword]);

 // Small-tree search is a local filter over the list the page already
 // authorized: no request, and no path the user cannot see.
 const localHits=useMemo<Hit[]>(()=>{
  if(paged||keyword==="")return[];
  const needle=keyword.toLowerCase();
  const out:Hit[]=[];
  for(const folder of items){
   const path=pathIn(small.byId,folder.id);
   if(folder.name.toLowerCase().includes(needle)||path.toLowerCase().includes(needle))
    out.push({id:folder.id,name:folder.name,parentId:folder.parentId,path});
  }
  return out;
 },[paged,keyword,items,small]);

 const hits:Hit[]=paged?remoteHits:localHits;
 const hitsStatus=paged?searchStatus:(keyword===""?"idle":"ready");

 function toggle(id:string,force?:boolean){
  setExpanded(old=>{
   const next=new Set(old);
   const shouldOpen=force??!next.has(id);
   if(shouldOpen)next.add(id);else next.delete(id);
   return next;
  });
 }

 function focusIndex(index:number){
  if(rows.length===0)return;
  const target=rows[Math.max(0,Math.min(rows.length-1,index))];
  if(target)setFocusedId(target.entry.id);
 }

 // One request per level. The previous request for the same level is aborted
 // and its generation bumped, so a late response can never overwrite the newer
 // one or land under another node (levels are keyed by their own parent id).
 function loadLevel(parentId:string,cursor:string,mode:"replace"|"append"){
  const previous=requests.current.get(parentId);
  previous?.controller.abort();
  const generation=(previous?.generation??0)+1;
  const controller=new AbortController();
  requests.current.set(parentId,{generation,controller});
  // A refresh or a 加载更多 keeps the rows already on screen; only a first load
  // starts from an empty level.
  setLevels(old=>{
   const current=old.get(parentId);
   const next=new Map(old);
   next.set(parentId,{items:current?.items??[],status:"loading",nextCursor:mode==="append"?cursor:"",mode});
   return next;
  });
  const prefix=parentId===""?"":"parentId="+encodeURIComponent(parentId)+"&";
  const url="/folders/children?"+prefix+"limit="+String(PAGE_LIMIT)+(cursor!==""?"&cursor="+encodeURIComponent(cursor):"");
  request<NodePage<TreeEntry>>(url,{signal:controller.signal})
   .then(page=>{
    const live=requests.current.get(parentId);
    if(!live||live.generation!==generation||controller.signal.aborted)return;
    requests.current.delete(parentId);
    setLevels(old=>{
     const current=old.get(parentId);
     const base=mode==="append"?(current?.items??[]):[];
     const next=new Map(old);
     next.set(parentId,{items:base.concat(page.items),status:"ready",nextCursor:page.nextCursor,mode});
     return next;
    });
   })
   .catch(()=>{
    const live=requests.current.get(parentId);
    if(!live||live.generation!==generation||controller.signal.aborted)return;
    requests.current.delete(parentId);
    setLevels(old=>{
     const current=old.get(parentId);
     const next=new Map(old);
     next.set(parentId,{items:current?.items??[],status:"error",nextCursor:current?.nextCursor??"",mode});
     return next;
    });
   });
 }

 // 重试 re-issues exactly that level, in the same mode it failed in: a failed
 // first load starts over, a failed 加载更多 continues from its own cursor.
 function retryLevel(parentId:string){
  const level=levels.get(parentId);
  if(!level)return;
  loadLevel(parentId,level.mode==="append"?level.nextCursor:"",level.mode);
 }

 function onTreeKeyDown(event:KeyboardEvent<HTMLUListElement>){
  if(!focusedId)return;
  const index=rows.findIndex(row=>row.entry.id===focusedId);
  const row=index<0?undefined:rows[index];
  if(!row)return;
  const current=row.entry;
  const isExpanded=expanded.has(current.id);
  const canExpand=canExpandNode(current);
  switch(event.key){
   case "ArrowDown":
    event.preventDefault();focusIndex(index+1);break;
   case "ArrowUp":
    event.preventDefault();focusIndex(index-1);break;
   case "ArrowRight":{
    // Expand a collapsed parent, otherwise step into its first child. While
    // the children are still loading (or when the level is honestly empty) the
    // focus stays on the node instead of jumping onto a sibling row; the user
    // steps in once the rows land. On a level whose load failed this retries,
    // which is the keyboard equivalent of the in-row 重试 button.
    event.preventDefault();
    if(!isExpanded){
     if(canExpand)toggle(current.id,true);
     break;
    }
    const next=rows[index+1];
    if(next&&next.depth>row.depth){setFocusedId(next.entry.id);break;}
    if(paged&&levels.get(current.id)?.status==="error")retryLevel(current.id);
    break;
   }
   case "ArrowLeft":{
    // Collapse an expanded parent, otherwise step up to the nearest visible
    // ancestor row (an ancestor outside the loaded set is never invented).
    event.preventDefault();
    if(isExpanded){toggle(current.id,false);break;}
    const parent=ancestorRow(rows,index);
    if(parent)setFocusedId(parent.entry.id);
    break;
   }
   case "Home":
    event.preventDefault();focusIndex(0);break;
   case "End":
    event.preventDefault();focusIndex(rows.length-1);break;
   case "Enter":
    event.preventDefault();
    navigate("/doc?folder="+encodeURIComponent(current.id));
    break;
   case "F10":
    // Shift+F10 (and the dedicated Menu key below) is the keyboard equivalent
    // of a right-click on the focused node; bare F10 stays with the browser.
    if(!event.shiftKey)return;
    event.preventDefault();
    openNodeMenu(current,null);
    break;
   case "ContextMenu":
    event.preventDefault();
    openNodeMenu(current,null);
    break;
  }
 }

 function onSearchKeyDown(event:KeyboardEvent<HTMLInputElement>){
  if(event.key!=="Escape"||query==="")return;
  // A focused text field undoes itself first (DESKTOP-INTERACTION-v1 §4).
  event.preventDefault();
  event.stopPropagation();
  setQuery("");
 }

 function openNodeMenu(folder:Folder,point:MenuPoint|null){
  const node=document.querySelector<HTMLElement>(`li[data-folder-id="${folder.id}"]`);
  setFocusedId(folder.id);
  setNodeMenu({folder,point,anchor:node});
 }

 // A result click navigates (the Link) and opens every ancestor the tree has
 // already loaded. The children/search protocol carries no ancestor id chain,
 // so a branch the tree never loaded cannot be opened deterministically; the
 // disclosed path on the row is the rest of the context.
 function revealResult(hit:Hit){
  const chain:string[]=[];
  const seen=new Set<string>();
  let current=hit.parentId;
  while(current!==null&&!seen.has(current)){
   const entry=entries.get(current);
   if(!entry)break;
   seen.add(current);
   chain.push(current);
   current=entry.parentId;
  }
  if(chain.length===0)return;
  setExpanded(old=>{
   let next:Set<string>|null=null;
   for(const id of chain)if(!old.has(id)){
    if(next===null)next=new Set(old);
    next.add(id);
   }
   return next??old;
  });
 }

 // The menu reuses the page's FolderActions flows through callbacks, so rename,
 // move and delete never duplicate the dialog logic; admin-only entries are
 // hidden for non-admins (WF-11).
 function nodeMenuItems(folder:Folder):MenuItem[]{
  const items:MenuItem[]=[
   {id:"rename",label:"重命名目录",onSelect:()=>onRenameFolder?.(folder)},
   {id:"move",label:"移动到…",onSelect:()=>onMoveFolder?.(folder)},
  ];
  if(isAdmin){
   items.push({id:"grants",label:"授权管理",onSelect:()=>onManageGrants?.(folder)});
   items.push({id:"policy",label:"审批策略",onSelect:()=>onManagePolicy?.(folder)});
  }
  items.push({id:"delete",label:"删除目录",danger:true,onSelect:()=>onDeleteFolder?.(folder)});
  return items;
 }

 // The per-node async states (loading/empty/error+重试) live in the group of
 // the node they belong to, so a failed expansion never silently looks
 // childless. parentDepth is the depth of the owning row (-1 for the roots).
 function levelNotes(parentId:string,parentDepth:number,count:number):ReactNode{
  const level=levels.get(parentId);
  if(!level)return null;
  const style={paddingLeft:String((parentDepth+1)*16+8)+"px"};
  if(level.status==="loading")
   return <li role="none" className="tree-note hint" style={style}>{count>0?"正在加载…":"正在加载子目录…"}</li>;
  if(level.status==="error")
   return <li role="none" className="tree-note" style={style}>
    <span role="alert" className="tree-note-error">子目录加载失败</span>
    <button type="button" className="secondary-action tree-retry" tabIndex={-1}
     title="重新加载该目录的子目录（键盘：方向键→）"
     onClick={()=>retryLevel(parentId)}>重试</button>
   </li>;
  if(level.items.length===0)
   return <li role="none" className="tree-note hint" style={style}>{parentId===""?"没有可访问的目录。":"没有子目录"}</li>;
  if(level.nextCursor!=="")
   return <li role="none" className="tree-note" style={style}>
    <button type="button" className="secondary-action tree-more" tabIndex={-1}
     onClick={()=>loadLevel(parentId,level.nextCursor,"append")}>加载更多</button>
   </li>;
  return null;
 }

 function renderNode(entry:TreeEntry,depth:number):ReactNode{
  if(depth>MAX_DEPTH)return null;
  const isExpanded=expanded.has(entry.id);
  const canExpand=canExpandNode(entry);
  const children=levelItems(entry.id);
  // aria-expanded follows the real expansion: an open node says so even while
  // its children are loading, and aria-busy marks that load instead of hiding
  // it. A node whose children cannot be fetched keeps its group open with the
  // empty/error note in it.
  const busy=paged&&levels.get(entry.id)?.status==="loading";
  return <li key={entry.id} data-folder-id={entry.id} role="treeitem"
   aria-expanded={canExpand?isExpanded:undefined}
   aria-busy={busy?true:undefined}
   aria-current={entry.id===selected?"page":undefined}
   tabIndex={focusedId===entry.id||(focusedId===null&&rows[0]?.entry.id===entry.id)?0:-1}
   // focusin bubbles: only the treeitem that is itself the focus target may
   // claim the focus state, otherwise an ancestor would overwrite it.
   onFocus={event=>{if(event.target===event.currentTarget)setFocusedId(entry.id);}}
   // contextmenu bubbles too: only the innermost treeitem under the pointer
   // owns the menu, otherwise an ancestor would retarget it.
   onContextMenu={event=>{
    const owner=(event.target as HTMLElement|null)?.closest?.('li[role="treeitem"]');
    if(owner!==event.currentTarget)return;
    event.preventDefault();
    openNodeMenu(entry,{x:event.clientX,y:event.clientY});
   }}>
   <div className={"tree-row "+(entry.id===selected?"on":"")} style={{paddingLeft:String(depth*16)+"px"}}>
    {canExpand
     ?<button type="button" aria-label={isExpanded?"折叠":"展开"} tabIndex={-1}
       onClick={()=>toggle(entry.id)}>{isExpanded?"▾":"▸"}</button>
     :<span className="tree-chevron-spacer" aria-hidden="true"/>}
    <Link to={"/doc?folder="+encodeURIComponent(entry.id)} tabIndex={-1}
     title={entry.disabledReason||undefined}>{entry.name}</Link>
   </div>
   {isExpanded&&<ul role="group">
    {children.map(child=>renderNode(child,depth+1))}
    {paged&&levelNotes(entry.id,depth,children.length)}
   </ul>}
  </li>;
 }

 return <>
  {/* The tree header search is always present: a paged tree asks the server
      (results are already trimmed to listable paths), a small tree filters the
      page's authorized list in memory. */}
  <div className="tree-head" role="search">
   <input id={searchId} className="tree-search" type="search" value={query} autoComplete="off"
    placeholder="搜索目录" aria-label="搜索目录" aria-describedby={searchHintId}
    onChange={event=>setQuery(event.target.value)} onKeyDown={onSearchKeyDown}/>
   <p id={searchHintId} className="tree-search-hint">
    {paged?"仅搜索你有权查看的目录，结果不含未授权路径。":"在当前可见目录中筛选。"}
   </p>
  </div>
  <ul className="tree" role="tree" aria-label="目录树"
   aria-busy={paged&&levels.get("")?.status==="loading"?true:undefined}
   onKeyDown={onTreeKeyDown}>
   {levelItems("").map(entry=>renderNode(entry,0))}
   {paged&&levelNotes("",-1,levelItems("").length)}
  </ul>
  {keyword!==""&&<div className="tree-search-panel">
   {hitsStatus==="loading"&&<p className="hint">搜索中…</p>}
   {hitsStatus==="error"&&<p className="hint error" role="alert">目录搜索失败，请稍后重试。</p>}
   {hitsStatus==="ready"&&hits.length===0&&<p className="hint">没有匹配的目录。</p>}
   {hits.length>0&&<ul className="tree-results" aria-label="目录搜索结果">
    {hits.map(hit=>{
     const path=searchPathHint(hit);
     return <li key={hit.id}>
      <Link to={"/doc?folder="+encodeURIComponent(hit.id)} onClick={()=>revealResult(hit)}>
       <span className="tree-hit-name">{hit.name}</span>
       {path!==""&&<span className="tree-hit-path">{path}</span>}
      </Link>
     </li>;
    })}
   </ul>}
   {paged&&searchTruncated&&<p className="hint">结果较多，仅显示前 {hits.length} 条，请细化关键词。</p>}
  </div>}
  {nodeMenu&&<Menu open label={nodeMenu.folder.name+" 目录菜单"} items={nodeMenuItems(nodeMenu.folder)}
   anchor={nodeMenu.anchor} point={nodeMenu.point} onClose={()=>setNodeMenu(null)}/>}
 </>;
}

// Nearest rendered ancestor row: the previous row with a smaller depth, which
// is the only parent the keyboard may step to.
function ancestorRow(list:Row[],index:number):Row|null{
 const depth=list[index]?.depth;
 if(depth===undefined)return null;
 for(let at=index-1;at>=0;at--){
  const candidate=list[at];
  if(candidate&&candidate.depth<depth)return candidate;
 }
 return null;
}

// Visible-ancestor path only: an ancestor outside the caller's visible set is
// never invented or leaked.
function pathIn(byId:Map<string,TreeEntry>,id:string):string{
 const names:string[]=[];
 const seen=new Set<string>();
 let current=byId.get(id)?.parentId??null;
 while(current!==null&&!seen.has(current)){
  seen.add(current);
  const parent=byId.get(current);
  if(!parent)break;
  names.unshift(parent.name);
  current=parent.parentId;
 }
 return names.join(" / ");
}

// The search row shows the disclosed path; a trailing segment equal to the name
// would repeat the label, so it is dropped whatever the server includes.
function searchPathHint(hit:Hit):string{
 const parts=hit.path.split(" / ").filter(part=>part!=="");
 if(parts[parts.length-1]===hit.name)parts.pop();
 return parts.join(" / ");
}

// The breadcrumb walks real visible ancestors only; an ancestor outside the
// caller's visible set is never invented or leaked.
export function ancestorPath(items:Folder[],id:string):Folder[]{
 const byId=new Map(items.map(f=>[f.id,f]));
 const chain:Folder[]=[];
 const seen=new Set<string>();
 let current=byId.get(id);
 while(current&&!seen.has(current.id)){
  seen.add(current.id);
  chain.unshift(current);
  const parentId=current.parentId;
  current=parentId!==null?byId.get(parentId):undefined;
 }
 return chain;
}
