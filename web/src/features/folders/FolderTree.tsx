import {useEffect,useMemo,useState,type KeyboardEvent}from "react";
import {Link,useNavigate}from "react-router-dom";
import type{Folder}from"../../entities/folder/model";
import {Menu,type MenuItem,type MenuPoint}from"../../shared/ui/Menu";
// Toggles insert/remove ids at runtime, so Set is the correct membership structure.
const DEFAULT_EXPANDED=["folder_root","folder_market","folder_rd"];

// Navigation tree contract (DESKTOP-INTERACTION-v1 §5): ARIA tree semantics,
// roving tabindex, full keyboard roaming, one parent->children index instead
// of per-render filtering, and orphaned subtrees (a parent outside the visible
// set) surfacing as accessible roots without leaking hidden ancestors.
export function FolderTree({items,selected,isAdmin=false,onRenameFolder,onDeleteFolder,onManageGrants,onManagePolicy}:{
 items:Folder[];
 selected:string;
 // Admin-only entries are hidden for non-admins instead of being offered and
 // then rejected by the server (WF-11).
 isAdmin?:boolean;
 onRenameFolder?:(folder:Folder)=>void;
 onDeleteFolder?:(folder:Folder)=>void;
 onManageGrants?:(folder:Folder)=>void;
 onManagePolicy?:(folder:Folder)=>void;
}){
 const[expanded,setExpanded]=useState<Set<string>>(()=>new Set<string>(DEFAULT_EXPANDED));
 const[focusedId,setFocusedId]=useState<string|null>(null);
 // Transient context-menu target (DESKTOP-INTERACTION §1.1 contextTarget):
 // it exists only while the node menu is open and is never business state.
 const[nodeMenu,setNodeMenu]=useState<{folder:Folder;point:MenuPoint|null;anchor:HTMLElement|null}|null>(null);
 const navigate=useNavigate();

 const ids=useMemo(()=>new Set(items.map(f=>f.id)),[items]);
 // parentId -> children, built once per data change: the render never filters.
 const childrenOf=useMemo(()=>{
  const index=new Map<string,Folder[]>();
  for(const folder of items){
   const key=folder.parentId!==null&&ids.has(folder.parentId)?folder.parentId:"";
   const list=index.get(key);
   if(list)list.push(folder);else index.set(key,[folder]);
  }
  return index;
 },[items,ids]);
 // Flattened visible order: the keyboard walks this list, never the DOM.
 const visible=useMemo(()=>{
  const out:Folder[]=[];
  const walk=(parentId:string)=>{
   for(const folder of childrenOf.get(parentId)??[]){
    out.push(folder);
    if(expanded.has(folder.id))walk(folder.id);
   }
  };
  walk("");
  return out;
 },[childrenOf,expanded]);

 useEffect(()=>{
  // While the node menu is open it owns keyboard focus; stealing it back to
  // the treeitem here would break "focus moves into the menu on open".
  if(!focusedId||nodeMenu)return;
  const node=document.querySelector<HTMLElement>(`li[data-folder-id="${focusedId}"]`);
  node?.focus();
 },[focusedId,nodeMenu]);

 function toggle(id:string,force?:boolean){
  setExpanded(old=>{
   const next=new Set(old);
   const shouldOpen=force??!next.has(id);
   if(shouldOpen)next.add(id);else next.delete(id);
   return next;
  });
 }

 function focusIndex(index:number){
  if(visible.length===0)return;
  const target=visible[Math.max(0,Math.min(visible.length-1,index))];
  if(target)setFocusedId(target.id);
 }

 function onTreeKeyDown(event:KeyboardEvent<HTMLUListElement>){
  if(!focusedId)return;
  const index=visible.findIndex(f=>f.id===focusedId);
  if(index<0)return;
  const current=visible[index];
  if(!current)return;
  const hasChildren=(childrenOf.get(current.id)??[]).length>0;
  const isExpanded=expanded.has(current.id);
  const parent=current.parentId!==null&&ids.has(current.parentId)?current.parentId:null;
  switch(event.key){
   case "ArrowDown":
    event.preventDefault();focusIndex(index+1);break;
   case "ArrowUp":
    event.preventDefault();focusIndex(index-1);break;
   case "ArrowRight":
    // Expand a collapsed parent, otherwise step into its first child.
    event.preventDefault();
    if(hasChildren&&!isExpanded)toggle(current.id,true);
    else if(isExpanded)focusIndex(index+1);
    break;
   case "ArrowLeft":
    // Collapse an expanded parent, otherwise step up to the parent.
    event.preventDefault();
    if(isExpanded)toggle(current.id,false);
    else if(parent)setFocusedId(parent);
    break;
   case "Home":
    event.preventDefault();focusIndex(0);break;
   case "End":
    event.preventDefault();focusIndex(visible.length-1);break;
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

 function openNodeMenu(folder:Folder,point:MenuPoint|null){
  const node=document.querySelector<HTMLElement>(`li[data-folder-id="${folder.id}"]`);
  setFocusedId(folder.id);
  setNodeMenu({folder,point,anchor:node});
 }

 // The menu reuses the page's FolderActions flows through callbacks, so rename
 // and delete never duplicate the dialog logic; admin-only entries are hidden
 // for non-admins (WF-11).
 function nodeMenuItems(folder:Folder):MenuItem[]{
  const items:MenuItem[]=[{id:"rename",label:"重命名目录",onSelect:()=>onRenameFolder?.(folder)}];
  if(isAdmin){
   items.push({id:"grants",label:"授权管理",onSelect:()=>onManageGrants?.(folder)});
   items.push({id:"policy",label:"审批策略",onSelect:()=>onManagePolicy?.(folder)});
  }
  items.push({id:"delete",label:"删除目录",danger:true,onSelect:()=>onDeleteFolder?.(folder)});
  return items;
 }

 return <>
  <ul className="tree" role="tree" aria-label="目录树" onKeyDown={onTreeKeyDown}>
   {branch("",0)}
  </ul>
  {nodeMenu&&<Menu open label={nodeMenu.folder.name+" 目录菜单"} items={nodeMenuItems(nodeMenu.folder)}
   anchor={nodeMenu.anchor} point={nodeMenu.point} onClose={()=>setNodeMenu(null)}/>}
 </>;

 function branch(parentId:string,depth:number):React.ReactNode{
  if(depth>32)return null;
  const level=childrenOf.get(parentId)??[];
  return level.map(f=>{
   const children=childrenOf.get(f.id)??[];
   const isExpanded=expanded.has(f.id);
   return <li key={f.id} data-folder-id={f.id} role="treeitem"
    aria-expanded={children.length>0?isExpanded:undefined}
    aria-current={f.id===selected?"page":undefined}
    tabIndex={focusedId===f.id||(focusedId===null&&visible[0]?.id===f.id)?0:-1}
    // focusin bubbles: only the treeitem that is itself the focus target may
    // claim the focus state, otherwise an ancestor would overwrite it.
    onFocus={event=>{if(event.target===event.currentTarget)setFocusedId(f.id);}}
    onContextMenu={event=>{event.preventDefault();openNodeMenu(f,{x:event.clientX,y:event.clientY});}}>
    <div className={"tree-row "+(f.id===selected?"on":"")} style={{paddingLeft:String(depth*16)+"px"}}>
     <button aria-label={isExpanded?"折叠":"展开"} tabIndex={-1}
      onClick={()=>toggle(f.id)}>{children.length?(isExpanded?"▾":"▸"):" "}</button>
     <Link to={"/doc?folder="+encodeURIComponent(f.id)} tabIndex={-1}>{f.name}</Link>
    </div>
    {isExpanded&&<ul role="group">{branch(f.id,depth+1)}</ul>}
   </li>;
  });
 }
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
