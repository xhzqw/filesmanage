import {useEffect,useRef,useState,type FormEvent} from "react";
import {Link} from "react-router-dom";
import {collaborationApi,formatBytes} from "./api";
import type {FileItem} from "../../entities/file/model";
import "./search.css";

// The API caps the authorized total at 1001, which the UI renders as "1000+"
// (SPEC §10.2 permits a hard-capped total).
const TOTAL_CAP=1000;
const PAGE_SIZES=[50,100,200];
const DEFAULT_PAGE_SIZE=50;

// Split the snippet into text nodes and <mark> around the query. React escapes
// text nodes by default, so a snippet containing HTML renders literally
// (SPEC §8.1/§10.3); nothing is ever passed to innerHTML.
function Highlighted({text,query}:{text:string;query:string}){
 if(!query)return <>{text}</>;
 const parts:{value:string;hit:boolean}[]=[];
 const haystack=text.toLowerCase();
 const needle=query.toLowerCase();
 let cursor=0;
 let at=haystack.indexOf(needle);
 while(at>=0){
  if(at>cursor)parts.push({value:text.slice(cursor,at),hit:false});
  parts.push({value:text.slice(at,at+query.length),hit:true});
  cursor=at+query.length;
  at=haystack.indexOf(needle,cursor);
 }
 if(cursor<text.length)parts.push({value:text.slice(cursor),hit:false});
 return <>{parts.map((part,index)=>part.hit
  ?<mark key={index}>{part.value}</mark>
  :<span key={index}>{part.value}</span>)}</>;
}

type Query={q:string;uploader:string;type:string;sort:string;limit:number};

// Full-text search workbench (SPEC C13/§10, WF-30): query plus uploader/type/
// sort filters, authorized results with snippets and safe highlighting, and
// cursor paging that appends strictly by the server's nextCursor (DI-16 §9).
export function SearchPanel(){
 const[q,setQ]=useState("");
 const[uploader,setUploader]=useState("");
 const[type,setType]=useState("");
 const[sort,setSort]=useState("updated_desc");
 const[pageSize,setPageSize]=useState<number>(DEFAULT_PAGE_SIZE);
 const[query,setQuery]=useState<Query|null>(null);
 const[items,setItems]=useState<FileItem[]>([]);
 const[total,setTotal]=useState(0);
 const[nextCursor,setNextCursor]=useState("");
 const[status,setStatus]=useState<"idle"|"loading"|"ready"|"failed">("idle");
 const[moreStatus,setMoreStatus]=useState<"idle"|"loading"|"failed">("idle");
 const[message,setMessage]=useState("");
 const[reloadToken,setReloadToken]=useState(0);
 // Query generation plus the append mutex (DI-16 §9): the generation discards
 // every response of an older revision, the mutex keeps 加载更多 single-flight.
 const epochRef=useRef(0);
 const moreBusyRef=useRef(false);

 // The first page of the committed query. Bumping the generation synchronously
 // on a new query (and on cleanup) discards a response still in flight, so an
 // older page can never overwrite a newer one; rows are replaced, not appended.
 useEffect(()=>{
  if(!query)return;
  const epoch=++epochRef.current;
  // The new revision owns the append state: a previous revision's page request
  // is stale now, and this first page is not a 加载更多.
  moreBusyRef.current=false;
  setStatus("loading");
  setMoreStatus("idle");
  collaborationApi.search({...query})
   .then(page=>{
    if(epochRef.current!==epoch)return;
    setItems(page.items);
    setTotal(page.total);
    setNextCursor(page.nextCursor??"");
    setStatus("ready");
   })
   .catch(()=>{if(epochRef.current===epoch)setStatus("failed");});
  return()=>{epochRef.current++;};
 },[query,reloadToken]);

 function submit(event:FormEvent){
  event.preventDefault();
  setMessage("");
  if(!q.trim()){
   setMessage("请输入检索关键词");
   return;
  }
  // Invalidate the previous revision before React commits, so a page request
  // that resolves in the gap between render and effect cannot append old rows.
  epochRef.current++;
  moreBusyRef.current=false;
  setQuery({q:q.trim(),uploader:uploader.trim(),type:type.trim(),sort,limit:pageSize});
 }

 // Appends the server's next page. The cursor is the only append authority: rows
 // go in exactly as returned, never sliced or re-sorted client-side. A failed
 // page leaves nextCursor untouched, so 重试 re-requests the same page instead
 // of skipping or duplicating already-loaded rows.
 async function loadMore(){
  if(!query||nextCursor===""||moreBusyRef.current)return;
  const epoch=epochRef.current;
  const cursor=nextCursor;
  moreBusyRef.current=true;
  setMoreStatus("loading");
  try{
   const page=await collaborationApi.search({...query,cursor});
   if(epochRef.current!==epoch)return;
   setItems(prev=>{
    const seen=new Set(prev.map(item=>item.id));
    const fresh=page.items.filter(item=>!seen.has(item.id));
    return fresh.length===0?prev:prev.concat(fresh);
   });
   setTotal(page.total);
   setNextCursor(page.nextCursor??"");
   setMoreStatus("idle");
  }catch{
   if(epochRef.current===epoch)setMoreStatus("failed");
  }finally{
   if(epochRef.current===epoch)moreBusyRef.current=false;
  }
 }

 // The count is what was actually loaded; the server's nextCursor is the only
 // "more" signal (DI-16 §9). An exhausted cursor with a count mismatch can only
 // mean the endpoint's hard cap, so the hint names a filter, not a dead action.
 const capped=total>TOTAL_CAP;
 const loadedLimit=query?.limit??DEFAULT_PAGE_SIZE;
 const hasMore=nextCursor!=="";
 const limitReached=!hasMore&&(capped||items.length<total);

 return <div className="work-body">
  <form className="toolbar search-bar" onSubmit={submit} role="search">
   <label htmlFor="search-q">关键词</label>
   <input id="search-q" value={q} onChange={event=>setQ(event.target.value)} placeholder="文件名或正文，如：预算" size={28}/>
   <label htmlFor="search-uploader">上传人</label>
   <input id="search-uploader" value={uploader} onChange={event=>setUploader(event.target.value)} size={12}/>
   <label htmlFor="search-type">类型</label>
   <input id="search-type" value={type} onChange={event=>setType(event.target.value)} placeholder="text/" size={10}/>
   <label className="sort-label" htmlFor="search-sort">排序
    <select id="search-sort" value={sort} onChange={event=>setSort(event.target.value)}>
     <option value="updated_desc">修改时间</option>
     <option value="name_asc">名称</option>
     <option value="size_desc">大小</option>
    </select>
   </label>
   <label className="sort-label" htmlFor="search-limit">每页
    <select id="search-limit" value={pageSize} onChange={event=>setPageSize(Number(event.target.value))}>
     {PAGE_SIZES.map(size=><option key={size} value={size}>{size} 条</option>)}
    </select>
   </label>
   <button className="primary" type="submit">检索</button>
   {message?<span className="error">{message}</span>:null}
  </form>

  {status==="loading"?<p className="notice" role="status">检索中…</p>:null}
  {status==="failed"?<>
   <p role="alert" className="notice error">检索失败，请稍后重试。</p>
   <button type="button" className="secondary-action" onClick={()=>setReloadToken(token=>token+1)}>重试</button>
  </>:null}
  {status==="ready"?<div className="table">
   <div className="search-total">已显示 {items.length} / 共 {capped?TOTAL_CAP+"+":total} 个结果 · 每页最多 {loadedLimit} 条（仅显示你有权访问的文件）{limitReached?<> · 已达本次检索可浏览的上限，请添加筛选条件缩小范围</>:null}</div>
   {items.length===0?<p className="empty">没有匹配的文件。换个关键词，或确认你有该内容的预览权限。</p>:(
    <table>
     <thead><tr><th>文件名</th><th>大小</th><th>上传人</th><th>版本</th><th>修改日期</th><th>所在目录</th></tr></thead>
     <tbody>
      {items.map(file=><tr key={file.id}>
       <td>
        <Link to={"/preview/"+file.id}>{file.name}</Link>
        {file.snippet?<div className="snippet"><Highlighted text={file.snippet} query={query?.q??""}/></div>:null}
       </td>
       <td>{formatBytes(file.sizeBytes)}</td>
       <td>{file.uploadedBy}</td>
       <td>v{file.currentVersionSeq}</td>
       <td>{new Date(file.updatedAt).toLocaleString("zh-CN")}</td>
       {/* Every search hit sits in a folder inside the caller's visible scope
           (postgres.collaboration scopeFolderSQL), so the target is listable. */}
       <td><Link to={"/doc?folder="+file.folderId} aria-label={"在目录中打开 "+file.name}>打开</Link></td>
      </tr>)}
     </tbody>
    </table>
   )}
   {hasMore?<div className="search-more">
    {moreStatus==="failed"?<span className="error" role="alert">加载下一页失败。</span>:null}
    <button type="button" className="secondary-action" disabled={moreStatus==="loading"} onClick={loadMore}>
     {moreStatus==="loading"?"加载中…":moreStatus==="failed"?"重试加载":"加载更多"}
    </button>
   </div>:null}
  </div>:null}
  {status==="idle"?<p className="empty">输入关键词开始检索。中文按相邻子串匹配，标题与正文都会参与。</p>:null}
 </div>;
}
