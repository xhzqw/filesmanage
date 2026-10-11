import {useEffect,useState} from "react";
import {Link} from "react-router-dom";
import {RareBadge,RareButton,RareSelect} from "../../shared/ui/rare";
import {errorCopy} from "../../shared/errors";
import {lifecycleWorkspaceApi,type LifecycleLedgerRow} from "./lifecycleWorkspaceApi";
import "./lifecycleLedger.css";

function DueBadge({item}:{item:LifecycleLedgerRow}){
 if(item.dueStatus==="overdue")return <RareBadge tone="danger" dot>已到期</RareBadge>;
 if(item.dueStatus==="soon")return <RareBadge tone="warning" dot>即将到期</RareBadge>;
 if(item.dueStatus==="scheduled")return <RareBadge tone="info">计划中</RareBadge>;
 return <span className="lifecycle-ledger-muted">—</span>;
}
export function LifecycleLedger(){
 const[state,setState]=useState("");
 const[items,setItems]=useState<LifecycleLedgerRow[]>([]);
 const[cursor,setCursor]=useState("");
 const[loading,setLoading]=useState(false);
 const[error,setError]=useState("");
 const[reload,setReload]=useState(0);
 useEffect(()=>{
  let active=true;setLoading(true);setError("");
  lifecycleWorkspaceApi.ledger(cursor,state).then(page=>{
   if(!active)return;
   setItems(prev=>cursor?[...prev,...page.items]:page.items);
   setCursorNext(page.nextCursor);
  }).catch(e=>{if(active)setError(errorCopy(e,"读取生命周期台账失败"));})
  .finally(()=>{if(active)setLoading(false)});
  return()=>{active=false};
 },[state,cursor,reload]);
 const[nextCursor,setCursorNext]=useState("");
 function changeState(next:string){setState(next);setItems([]);setCursor("");setCursorNext("");setReload(v=>v+1);}
 return <section className="lifecycle-ledger" aria-label="文档生命周期台账">
  <header className="lifecycle-ledger-toolbar">
   <strong>生命周期台账</strong>
   <div className="lifecycle-ledger-controls">
    <RareSelect aria-label="生命周期状态筛选" value={state} onChange={e=>changeState(e.target.value)}>
     <option value="">全部</option><option value="released">已发布</option><option value="archived">已归档</option>
    </RareSelect>
    <RareButton type="button" disabled={loading} onClick={()=>{setCursor("");setItems([]);setReload(v=>v+1)}}>刷新</RareButton>
   </div>
  </header>
  {error&&<p role="alert" className="notice error">{error}</p>}
  <div className="lifecycle-ledger-scroll"><table>
   <thead><tr><th>文档</th><th>版本</th><th>状态</th><th>到期提醒</th><th>到期日</th><th>保留至</th></tr></thead>
   <tbody>
    {items.map(item=><tr key={item.fileId}>
     <td><Link to={"/preview/"+encodeURIComponent(item.fileId)} title={item.fileName}>{item.fileName}</Link></td>
     <td>v{item.publishedSeq}</td>
     <td><RareBadge tone={item.state==="archived"?"warning":"success"} dot>{item.state==="archived"?"已归档":"已发布"}</RareBadge></td>
     <td><DueBadge item={item}/></td>
     <td>{item.dueAt?.slice(0,10)??"—"}</td>
     <td>{item.retentionUntil?.slice(0,10)??"—"}</td>
    </tr>)}
    {!loading&&items.length===0&&<tr><td colSpan={6} className="lifecycle-ledger-empty">暂无文档记录</td></tr>}
   </tbody>
  </table></div>
  <footer className="lifecycle-ledger-footer">
   <span>{items.length} 条已显示</span>
   {nextCursor&&<RareButton disabled={loading} onClick={()=>setCursor(nextCursor)}>加载更多</RareButton>}
   {loading&&<span role="status">正在加载…</span>}
  </footer>
 </section>;
}
