import {useEffect,useLayoutEffect,useMemo,useRef,useState,type KeyboardEvent,type ReactNode} from "react";
import {RareBadge,RareButton,RareInput,RareNotice} from "../../shared/ui/rare";
import {FolderResourceIcon} from "../../shared/ui/ResourceIcons";
import type {Department} from "./api";
import {IconChevron,IconOrganization,IconSearch,IconUsers} from "./OrganizationIcons";
import {ancestorPathOf,fullPathOf} from "./organizationTreeUtils";

type LoadState="loading"|"ready"|"failed";
const MAX_DEPTH=32;
const SEARCH_LIMIT=30;
const ROOT_ID="__all";
const UNASSIGNED_ID="__unassigned";

/** One roving tab stop for the entire hierarchy, including the all/unassigned rows.
 * Browser focus (not an invisible highlight) follows the keyboard cursor. */
export function DepartmentNavigator({departments,departmentsState,deptIndex,deptById,deptCounts,
 selectedDepartment,onSelect,usersCount,unassignedCount,onRetry}:{
 departments:Department[];
 departmentsState:LoadState;
 deptIndex:Map<string,Department[]>;
 deptById:Map<string,Department>;
 deptCounts:Map<string,number>;
 selectedDepartment:string;
 onSelect:(id:string)=>void;
 usersCount:number;
 unassignedCount:number;
 onRetry:()=>void;
}){
 const [query,setQuery]=useState("");
 const [expanded,setExpanded]=useState<Set<string>>(()=>new Set());
 const [focusedId,setFocusedId]=useState(ROOT_ID);
 const rootsExpanded=useRef(false);
 const treeRef=useRef<HTMLUListElement>(null);
 const focusRequested=useRef(false);
 useEffect(()=>{
  if(!departments.length||rootsExpanded.current)return;
  rootsExpanded.current=true;
  const ids=new Set(departments.map(d=>d.id));
  setExpanded(new Set(departments.filter(d=>d.parentId===null||!ids.has(d.parentId)).map(d=>d.id)));
 },[departments]);
 const matches=useMemo(()=>{
  const needle=query.trim().toLowerCase();
  if(!needle)return {items:[] as Department[],truncated:false};
  const all=departments.filter(d=>d.name.toLowerCase().includes(needle));
  return {items:all.slice(0,SEARCH_LIMIT),truncated:all.length>SEARCH_LIMIT};
 },[departments,query]);
 function toggle(id:string,force?:boolean){
  setExpanded(old=>{
   const next=new Set(old);
   if(force??!next.has(id))next.add(id);else next.delete(id);
   return next;
  });
 }
 function reveal(id:string){
  const ancestors:string[]=[];
  const seen=new Set<string>();
  let current=deptById.get(id)?.parentId??null;
  while(current!==null&&!seen.has(current)){
   seen.add(current);ancestors.push(current);
   current=deptById.get(current)?.parentId??null;
  }
  setExpanded(old=>new Set([...old,...ancestors]));
  setQuery("");
  onSelect(id);
  focusRequested.current=true;
  setFocusedId(id);
 }
 useLayoutEffect(()=>{
  if(!focusRequested.current)return;
  const node=Array.from(treeRef.current?.querySelectorAll<HTMLElement>('li[role="treeitem"]')??[])
   .find(n=>n.dataset.treeId===focusedId);
  if(!node)return;
  if(document.activeElement!==node)node.focus();
  // Do not consume the request until the browser actually accepted the focus.
  if(document.activeElement===node)focusRequested.current=false;
 },[focusedId,expanded,departmentsState]);
 // A DOM-derived visible tree respects every collapsed branch and keeps root/unassigned in the order.
 function onTreeKeyDown(event:KeyboardEvent<HTMLUListElement>){
  const current=(event.target as HTMLElement).closest<HTMLElement>('li[role="treeitem"]');
  if(!current||!treeRef.current?.contains(current))return;
  const items=[...treeRef.current.querySelectorAll<HTMLElement>('li[role="treeitem"]')];
  const index=items.indexOf(current);
  if(index<0)return;
  const id=current.dataset.treeId??ROOT_ID;
  const move=(target:HTMLElement|undefined)=>{if(target){focusRequested.current=true;setFocusedId(target.dataset.treeId??ROOT_ID);target.focus();}};
  const child=deptById.get(id);
  const hasChildren=!!child&&(deptIndex.get(id)?.length??0)>0;
  switch(event.key){
   case "ArrowDown":event.preventDefault();move(items[index+1]);break;
   case "ArrowUp":event.preventDefault();move(items[index-1]);break;
   case "Home":event.preventDefault();move(items[0]);break;
   case "End":event.preventDefault();move(items[items.length-1]);break;
   case "ArrowRight":
    event.preventDefault();
    if(hasChildren&&!expanded.has(id))toggle(id,true);
    else if(hasChildren)move(items[index+1]?.parentElement?.closest('li[role="treeitem"]')===current?items[index+1]:undefined);
    break;
   case "ArrowLeft":
    event.preventDefault();
    if(hasChildren&&expanded.has(id))toggle(id,false);
    else move(current.parentElement?.closest<HTMLElement>('li[role="treeitem"]')??undefined);
    break;
   case "Enter":case " ":
    event.preventDefault();onSelect(id===ROOT_ID?"":id);
    break;
  }
 }
 const rendered=new Set<string>();
 function renderDepartments(parentId:string,depth:number):ReactNode{
  if(depth>MAX_DEPTH)return null;
  return (deptIndex.get(parentId)??[]).map(d=>{
   if(rendered.has(d.id))return null;
   rendered.add(d.id);
   const open=expanded.has(d.id),hasChildren=(deptIndex.get(d.id)?.length??0)>0;
   const isSelected=selectedDepartment===d.id;
   return <li key={d.id} role="treeitem" data-dept-id={d.id} data-tree-id={d.id}
    aria-level={depth+1} aria-expanded={hasChildren?open:undefined} aria-selected={isSelected}
    tabIndex={focusedId===d.id?0:-1}
    onFocus={e=>{if(e.currentTarget===e.target)setFocusedId(d.id);}}
    onClick={()=>{setFocusedId(d.id);onSelect(d.id);}}>
    <div className={"tree-row "+(isSelected?"on":"")} style={{paddingLeft:depth*16+14}}>
     {hasChildren?<RareButton type="button" tabIndex={-1} aria-label={(open?"折叠 ":"展开 ")+d.name}
      className={"org-tree-chevron"+(open?" open":"")} onClick={e=>{e.stopPropagation();setFocusedId(d.id);toggle(d.id);}}>
      <IconChevron open={open}/>
     </RareButton>:<span className="org-tree-chevron-spacer" aria-hidden="true"/>}
     <span className="org-tree-icon" aria-hidden="true"><FolderResourceIcon open={open} size={18}/></span>
     <RareButton type="button" className="org-node-label" tabIndex={-1}
      title={fullPathOf(deptById,d.id)+"｜含子部门 "+String(deptCounts.get(d.id)??0)+" 人"}
      onClick={()=>{setFocusedId(d.id);onSelect(d.id);}}>{d.name}</RareButton>
     <span className="org-node-count">（{deptCounts.get(d.id)??0}）</span>
    </div>
    {open&&<ul role="group">{renderDepartments(d.id,depth+1)}</ul>}
   </li>;
  });
 }
 const allSelected=selectedDepartment==="",unassignedSelected=selectedDepartment===UNASSIGNED_ID;
 // Keep cached nodes mounted during realtime refetches so focus and scroll survive.
 const showTree=departmentsState==="ready"||departments.length>0;
 return <section className="org-card org-dept-card" aria-label="组织架构树">
  <div className="org-card-header"><h3 className="org-card-title">
   <IconOrganization/><span>组织架构</span>
   <RareBadge tone="neutral" className="org-count-pill">{departments.length} 部门</RareBadge>
  </h3></div>
  {departmentsState==="loading"&&departments.length===0&&<p className="hint org-inline-message">正在读取部门…</p>}
  {departmentsState==="failed"&&<div className="org-inline-message">
   <RareNotice tone="danger">读取部门失败，可重试；已有组织树将暂时保留。</RareNotice>
   <RareButton type="button" className="secondary-action" onClick={onRetry}>重试</RareButton>
  </div>}
  {showTree&&<>
   <div className="org-search-box">
    <IconSearch/>
    <RareInput id="org-dept-search" className="org-search" type="search" autoComplete="off"
     value={query} onChange={e=>setQuery(e.target.value)} placeholder="按部门名称查找"/>
   </div>
   {!!query.trim()&&<div className="org-hits-panel">
    {matches.items.length===0?<p className="hint">没有匹配的部门。</p>
     :<ul className="org-hits">{matches.items.map(d=><li key={d.id}>
      <RareButton type="button" aria-label={"选择部门 "+fullPathOf(deptById,d.id)} onClick={()=>reveal(d.id)}>
       <span className="org-hit-name">{d.name}</span>
       <span className="hint">{ancestorPathOf(deptById,d.id)||"顶层部门"}</span>
      </RareButton>
     </li>)}</ul>}
    {matches.truncated&&<p className="hint">结果较多，仅显示前 {matches.items.length} 个，请细化关键词。</p>}
   </div>}
   <div className="org-tree-scroll"><ul ref={treeRef} className="tree" role="tree" aria-label="部门树" onKeyDown={onTreeKeyDown}>
    <li role="treeitem" data-tree-id={ROOT_ID} aria-level={1} aria-selected={allSelected}
     tabIndex={focusedId===ROOT_ID?0:-1} onFocus={()=>setFocusedId(ROOT_ID)}
     onClick={()=>{setFocusedId(ROOT_ID);onSelect("");}}>
     <div className={"tree-row org-tree-root-row "+(allSelected?"on":"")}>
      <span className="org-tree-chevron-spacer" aria-hidden="true"/>
      <span className="org-tree-icon" aria-hidden="true"><IconOrganization/></span>
      <RareButton type="button" className="org-node-label" tabIndex={-1}
       title={"全体组织｜共 "+usersCount+" 人"} onClick={()=>onSelect("")}>全体组织</RareButton>
      <span className="org-node-count">（{usersCount}）</span>
     </div>
    </li>
    {departments.length===0&&<li role="none" className="hint org-inline-message">还没有部门；可用上方按钮创建。</li>}
    {renderDepartments("",0)}
    {unassignedCount>0&&<li role="treeitem" data-tree-id={UNASSIGNED_ID} aria-level={1}
     aria-selected={unassignedSelected} tabIndex={focusedId===UNASSIGNED_ID?0:-1}
     onFocus={()=>setFocusedId(UNASSIGNED_ID)}
     onClick={()=>{setFocusedId(UNASSIGNED_ID);onSelect(UNASSIGNED_ID);}}>
     <div className={"tree-row org-tree-root-row "+(unassignedSelected?"on":"")}>
      <span className="org-tree-chevron-spacer" aria-hidden="true"/>
      <span className="org-tree-icon" aria-hidden="true"><IconUsers/></span>
      <RareButton type="button" className="org-node-label" tabIndex={-1}
       title={"未分配部门｜共 "+unassignedCount+" 人"} onClick={()=>onSelect(UNASSIGNED_ID)}>未分配部门</RareButton>
      <span className="org-node-count">（{unassignedCount}）</span>
     </div>
    </li>}
   </ul></div>
  </>}
 </section>;
}
