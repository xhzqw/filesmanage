import {useState} from "react";
import {Link} from "react-router-dom";
import type{Folder}from "../../entities/folder/model";
export function FolderTree({items,selected}:{items:Folder[];selected:string}){
 const[expanded,setExpanded]=useState<Set<string>>(new Set(["folder_root","folder_market","folder_rd"]));
 const children=(id:string|null)=>items.filter(f=>f.parentId===id);
 function branch(id:string|null,depth:number):React.ReactNode{
  if(depth>32)return null;
  return children(id).map(f=><li key={f.id}>
   <div className={"tree-row "+(f.id===selected?"on":"")} style={{paddingLeft:String(depth*16)+"px"}}>
    <button aria-label={expanded.has(f.id)?"折叠":"展开"} onClick={()=>setExpanded(old=>{const next=new Set(old);if(next.has(f.id))next.delete(f.id);else next.add(f.id);return next})}>{children(f.id).length?(expanded.has(f.id)?"▾":"▸"):" "}</button>
    <Link to={"/doc?folder="+encodeURIComponent(f.id)}>{f.name}</Link>
   </div>
   {expanded.has(f.id)&&<ul>{branch(f.id,depth+1)}</ul>}
  </li>);
 }
 return <ul className="tree">{branch(null,0)}</ul>;
}
