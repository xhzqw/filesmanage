import {useState} from "react";
import {Link} from "react-router-dom";
import type{Folder}from "../../entities/folder/model";
// Toggles insert/remove ids at runtime, so Set is the correct membership structure.
const DEFAULT_EXPANDED=["folder_root","folder_market","folder_rd"];
export function FolderTree({items,selected}:{items:Folder[];selected:string}){
 const[expanded,setExpanded]=useState<Set<string>>(()=>new Set<string>(DEFAULT_EXPANDED));
 // A folder whose parent sits outside the caller's visible set is a tree top level, so a
 // grant on a non-root folder still surfaces that folder instead of vanishing.
 const isTopLevel=(f:Folder):boolean=>f.parentId===null||!items.some(p=>p.id===f.parentId);
 function branch(id:string|null,depth:number):React.ReactNode{
  if(depth>32)return null;
  const level=id===null?items.filter(isTopLevel):items.filter(f=>f.parentId===id);
  return level.map(f=><li key={f.id}>
   <div className={"tree-row "+(f.id===selected?"on":"")} style={{paddingLeft:String(depth*16)+"px"}}>
    <button aria-label={expanded.has(f.id)?"折叠":"展开"} onClick={()=>setExpanded(old=>{const next=new Set(old);if(next.has(f.id))next.delete(f.id);else next.add(f.id);return next})}>{items.filter(c=>c.parentId===f.id).length?(expanded.has(f.id)?"▾":"▸"):" "}</button>
    <Link to={"/doc?folder="+encodeURIComponent(f.id)}>{f.name}</Link>
   </div>
   {expanded.has(f.id)&&<ul>{branch(f.id,depth+1)}</ul>}</li>);
 }
 return <ul className="tree">{branch(null,0)}</ul>;
}
