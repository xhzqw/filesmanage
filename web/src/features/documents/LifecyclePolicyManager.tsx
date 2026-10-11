import {useEffect,useMemo,useState} from "react";
import {RareButton,RareInput,RareSelect} from "../../shared/ui/rare";
import {errorCopy} from "../../shared/errors";
import {lifecycleWorkspaceApi,type LifecyclePolicyView,type LifecycleScope} from "./lifecycleWorkspaceApi";

export function LifecyclePolicyManager(){
 const[kind,setKind]=useState<"folder"|"department">("folder");
 const[scopes,setScopes]=useState<LifecycleScope[]>([]);
 const[query,setQuery]=useState("");
 const[id,setId]=useState("");
 const[value,setValue]=useState<LifecyclePolicyView|null>(null);
 const[dueDays,setDueDays]=useState(0);
 const[retentionDays,setRetentionDays]=useState(0);
 const[busy,setBusy]=useState(false);
 const[error,setError]=useState("");
 const[notice,setNotice]=useState("");
 const[version,setVersion]=useState(0);
 useEffect(()=>{
  let live=true;
  setScopes([]);setId("");setValue(null);setQuery("");setError("");
  (kind==="folder"?lifecycleWorkspaceApi.folders():lifecycleWorkspaceApi.departments())
   .then(rows=>{if(live)setScopes(rows);}).catch(e=>{if(live)setError(errorCopy(e,"读取范围失败"));});
  return()=>{live=false};
 },[kind]);
 useEffect(()=>{
  if(!id){setValue(null);return;}
  let live=true;setValue(null);setError("");
  lifecycleWorkspaceApi.policy(kind,id).then(policy=>{
   if(!live)return;setValue(policy);setDueDays(policy.dueDays);setRetentionDays(policy.retentionDays);
  }).catch(e=>{if(live)setError(errorCopy(e,"读取策略失败"));});
  return()=>{live=false};
 },[kind,id,version]);
 const filtered=useMemo(()=>scopes.filter(s=>s.name.toLowerCase().includes(query.trim().toLowerCase())).slice(0,100),[scopes,query]);
 async function save(clear:boolean){
  if(!id||busy)return;
  setBusy(true);setError("");setNotice("");
  try{
   if(clear)await lifecycleWorkspaceApi.clearPolicy(kind,id);
   else await lifecycleWorkspaceApi.savePolicy(kind,id,{dueDays,retentionDays});
   setNotice(clear?"已恢复上级策略":"策略已保存");setVersion(v=>v+1);
  }catch(e){setError(errorCopy(e,"保存策略失败"));}finally{setBusy(false)}
 }
 return <section className="lifecycle-policy-manager" aria-label="生命周期默认策略">
  <div className="lifecycle-ledger-toolbar"><strong>默认策略</strong><span className="lifecycle-ledger-muted">仅影响后续发布和归档</span></div>
  <div className="lifecycle-policy-body">
   <label>范围<RareSelect aria-label="策略范围" value={kind} onChange={e=>setKind(e.target.value as "folder"|"department")}>
    <option value="folder">文件夹</option><option value="department">部门</option>
   </RareSelect></label>
   <label>查找<RareInput aria-label="搜索策略范围" value={query} onChange={e=>setQuery(e.target.value)} placeholder="输入名称"/></label>
   <label>对象<RareSelect aria-label="选择策略对象" value={id} onChange={e=>{setId(e.target.value);setNotice("");}}>
    <option value="">请选择</option>
    {filtered.map(scope=><option key={scope.id} value={scope.id}>{scope.name}</option>)}
    {id&&!filtered.some(scope=>scope.id===id)&&<option value={id}>{scopes.find(scope=>scope.id===id)?.name??id}</option>}
   </RareSelect></label>
   <label>默认到期<RareSelect value={dueDays} aria-label="默认到期天数" onChange={e=>setDueDays(Number(e.target.value))} disabled={!value||busy}>
    {[0,30,90,180,365,730].map(n=><option key={n} value={n}>{n?String(n)+" 天":"不设置"}</option>)}
   </RareSelect></label>
   <label>最低保留期<RareSelect value={retentionDays} aria-label="最低归档保留天数" onChange={e=>setRetentionDays(Number(e.target.value))} disabled={!value||busy}>
    {[0,30,90,365,730].map(n=><option key={n} value={n}>{n?String(n)+" 天":"不设置"}</option>)}
   </RareSelect></label>
   <div className="lifecycle-policy-actions">
    <RareButton className="primary" disabled={!value||busy} onClick={()=>void save(false)}>保存</RareButton>
    <RareButton disabled={!value||busy} onClick={()=>void save(true)}>恢复继承</RareButton>
   </div>
  </div>
  {value&&<p className="lifecycle-policy-source">{value.sourceKind==="folder"?"继承自文件夹":value.sourceKind==="department"?"继承自部门":"未设置策略"}{value.sourceId?" · "+(scopes.find(s=>s.id===value.sourceId)?.name??value.sourceId):""}</p>}
  {error&&<p className="notice error" role="alert">{error}</p>}
  {notice&&<p className="lifecycle-policy-source" role="status">{notice}</p>}
 </section>;
}
