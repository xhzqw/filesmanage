import {useEffect,useRef,useState,type KeyboardEvent,type ReactNode} from "react";
import {RareButton,RareInput,RareNotice} from "../../shared/ui/rare";
import {FolderResourceIcon} from "../../shared/ui/ResourceIcons";
import {errorCopy} from "../../shared/errors";
import {permissionsApi,type FolderPage,type ResourceFolder} from "./permissionsApi";
import "./permissions.css";

type LoadState="loading"|"ready"|"failed";
const EMPTY_PAGE:FolderPage={items:[],nextCursor:""};

// Directory resource tree, not the department hierarchy. Every expansion and
// search is a keyset page from the server, not a browser-side full-tree query.
export function ResourceBrowser({selected,onSelect}:{selected:string;onSelect:(folder:ResourceFolder)=>void}){
 const [pages,setPages]=useState<Record<string,FolderPage>>({});
 const [loading,setLoading]=useState<Record<string,boolean>>({"":true});
 const [errors,setErrors]=useState<Record<string,string>>({});
 const [expanded,setExpanded]=useState<Set<string>>(()=>new Set());
 const [focusedId,setFocusedId]=useState("");
 const treeRef=useRef<HTMLUListElement>(null);

 const [query,setQuery]=useState("");
 const [searchPage,setSearchPage]=useState<FolderPage>(EMPTY_PAGE);
 const [searchState,setSearchState]=useState<LoadState>("ready");
 const [searchError,setSearchError]=useState("");
 const [moreSearch,setMoreSearch]=useState(false);
 const busyParents=useRef(new Set<string>());
 const searchRef=useRef(0);
 const requestSerial=useRef<Record<string,number>>({});
 // Route switching may unmount the browser while its initial root fetch is
 // still pending. Never let a late reply reselect a folder or overwrite the
 // user's new permission/audit view.
 const alive=useRef(false);
 const selectedRef=useRef(selected);
 const selectRef=useRef(onSelect);
 selectedRef.current=selected;
 selectRef.current=onSelect;

 async function load(parentId:string,cursor=""){
  if(busyParents.current.has(parentId))return;
  busyParents.current.add(parentId);
  const generation=(requestSerial.current[parentId]??0)+1;
  requestSerial.current[parentId]=generation;
  setLoading(old=>({...old,[parentId]:true}));
  setErrors(old=>({...old,[parentId]:""}));
  try{
   const page=await permissionsApi.children(parentId,cursor);
   if(!alive.current||requestSerial.current[parentId]!==generation)return;
   setPages(old=>({...old,[parentId]:cursor
    ?{items:[...(old[parentId]?.items??[]),...page.items],nextCursor:page.nextCursor}
    :page}));
   // Show an actionable permission overview immediately on first entry.
   // Respect explicit folder URLs and user choices during an in-flight load.
   const first=page.items[0];
   if(parentId===""&&!cursor&&!selectedRef.current&&first){
    selectRef.current(first);
    if(first.hasChildren){
     setExpanded(old=>new Set(old).add(first.id));
     void load(first.id);
    }
   }
  }catch(e){
   if(alive.current&&requestSerial.current[parentId]===generation)setErrors(old=>({...old,[parentId]:errorCopy(e,"目录读取失败")}));
  }finally{
   busyParents.current.delete(parentId);
   if(alive.current&&requestSerial.current[parentId]===generation)setLoading(old=>({...old,[parentId]:false}));
  }
 }
 useEffect(()=>{
  alive.current=true;
  void load("");
  return()=>{alive.current=false;};
 },[]);
 const needle=query.trim();
 useEffect(()=>{
  const serial=++searchRef.current;
  if(!needle){setSearchPage(EMPTY_PAGE);setSearchState("ready");return;}
  setSearchState("loading");
  const timer=window.setTimeout(()=>{
   permissionsApi.search(needle).then(page=>{
    if(serial===searchRef.current){setSearchPage(page);setSearchState("ready");}
   }).catch(e=>{
    if(serial===searchRef.current){setSearchError(errorCopy(e,"搜索失败"));setSearchState("failed");}
   });
  },250);
  return()=>window.clearTimeout(timer);
 },[needle]);
 async function loadMoreSearch(){
  if(!searchPage.nextCursor||moreSearch)return;
  const serial=searchRef.current;
  setMoreSearch(true);
  try{
   const page=await permissionsApi.search(needle,searchPage.nextCursor);
   if(serial===searchRef.current)setSearchPage(old=>({items:[...old.items,...page.items],nextCursor:page.nextCursor}));
  }catch(e){if(serial===searchRef.current){setSearchError(errorCopy(e,"加载更多结果失败"));setSearchState("failed");}}
  finally{setMoreSearch(false);}
 }
 function toggle(folder:ResourceFolder){
  if(!folder.hasChildren)return;
  if(expanded.has(folder.id))setExpanded(old=>{const next=new Set(old);next.delete(folder.id);return next;});
  else{
   setExpanded(old=>new Set(old).add(folder.id));
   if(!pages[folder.id])void load(folder.id);
  }
 }
 function onTreeKeyDown(event:KeyboardEvent<HTMLUListElement>){
  const current=(event.target as HTMLElement).closest<HTMLElement>('li[role="treeitem"]');
  if(!current||!treeRef.current?.contains(current))return;
  const visible=[...treeRef.current.querySelectorAll<HTMLElement>('li[role="treeitem"]')];
  const index=visible.indexOf(current);
  if(index<0)return;
  const folderId=current.dataset.folderId??"";
  const folder=Object.values(pages).flatMap(page=>page.items).find(row=>row.id===folderId);
  const focus=(node:HTMLElement|undefined|null)=>{
   if(node){setFocusedId(node.dataset.folderId??"");node.focus();}
  };
  switch(event.key){
   case "ArrowDown":event.preventDefault();focus(visible[index+1]);break;
   case "ArrowUp":event.preventDefault();focus(visible[index-1]);break;
   case "Home":event.preventDefault();focus(visible[0]);break;
   case "End":event.preventDefault();focus(visible[visible.length-1]);break;
   case "ArrowRight":
    event.preventDefault();
    if(folder?.hasChildren&&!expanded.has(folderId))toggle(folder);
    else if(folder?.hasChildren&&visible[index+1]?.parentElement?.closest('li[role="treeitem"]')===current)
     focus(visible[index+1]);
    break;
   case "ArrowLeft":
    event.preventDefault();
    if(folder?.hasChildren&&expanded.has(folderId))toggle(folder);
    else focus(current.parentElement?.closest<HTMLElement>('li[role="treeitem"]'));
    break;
   case "Enter":case " ":
    event.preventDefault();if(folder)onSelect(folder);
    break;
  }
 }
 function rows(parent:string,depth:number,ancestors:Set<string>):ReactNode{
  if(depth>32)return null;
  return (pages[parent]?.items??[]).map(folder=>{
   if(ancestors.has(folder.id))return null;
   const open=expanded.has(folder.id);
   const nextAncestors=new Set(ancestors).add(folder.id);
   return <li key={folder.id} role="treeitem" data-folder-id={folder.id}
    aria-level={depth+1} aria-expanded={folder.hasChildren?open:undefined}
    aria-selected={selected===folder.id}
    tabIndex={focusedId===folder.id||(!focusedId&&pages[""]?.items[0]?.id===folder.id)?0:-1}
    onFocus={event=>{if(event.target===event.currentTarget)setFocusedId(folder.id);}}>
    <div className={"perm-tree-row"+(selected===folder.id?" selected":"")} style={{paddingLeft:depth*14+6}}>
     {folder.hasChildren?<RareButton type="button" className="perm-tree-toggle" aria-expanded={open}
      aria-label={(open?"折叠":"展开")+folder.name} tabIndex={-1} onClick={()=>{setFocusedId(folder.id);toggle(folder);}}>{open?"▾":"▸"}</RareButton>
      :<span className="perm-tree-spacer" aria-hidden="true"/>}
     <FolderResourceIcon size={16} open={open} className="perm-folder-glyph"/>
     <RareButton type="button" className="perm-tree-name" tabIndex={-1} aria-current={selected===folder.id?"true":undefined}
      onClick={()=>{setFocusedId(folder.id);onSelect(folder);}} title={folder.name}>{folder.name}</RareButton>
    </div>
    {open&&<>
     {loading[folder.id]&&<p className="hint perm-tree-info">正在读取…</p>}
     {errors[folder.id]&&<p role="alert" className="perm-tree-info">{errors[folder.id]} <RareButton type="button" onClick={()=>void load(folder.id)}>重试</RareButton></p>}
     <ul role="group">{rows(folder.id,depth+1,nextAncestors)}</ul>
     {pages[folder.id]?.nextCursor&&<RareButton type="button" className="perm-more" disabled={loading[folder.id]}
      onClick={()=>void load(folder.id,pages[folder.id]?.nextCursor??"")}>加载更多</RareButton>}
    </>}
   </li>;
  });
 }
 return <aside className="perm-browser" aria-label="资源目录">
  <div className="perm-browser-title"><div><strong>资源目录</strong></div>
   <RareButton type="button" className="secondary-action" onClick={()=>void load("")}>刷新</RareButton></div>
  <label className="perm-browser-search"><span>搜索目录</span><RareInput type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="输入目录名称"/></label>
  <div className="perm-browser-scroll">
   {needle?<>
    {searchState==="loading"&&<p className="hint">正在搜索…</p>}
    {searchState==="failed"&&<RareNotice tone="danger">{searchError}</RareNotice>}
    {searchState==="ready"&&searchPage.items.length===0&&<p className="hint">没有匹配的目录</p>}
    {searchState==="ready"&&searchPage.items.map(f=><RareButton type="button" key={f.id}
     className={"perm-result"+(selected===f.id?" selected":"")} aria-current={selected===f.id?"true":undefined}
     onClick={()=>onSelect(f)}>
     <span>{f.name}</span><small>{f.path||"资源目录"}</small></RareButton>)}
    {searchState==="ready"&&searchPage.nextCursor&&<RareButton type="button" className="perm-more" disabled={moreSearch} onClick={()=>void loadMoreSearch()}>加载更多结果</RareButton>}
   </>:<>
    {loading[""]&&<p className="hint">正在读取资源目录…</p>}
    {errors[""]&&<RareNotice tone="danger">{errors[""]} <RareButton type="button" onClick={()=>void load("")}>重试</RareButton></RareNotice>}
    {pages[""]?.items.length===0&&<p className="hint">没有目录</p>}
    <ul className="perm-tree" ref={treeRef} role="tree" aria-label="资源目录树" onKeyDown={onTreeKeyDown}>{rows("",0,new Set())}</ul>
    {pages[""]?.nextCursor&&<RareButton type="button" className="perm-more" disabled={loading[""]}
     onClick={()=>void load("",pages[""]?.nextCursor??"")}>加载更多根目录</RareButton>}
   </>}
  </div>
 </aside>;
}
