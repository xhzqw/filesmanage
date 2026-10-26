import {useEffect,useMemo,useState} from "react";
import {Link,useNavigate,useSearchParams} from "react-router-dom";
import {request} from "../shared/http";
import {RareButton,RareInput} from "../shared/ui/rare";

type PageNode={id:string;title:string;parentId:string|null;ownerId:string;folderId:string|null};
type Props={userId:string};
const route=(id:string)=>"/workbench?view=knowledge&page="+encodeURIComponent(id);

export function WorkbenchPageTree({userId}:Props){
 const [pages,setPages]=useState<PageNode[]>([]);
 const [expanded,setExpanded]=useState<Set<string>>(()=>new Set());
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [query,setQuery]=useState("");
 const [version,setVersion]=useState(0);
 const [params]=useSearchParams();
 const selected=params.get("view")==="knowledge"?params.get("page"):"";
 const navigate=useNavigate();
 useEffect(()=>{
  const changed=()=>setVersion(v=>v+1);
  window.addEventListener("filesmanage:knowledge-changed",changed);
  return()=>window.removeEventListener("filesmanage:knowledge-changed",changed);
 },[]);
 useEffect(()=>{
  let live=true;
  void request<PageNode[]>("/knowledge/pages")
   .then(data=>{if(live){setPages(data||[]);setError("");}})
   .catch(()=>{if(live)setError("页面暂时不可读取");});
  return()=>{live=false};
 },[version]);
 const normalized=query.trim().toLocaleLowerCase();
 const searchable=useMemo(()=>{
  if(!normalized)return pages;
  const byId=new Map(pages.map(page=>[page.id,page]));
  const visible=new Set<string>();
  for(const page of pages){
   if(!page.title.toLocaleLowerCase().includes(normalized))continue;
   let current:PageNode|undefined=page;
   const walked=new Set<string>();
   while(current&&!walked.has(current.id)){
    walked.add(current.id);visible.add(current.id);
    current=current.parentId?byId.get(current.parentId):undefined;
   }
  }
  return pages.filter(p=>visible.has(p.id));
 },[pages,normalized]);
 // Deep links must reveal every ancestor, not just the direct parent.
 // Keep expansion state user-controlled after the selected route is revealed.
 useEffect(()=>{
  if(!selected)return;
  const byId=new Map(pages.map(page=>[page.id,page]));
  const ancestors=new Set<string>();
  const visited=new Set<string>([selected]);
  let cursor=byId.get(selected)?.parentId;
  while(cursor&&!visited.has(cursor)&&ancestors.size<20){
   ancestors.add(cursor);visited.add(cursor);
   cursor=byId.get(cursor)?.parentId;
  }
  if(!ancestors.size)return;
  setExpanded(current=>{
   if([...ancestors].every(id=>current.has(id)))return current;
   return new Set([...current,...ancestors]);
  });
 },[pages,selected]);
 async function create(parentId=""){
  if(busy)return;
  setBusy(true);setError("");
  try{
   const p=await request<PageNode>("/knowledge/pages",{
    method:"POST",body:JSON.stringify({title:"无标题",parentId})
   });
   if(parentId)setExpanded(prev=>new Set(prev).add(parentId));
   window.dispatchEvent(new Event("filesmanage:knowledge-changed"));
   navigate(route(p.id));
  }catch{setError("新建失败，请检查页面权限。");}
  finally{setBusy(false);}
 }
 function tree(subset:PageNode[],parent:string|null,depth=0,ancestors=new Set<string>()):React.ReactNode{
  if(depth>20)return null;
  const scopeIds=new Set(subset.map(p=>p.id));
  const children=subset.filter(p=>p.parentId===parent||(parent===null&&p.parentId&&!scopeIds.has(p.parentId)));
  return children.filter(page=>!ancestors.has(page.id)).map(page=>{
   const hasChildren=subset.some(p=>p.parentId===page.id);
   const open=Boolean(normalized)||expanded.has(page.id);
   return <div key={page.id}>
    <div className={"wbn-tree-item"+(page.id===selected?" is-current":"")} style={{paddingLeft:8+depth*12}}>
     {hasChildren?<RareButton type="button" tone="ghost" className="wbn-expand"
       aria-label={open?"收起子页面":"展开子页面"} onClick={()=>setExpanded(prev=>{
        const next=new Set(prev);if(next.has(page.id))next.delete(page.id);else next.add(page.id);return next;
       })}>{open?"⌄":"›"}</RareButton>:<span className="wbn-expand-spacer"/>}
     <Link to={route(page.id)} title={page.title} className="wbn-page-link">
      <span aria-hidden="true">▤</span><span>{page.title}</span>
     </Link>
     {page.ownerId===userId?<RareButton type="button" tone="ghost" className="wbn-new-child"
      disabled={busy} aria-label={"在"+page.title+"下新建页面"} onClick={()=>void create(page.id)}>＋</RareButton>:null}
    </div>
    {hasChildren&&open?tree(subset,page.id,depth+1,new Set([...ancestors,page.id])):null}
   </div>;
  });
 }
 const privatePages=searchable.filter(p=>!p.folderId);
 const sharedPages=searchable.filter(p=>Boolean(p.folderId));
 return <section className="wbn-pages" aria-label="知识页面树">
  <div className="wbn-page-search"><RareInput value={query} onChange={e=>setQuery(e.target.value)}
    placeholder="搜索页面…" aria-label="搜索知识页面"/></div>
  <div className="wbn-pages-head"><span>私人页面</span>
   <RareButton type="button" tone="ghost" aria-label="新建知识页" disabled={busy}
    onClick={()=>void create()}>＋</RareButton>
  </div>
  <div className="wbn-pages-body">{tree(privatePages,null)}
   {!privatePages.length&&!pages.length&&!error?<RareButton type="button" tone="ghost" className="wbn-empty"
    disabled={busy} onClick={()=>void create()}>＋ 创建第一个页面</RareButton>:null}
   {normalized&&!privatePages.length?<p className="wbn-tree-hint">私人页面中没有匹配结果</p>:null}
   {error?<p role="status" className="wbn-tree-error">{error}</p>:null}
  </div>
  {sharedPages.length>0?<><div className="wbn-pages-head wbn-pages-shared"><span>团队页面</span></div>
   <div className="wbn-pages-body">{tree(sharedPages,null)}</div></>:null}
 </section>;
}
