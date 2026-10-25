import {useEffect,useState} from "react";
import {Link,useLocation} from "react-router-dom";
import {RareButton} from "../../shared/ui/rare";
import {request} from "../../shared/http";
import {observeWorkspaceChange} from "../../shared/resourceSync";

type PageLink={id:string;title:string;parentId:string|null;folderId:string|null};
// Reusable resource rail: knowledge is part of the Finder navigation, not a
// second application and never a substitute for the file hierarchy.
export function KnowledgeFinderRail(){
 const [items,setItems]=useState<PageLink[]>([]);
 const [refresh,setRefresh]=useState(0);
 const [expanded,setExpanded]=useState<Set<string>>(()=>new Set());
 const location=useLocation();
 const selected=new URLSearchParams(location.search).get("page");
 useEffect(()=>observeWorkspaceChange(()=>setRefresh(v=>v+1),["folder","file"]),[]);
 useEffect(()=>{let active=true;
  request<PageLink[]>("/knowledge/pages").then(data=>{if(active)setItems(data||[])})
   .catch(()=>{if(active)setItems([])});
  return()=>{active=false};
 },[location.pathname,selected,refresh]);
 const index=new Map(items.map(p=>[p.id,p]));
 function children(parent:string|null,level=0):React.ReactNode{
  if(level>8)return null;
  return items.filter(p=>p.parentId===parent||(level===0&&!index.has(p.parentId||""))).map(p=>{
   const hasChildren=items.some(x=>x.parentId===p.id);
   const show=expanded.has(p.id)||p.id===selected||items.some(x=>x.parentId===p.id&&x.id===selected);
   return <div key={p.id}>
    <div className={"kn-finder-item"+(p.id===selected?" is-current":"")} style={{paddingLeft:8+level*12}}>
     {hasChildren?<RareButton type="button" tone="ghost" aria-label={show?"收起子页面":"展开子页面"}
      onClick={()=>setExpanded(old=>{const next=new Set(old);if(next.has(p.id))next.delete(p.id);else next.add(p.id);return next;})}>{show?"⌄":"›"}</RareButton>:<span className="kn-finder-indent"/>}
     <Link to={"/knowledge?page="+encodeURIComponent(p.id)} title={p.title}>▤ {p.title}</Link>
    </div>
    {hasChildren&&show?children(p.id,level+1):null}
   </div>;
  });
 }
 return <section className="finder-nav-section kn-finder-section" aria-label="知识页面导航">
  <div className="finder-nav-heading">
   <Link className="finder-nav-label finder-nav-section-link" to="/knowledge">知识页面</Link>
   <Link className="kn-finder-add" to="/knowledge" title="打开知识空间创建页面" aria-label="打开知识空间">＋</Link>
  </div>
  <div className="kn-finder-tree">{children(null)}</div>
  {!items.length?<Link to="/knowledge" className="finder-nav-more">新建知识页</Link>:null}
 </section>;
}
