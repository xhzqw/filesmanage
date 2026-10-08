import {useEffect,useState,type FormEvent} from "react";
import {Link} from "react-router-dom";
import {collaborationApi,formatBytes} from "./api";
import type {FileItem} from "../../entities/file/model";

// The API caps the authorized total at 1001, which the UI renders as "1000+"
// (SPEC §10.2 permits a hard-capped total).
const TOTAL_CAP=1000;
const PAGE_LIMIT=50;

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

type Query={q:string;uploader:string;type:string;sort:string};

// Full-text search workbench (SPEC C13/§10): query plus uploader/type/sort
// filters, authorized results with snippets and safe highlighting, and the
// same loading/empty/error feedback as every other page.
export function SearchPanel(){
 const[q,setQ]=useState("");
 const[uploader,setUploader]=useState("");
 const[type,setType]=useState("");
 const[sort,setSort]=useState("updated_desc");
 const[query,setQuery]=useState<Query|null>(null);
 const[items,setItems]=useState<FileItem[]>([]);
 const[total,setTotal]=useState(0);
 const[status,setStatus]=useState<"idle"|"loading"|"ready"|"failed">("idle");
 const[message,setMessage]=useState("");

 useEffect(()=>{
  if(!query)return;
  let valid=true;
  setStatus("loading");
  collaborationApi.search({...query,limit:PAGE_LIMIT})
   .then(page=>{
    if(!valid)return;
    setItems(page.items);
    setTotal(page.total);
    setStatus("ready");
   })
   .catch(()=>{if(valid)setStatus("failed");});
  return()=>{valid=false;};
 },[query]);

 function submit(event:FormEvent){
  event.preventDefault();
  setMessage("");
  if(!q.trim()){
   setMessage("请输入检索关键词");
   return;
  }
  setQuery({q:q.trim(),uploader:uploader.trim(),type:type.trim(),sort});
 }

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
   <button className="primary" type="submit">检索</button>
   {message?<span className="error">{message}</span>:null}
  </form>

  {status==="loading"?<p className="notice">检索中…</p>:null}
  {status==="failed"?<p className="notice error">检索失败，请稍后重试。</p>:null}
  {status==="ready"?<div className="table">
   <div className="search-total">共 {total>TOTAL_CAP?TOTAL_CAP+"+":total} 个结果（仅显示你有权访问的文件）</div>
   {items.length===0?<p className="empty">没有匹配的文件。换个关键词，或确认你有该内容的预览权限。</p>:(
    <table>
     <thead><tr><th>文件名</th><th>大小</th><th>上传人</th><th>版本</th><th>修改日期</th></tr></thead>
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
      </tr>)}
     </tbody>
    </table>
   )}
  </div>:null}
  {status==="idle"?<p className="empty">输入关键词开始检索。中文按相邻子串匹配，标题与正文都会参与。</p>:null}
 </div>;
}
