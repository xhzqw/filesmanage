import {useEffect,useState} from "react";
import {Link} from "react-router-dom";
import {RareBadge,RareButton,RareInput,RareNotice} from "../../shared/ui/rare";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {errorCopy} from "../../shared/errors";
import {cdwApi,type CDWEffectiveSearchHit} from "./api";

export function CDWEffectiveSearchPanel(){
 const [query,setQuery]=useState("");
 const [debounced,setDebounced]=useState("");
 const [items,setItems]=useState<CDWEffectiveSearchHit[]>([]);
 const [cursor,setCursor]=useState("");
 const [loading,setLoading]=useState(false);
 const [error,setError]=useState("");
 const [refresh,setRefresh]=useState(0);
 useEffect(()=>{
  const timer=window.setTimeout(()=>setDebounced(query.trim()),240);
  return()=>window.clearTimeout(timer);
 },[query]);
 useEffect(()=>{
  let live=true;setLoading(true);setError("");setItems([]);setCursor("");
  cdwApi.controlEffectiveSearch(debounced,"").then(page=>{
   if(live){setItems(page.items??[]);setCursor(page.nextCursor??"");}
  }).catch(e=>{if(live)setError(errorCopy(e,"无法读取当前有效受控文件"));})
   .finally(()=>{if(live)setLoading(false)});
  return()=>{live=false};
 },[debounced,refresh]);
 async function more(){
  if(loading||!cursor)return;
  setLoading(true);setError("");
  try{
   const page=await cdwApi.controlEffectiveSearch(debounced,cursor);
   setItems(prev=>[...prev,...page.items.filter(item=>!prev.some(x=>x.fileId===item.fileId))]);
   setCursor(page.nextCursor??"");
  }catch(e){setError(errorCopy(e,"加载下一页失败"));}
  finally{setLoading(false);}
 }
 return <section className="cdw-effective-view" aria-label="当前有效受控文件">
  <div className="cdw-effective-tools">
   <div><strong>当前有效文件</strong><small>仅检索已生效发行稿及其独立全文索引</small></div>
   <div className="cdw-effective-actions">
    <RareInput type="search" aria-label="搜索受控生效文件" value={query}
     placeholder="搜索正式文件名或发行稿正文…" onChange={e=>setQuery(e.target.value)}/>
    <RareButton type="button" tone="ghost" disabled={loading} onClick={()=>setRefresh(n=>n+1)}>刷新</RareButton>
   </div>
  </div>
  {error&&<RareNotice tone="danger">{error}</RareNotice>}
  <div className="cdw-effective-scroll" role="region" aria-label="受控有效版查询结果">
   <table className="cdw-effective-table">
    <thead><tr><th>文件</th><th>版本状态</th><th>生效时间</th><th>发行内容指纹</th><th>操作</th></tr></thead>
    <tbody>{items.map(item=><tr key={item.releaseId}>
     <td><strong>{item.fileName}</strong>{item.snippet.trim()&&<small title={item.snippet}>{item.snippet}</small>}</td>
     <td><RareBadge tone="success">当前生效</RareBadge></td>
     <td>{new Date(item.effectiveAt).toLocaleString("zh-CN")}</td>
     <td><code title={item.sha256}>{item.sha256.slice(0,16)}…</code></td>
     <td><Link className="cdw-text-link" to={"/preview/"+encodeURIComponent(item.fileId)}>查看受控版本 ↗</Link></td>
    </tr>)}</tbody>
   </table>
   {loading&&<div className="cdw-message"><BrandLoadingLabel showContext>检索受控发行物</BrandLoadingLabel></div>}
   {!loading&&!error&&items.length===0&&<div className="cdw-empty"><strong>暂无匹配的生效文件</strong><p>只有当前有效、具备授权且发行物索引已完成的文件才会显示。</p></div>}
   {cursor&&!loading&&<div className="cdw-effective-more"><RareButton type="button" tone="neutral" onClick={()=>void more()}>加载更多</RareButton></div>}
  </div>
  <footer className="cdw-inbox-footer">内容来自不可变发行版本 · 实时校验访问授权 · 历史稿不参与当前全文检索</footer>
 </section>;
}
