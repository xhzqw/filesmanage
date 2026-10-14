import {RareButton,RareInput} from "./rare";
import {FolderResourceIcon} from "./ResourceIcons";
import {useEffect,useMemo,useRef,useState,type KeyboardEvent,type ReactNode}from "react";
import {PagedFolderPicker} from "./PagedFolderPicker";
import "./folderPicker.css";

// Structural copy of entities/folder/model `Folder`: a shared -> entities import
// fails scripts/check_architecture.py and the shape is identical, so hosts keep
// passing Folder[] unchanged (same reason as shared/ui/AppShell.tsx).
export type FolderPickerFolder={id:string;name:string;parentId:string|null};
export type FolderPickerPageFolder=FolderPickerFolder&{hasChildren:boolean;canSelect:boolean;disabledReason?:string;path?:string};
export type FolderPickerPage={items:FolderPickerPageFolder[];nextCursor:string};
export type FolderPickerRemote={
 children:(parentId:string,cursor?:string)=>Promise<FolderPickerPage>;
 search:(query:string,cursor?:string)=>Promise<FolderPickerPage>;
};

export type FolderPickerProps={
 open:boolean;
 title:string;
 folders:FolderPickerFolder[];
 selectedId:string;
 onSelect:(id:string)=>void;
 onClose:()=>void;
 // Client-side structural rule only: return a reason to disable the target and
 // show why. Server-only answers (permissions, locks, name conflicts) are the
 // host's job — it surfaces them through notice/detail.
 invalidTarget?:(folder:FolderPickerFolder)=>string|null;
 notice?:string;
 busy?:boolean;
 footer?:ReactNode;
 detail?:ReactNode;
 // Opt-in paginated browsing. The legacy `folders` mode remains unchanged for
 // existing move/stats pickers; uploads can traverse beyond the 500-row hint.
 remote?:FolderPickerRemote;
};

// A broad keyword stays bounded: the remainder is reachable by narrowing it.
const MAX_RESULTS=50;
const MAX_DEPTH=32;

// One searchable row: the name plus the visible-path haystacks it matches on.
type SearchRow={folder:FolderPickerFolder;path:string;hay:string;tight:string};

// Target-directory picker panel (COMPLEX-WORKFLOWS-v1 §2, DESKTOP-INTERACTION-v1
// §6): one candidate target, browsable tree plus search, and no transaction of
// its own. It is rendered inside the host's modal Dialog, so it is a panel and
// never a second dialog or a second focus trap. The host owns preflight state
// (notice/detail/busy/footer), the commit, and the close policy (closeGuard):
// this panel only calls onSelect/onClose and never decides them.
export function FolderPicker(props:FolderPickerProps){
 if(props.remote)return <PagedFolderPicker {...props} remote={props.remote}/>;
 return <LocalFolderPicker {...props}/>;
}

function LocalFolderPicker({open,title,folders,selectedId,onSelect,onClose,invalidTarget,notice,busy=false,footer,detail}:FolderPickerProps){
 const panel=useRef<HTMLDivElement>(null);
 const tree=useRef<HTMLUListElement>(null);
 const search=useRef<HTMLInputElement>(null);
 const[query,setQuery]=useState("");
 const[expanded,setExpanded]=useState<Set<string>>(()=>new Set<string>());
 const[focusedId,setFocusedId]=useState<string|null>(null);
 // Reason shown after the user tried a target the panel must not accept; it
 // describes that click only and is dropped as soon as the candidate moves.
 const[blocked,setBlocked]=useState<{id:string;reason:string}|null>(null);

 // One parentId->children index plus every folder's visible-path string, built
 // once per data change: rendering, search and keyboard roaming never filter an
 // array again (DESKTOP-INTERACTION-v1 §5). An orphaned subtree (parent outside
 // the visible set) becomes an accessible root and hidden ancestors are never
 // invented.
 const index=useMemo(()=>{
  const byId=new Map<string,FolderPickerFolder>();
  for(const folder of folders)byId.set(folder.id,folder);
  // byId is complete before the parent lookup: an array order where a child
  // precedes its parent must not turn that child into a false root.
  const childrenOf=new Map<string,FolderPickerFolder[]>();
  for(const folder of folders){
   const key=folder.parentId!==null&&byId.has(folder.parentId)?folder.parentId:"";
   const list=childrenOf.get(key);
   if(list)list.push(folder);else childrenOf.set(key,[folder]);
  }
  const chainOf=(id:string)=>{
   const chain:FolderPickerFolder[]=[];
   const seen=new Set<string>();
   let current=byId.get(id);
   while(current&&!seen.has(current.id)){
    seen.add(current.id);
    chain.unshift(current);
    current=current.parentId!==null?byId.get(current.parentId):undefined;
   }
   return chain;
  };
  const paths=new Map<string,string>();
  const searchable:SearchRow[]=[];
  for(const folder of folders){
   const path=chainOf(folder.id).map(item=>item.name).join(" / ");
   const hay=(folder.name+"\n"+path).toLowerCase();
   paths.set(folder.id,path);
   searchable.push({folder,path,hay,tight:hay.replace(/\s+/g,"")});
  }
  return {byId,childrenOf,paths,searchable,ancestorIds:(id:string)=>chainOf(id).slice(0,-1).map(item=>item.id)};
 },[folders]);

 // Flattened visible order: the keyboard walks this list, never the DOM.
 const flat=useMemo(()=>{
  const rows:FolderPickerFolder[]=[];
  const walk=(parentId:string,depth:number)=>{
   if(depth>MAX_DEPTH)return;
   for(const folder of index.childrenOf.get(parentId)??[]){
    rows.push(folder);
    if(expanded.has(folder.id))walk(folder.id,depth+1);
   }
  };
  walk("",0);
  return {rows,ids:new Set(rows.map(folder=>folder.id))};
 },[index,expanded]);

 const keyword=query.trim().toLowerCase();
 // Client-side filtering over the host-provided visible tree only: the server
 // search endpoint (COMPLEX-WORKFLOWS-v1 §2.3) is deferred by ADR-UX-07.
 const matches=useMemo<SearchRow[]>(()=>{
  if(keyword==="")return [];
  const tight=keyword.replace(/\s+/g,"");
  return index.searchable.filter(row=>row.hay.includes(keyword)||row.tight.includes(tight));
 },[index,keyword]);
 const results=matches.slice(0,MAX_RESULTS);

 const candidatePath=selectedId===""?null:(index.paths.get(selectedId)??null);
 const candidateFolder=selectedId===""?undefined:index.byId.get(selectedId);
 const candidateReason=candidateFolder?reasonOf(candidateFolder):null;
 const blockedName=blocked?(index.byId.get(blocked.id)?.name??""):null;
 // Roving tabindex: the focus state owns the tab stop, and it falls back to the
 // candidate (then to the first visible row) when that state is stale.
 const tabStopId=focusedId&&flat.ids.has(focusedId)
  ?focusedId
  :(flat.ids.has(selectedId)?selectedId:(flat.rows[0]?.id??null));

 // Opening always starts on the natural first stop (the search field) with a
 // clean query, and reveals where the current candidate lives.
 useEffect(()=>{
  if(!open)return;
  setQuery("");
  setBlocked(null);
  search.current?.focus();
 },[open]);

 // A drag-selected folder may only become available after the async tree load.
 // Reveal its ancestors then without stealing focus from search or rerunning it.
 useEffect(()=>{if(open&&selectedId)reveal(selectedId);},[open,selectedId,index]);

 // A blocked reason belongs to the candidate it was raised for.
 useEffect(()=>{setBlocked(null);},[selectedId]);

 // Roving tabindex invariant: the focus state owns the tab stop, so a state
 // that moved without the DOM (chevron click) is pulled back onto the row. It
 // only ever pulls focus that is already inside the tree — a host reload or an
 // expansion must never yank the caret out of search, a result row or the
 // host's footer.
 useEffect(()=>{
  if(!focusedId||!flat.ids.has(focusedId))return;
  const active=document.activeElement;
  if(!(tree.current&&active&&tree.current.contains(active)))return;
  focusNode(focusedId);
 },[focusedId,flat]);

 function reasonOf(folder:FolderPickerFolder):string|null{
  return invalidTarget?.(folder)??null;
 }

 function focusNode(id:string){
  const list=tree.current?.querySelectorAll<HTMLElement>("li[data-folder-id]");
  if(!list)return;
  for(const node of list){
   if(node.dataset.folderId===id){node.focus();return;}
  }
 }

 function focusRow(id:string){
  setFocusedId(id);
  focusNode(id);
 }

 function focusIndex(position:number){
  const rows=flat.rows;
  if(rows.length===0)return;
  const target=rows[Math.max(0,Math.min(rows.length-1,position))];
  if(target)focusRow(target.id);
 }

 function toggle(id:string,force?:boolean){
  setExpanded(old=>{
   const next=new Set(old);
   const shouldOpen=force??!next.has(id);
   if(shouldOpen)next.add(id);else next.delete(id);
   return next;
  });
 }

 function reveal(id:string){
  if(id==="")return;
  const ancestors=index.ancestorIds(id);
  if(ancestors.length===0)return;
  setExpanded(old=>{
   if(ancestors.every(ancestorId=>old.has(ancestorId)))return old;
   const next=new Set(old);
   for(const ancestorId of ancestors)next.add(ancestorId);
   return next;
  });
 }

 // Single candidate only: an invalid target never becomes the candidate, it
 // reports its reason instead (COMPLEX-WORKFLOWS-v1 §2.1/§2.2).
 function choose(folder:FolderPickerFolder){
  if(busy)return;
  const reason=reasonOf(folder);
  if(reason){setBlocked({id:folder.id,reason});return;}
  setBlocked(null);
  onSelect(folder.id);
 }

 function chooseResult(folder:FolderPickerFolder){
  reveal(folder.id);
  choose(folder);
 }

 function onTreeKeyDown(event:KeyboardEvent<HTMLUListElement>){
  const owner=event.target instanceof HTMLElement?event.target.closest<HTMLElement>('li[role="treeitem"]'):null;
  const currentId=owner?.dataset.folderId??focusedId;
  if(!currentId)return;
  const position=flat.rows.findIndex(folder=>folder.id===currentId);
  const current=position<0?undefined:flat.rows[position];
  if(!current)return;
  const children=index.childrenOf.get(current.id)??[];
  const isOpen=expanded.has(current.id);
  const parentId=current.parentId!==null&&index.byId.has(current.parentId)?current.parentId:null;
  switch(event.key){
   case "ArrowDown":
    event.preventDefault();focusIndex(position+1);break;
   case "ArrowUp":
    event.preventDefault();focusIndex(position-1);break;
   case "ArrowRight":
    // Expand a collapsed parent, otherwise step into its first child.
    event.preventDefault();
    if(children.length>0&&!isOpen)toggle(current.id,true);
    else if(isOpen)focusIndex(position+1);
    break;
   case "ArrowLeft":
    // Collapse an expanded parent, otherwise step up to the parent.
    event.preventDefault();
    if(isOpen)toggle(current.id,false);
    else if(parentId)focusRow(parentId);
    break;
   case "Home":
    event.preventDefault();focusIndex(0);break;
   case "End":
    event.preventDefault();focusIndex(flat.rows.length-1);break;
   case "Enter":
    // Enter inside the tree only selects the focused folder (or expands a
    // collapsed parent); it never submits the host transaction.
    event.preventDefault();
    if(children.length>0&&!isOpen)toggle(current.id,true);
    choose(current);
    break;
  }
 }

 function onSearchKeyDown(event:KeyboardEvent<HTMLInputElement>){
  if(event.key==="Enter"){
   // Enter in the search box must not implicitly submit the host's form.
   event.preventDefault();
   return;
  }
  if(event.key!=="Escape")return;
  if(query!==""){
   // A focused text field undoes itself first (DESKTOP-INTERACTION-v1 §4).
   event.preventDefault();
   event.stopPropagation();
   setQuery("");
  }
  // An empty field leaves Escape to the host Dialog (closeGuard + onClose).
 }

 function onPanelKeyDown(event:KeyboardEvent<HTMLDivElement>){
  if(event.key!=="Escape"||event.defaultPrevented)return;
  // Inside the host's modal <dialog> the native cancel path owns Escape and
  // consults the host closeGuard; this fallback only serves a host that renders
  // the panel outside a Dialog.
  if(panel.current?.closest("dialog[open]"))return;
  event.preventDefault();
  if(busy)return;
  onClose();
 }

 function branch(parentId:string,depth:number):ReactNode{
  if(depth>MAX_DEPTH)return null;
  return (index.childrenOf.get(parentId)??[]).map(folder=>{
   const children=index.childrenOf.get(folder.id)??[];
   const isOpen=expanded.has(folder.id);
   const reason=reasonOf(folder);
   const isCandidate=folder.id===selectedId;
   return <li key={folder.id} role="treeitem" data-folder-id={folder.id}
    aria-selected={isCandidate}
    aria-expanded={children.length>0?isOpen:undefined}
    aria-disabled={reason?true:undefined}
    tabIndex={tabStopId===folder.id?0:-1}
    // focusin bubbles: only the treeitem that is itself the focus target may
    // claim the focus state, otherwise an ancestor would overwrite it.
    onFocus={event=>{if(event.target===event.currentTarget)setFocusedId(folder.id);}}>
    <div className={"folder-picker-row"+(isCandidate?" candidate":"")+(reason?" invalid":"")}
     style={{paddingLeft:String(depth*16)+"px"}}>
     {children.length>0
      ?<RareButton type="button" className="folder-picker-chevron" tabIndex={-1}
       aria-label={isOpen?"折叠":"展开"}
       onClick={()=>{focusRow(folder.id);toggle(folder.id);}}>
       <span aria-hidden="true">{isOpen?"▾":"▸"}</span>
      </RareButton>
      :<span className="folder-picker-chevron-spacer" aria-hidden="true"/>}
     <RareButton type="button" className="folder-picker-name" tabIndex={-1} title={reason??folder.name}
      aria-disabled={reason?true:undefined}
      onClick={()=>{focusRow(folder.id);choose(folder);}}><FolderResourceIcon size={16} open={isOpen}/><span className="folder-picker-name-label">{folder.name}</span></RareButton>
    </div>
    {isOpen&&children.length>0&&<ul role="group">{branch(folder.id,depth+1)}</ul>}
   </li>;
  });
 }

 if(!open)return null;
 return <div ref={panel} className="folder-picker" role="group" aria-label={title}
  onKeyDown={onPanelKeyDown}>
  <div className="folder-picker-search-row">
   <RareInput ref={search} className="folder-picker-search" type="search" value={query}
    placeholder="搜索目录" aria-label="搜索目标目录"
    autoComplete="off" disabled={busy}
    onChange={event=>setQuery(event.target.value)}
    onKeyDown={onSearchKeyDown}/>
  </div>
  {notice&&<p className="folder-picker-notice" role="status">{notice}</p>}
  <p className="folder-picker-candidate" aria-live="polite" title={candidatePath??undefined}>
   <span className="folder-picker-candidate-label">目标</span>
   {selectedId===""&&<span className="folder-picker-candidate-none">请选择文件夹</span>}
   {selectedId!==""&&candidatePath===null&&<span className="folder-picker-candidate-none">目录不可见</span>}
   {candidatePath!==null&&<span className="folder-picker-candidate-path">{candidatePath||"（未命名目录）"}</span>}
   {candidateReason&&<span className="folder-picker-candidate-reason">不可选：{candidateReason}</span>}
  </p>
  {keyword!==""&&(matches.length===0
   ?<p className="folder-picker-empty">没有匹配的目录，请更换关键词。</p>
   :<>
    {results.length<matches.length&&<p className="folder-picker-hint">结果较多，请继续输入关键词</p>}
    <ul className="folder-picker-results">
     {results.map(row=>{
      const reason=reasonOf(row.folder);
      const isCandidate=row.folder.id===selectedId;
      return <li key={row.folder.id}>
       <RareButton type="button"
        className={"folder-picker-result"+(isCandidate?" candidate":"")+(reason?" invalid":"")}
        aria-disabled={reason?true:undefined} title={reason??row.path}
        onClick={()=>chooseResult(row.folder)}>
        <FolderResourceIcon size={16}/><span className="folder-picker-result-name">{row.folder.name}</span>
        <span className="folder-picker-result-path">{row.path}</span>
       </RareButton>
      </li>;
     })}
    </ul>
   </>)}
  {blocked&&<p className="folder-picker-blocked" role="status">
   {blockedName?`“${blockedName}”不能作为目标：`:"该目录不能作为目标："}{blocked.reason}
  </p>}
  {/* Single target: aria-selected marks the candidate on every treeitem. The
      navigation tree's aria-current="page" meaning is deliberately not mixed in. */}
  {keyword===""&&(folders.length===0
   ?<p className="folder-picker-empty">没有可选择的目标目录</p>
   :<ul ref={tree} className="folder-picker-tree" role="tree" aria-label="目标目录"
    aria-multiselectable={false} aria-busy={busy?true:undefined}
    onKeyDown={onTreeKeyDown}>
    {branch("",0)}
   </ul>)}
  {detail&&<div className="folder-picker-detail">{detail}</div>}
  {footer&&<div className="folder-picker-footer">{footer}</div>}
 </div>;
}
