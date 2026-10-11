import {useEffect,useState} from "react";
import {Link} from "react-router-dom";
import {RareBadge,RareButton,RareInput,RareSelect} from "../../shared/ui/rare";
import {errorCopy} from "../../shared/errors";
import {lifecycleWorkspaceApi,type LifecycleLedgerRow,type LifecycleStats} from "./lifecycleWorkspaceApi";
import {LifecyclePolicyManager} from "./LifecyclePolicyManager";
import "./lifecyclePolicy.css";
import "./lifecycleLedger.css";

function DueBadge({item}:{item:LifecycleLedgerRow}){
 if(item.dueStatus==="overdue")return <RareBadge tone="danger" dot>已到期</RareBadge>;
 if(item.dueStatus==="soon")return <RareBadge tone="warning" dot>即将到期</RareBadge>;
 if(item.dueStatus==="scheduled")return <RareBadge tone="info">计划中</RareBadge>;
 return <span className="lifecycle-ledger-muted">—</span>;
}
export function LifecycleLedger({isAdmin=false}:{isAdmin?:boolean}){
 const[state,setState]=useState("");
 const[items,setItems]=useState<LifecycleLedgerRow[]>([]);
 const[cursor,setCursor]=useState("");
 const[loading,setLoading]=useState(false);
 const[error,setError]=useState("");
 const[reload,setReload]=useState(0);
 const[selected,setSelected]=useState<string[]>([]);
 const[bulkDate,setBulkDate]=useState("");
 const[bulkBusy,setBulkBusy]=useState(false);
 const[bulkResult,setBulkResult]=useState("");
 const[stats,setStats]=useState<LifecycleStats|null>(null);
 useEffect(()=>{
  if(!isAdmin)return;
  let live=true;lifecycleWorkspaceApi.statistics().then(s=>{if(live)setStats(s)}).catch(()=>{if(live)setStats(null)});
  return()=>{live=false};
 },[isAdmin,reload]);
 async function applyBulk(){
  const selectedItems=items.filter(item=>selected.includes(item.fileId));
  if(!selectedItems.length||selectedItems.length>20||bulkBusy)return;
  setBulkBusy(true);setBulkResult("");
  try{
   const results=await lifecycleWorkspaceApi.bulkDue(selectedItems.map(item=>({fileId:item.fileId,expectedVersionSeq:item.publishedSeq})),bulkDate?new Date(bulkDate+"T23:59:59").toISOString():null);
   const counts:Record<string,number>={};
   for(const item of results){counts[item.status]=(counts[item.status]??0)+1;}
   setBulkResult("已更新 "+(counts.updated??0)+" · 冲突 "+(counts.conflict??0)+" · 版本变化 "+(counts.version_conflict??0)+" · 不可访问 "+(counts.unavailable??0)+" · 无效 "+(counts.invalid??0));
   setSelected([]);setCursor("");setItems([]);setReload(v=>v+1);
  }catch(e){setBulkResult(errorCopy(e,"批量到期设置失败"));}
  finally{setBulkBusy(false);}
 }
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
 function changeState(next:string){setState(next);setItems([]);setSelected([]);setCursor("");setCursorNext("");setReload(v=>v+1);}
 return <>
 {isAdmin&&<LifecyclePolicyManager/>}
 {isAdmin&&stats&&<div className="lifecycle-stats" aria-label="生命周期管理统计">
  <span>已发布<strong>{stats.released}</strong></span>
  <span>已归档<strong>{stats.archived}</strong></span>
  <span>即将到期<strong>{stats.dueSoon}</strong></span>
  <span>已到期<strong>{stats.overdue}</strong></span>
  <span>保留期内<strong>{stats.retained}</strong></span>
 </div>}
 <section className="lifecycle-ledger" aria-label="文档生命周期台账">
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
  <div className="lifecycle-bulk-bar">
   <span>已选择 {selected.length} 项（最多 20 项）</span>
   <RareInput aria-label="批量到期日期" type="date" value={bulkDate} onChange={e=>setBulkDate(e.target.value)}/>
   <RareButton disabled={selected.length===0||bulkBusy} onClick={()=>void applyBulk()}>批量设置到期日</RareButton>
   <RareButton disabled={selected.length===0||bulkBusy} onClick={()=>setSelected([])}>清除选择</RareButton>
   {bulkResult&&<span role="status">{bulkResult}</span>}
  </div>
  <div className="lifecycle-ledger-scroll"><table>
   <thead><tr><th>选</th><th>文档</th><th>版本</th><th>状态</th><th>负责人</th><th>到期提醒</th><th>到期日</th><th>保留至</th></tr></thead>
   <tbody>
    {items.map(item=><tr key={item.fileId}>
     <td><input type="checkbox" aria-label={"选择 "+item.fileName} checked={selected.includes(item.fileId)} onChange={e=>setSelected(current=>e.target.checked?(current.length>=20?current:[...current,item.fileId]):current.filter(id=>id!==item.fileId))}/></td>
     <td><Link to={"/preview/"+encodeURIComponent(item.fileId)} title={item.fileName}>{item.fileName}</Link></td>
     <td>v{item.publishedSeq}</td>
     <td><RareBadge tone={item.state==="archived"?"warning":"success"} dot>{item.state==="archived"?"已归档":"已发布"}</RareBadge></td>
     <td>{item.responsibleName||"—"}</td>
     <td><DueBadge item={item}/></td>
     <td>{item.dueAt?.slice(0,10)??"—"}</td>
     <td>{item.retentionUntil?.slice(0,10)??"—"}</td>
    </tr>)}
    {!loading&&items.length===0&&<tr><td colSpan={8} className="lifecycle-ledger-empty">暂无文档记录</td></tr>}
   </tbody>
  </table></div>
  <footer className="lifecycle-ledger-footer">
   <span>{items.length} 条已显示</span>
   {nextCursor&&<RareButton disabled={loading} onClick={()=>setCursor(nextCursor)}>加载更多</RareButton>}
   {loading&&<span role="status">正在加载…</span>}
  </footer>
 </section></>;
}
