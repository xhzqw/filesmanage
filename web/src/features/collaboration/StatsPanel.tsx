import {useEffect,useState} from "react";
import {Link} from "react-router-dom";
import {collaborationApi,formatBytes} from "./api";

// Stats page: aggregates over the caller's real visibility scope, with the
// same filter as the CSV export.
export function StatsPanel(){
 const[stats,setStats]=useState<Awaited<ReturnType<typeof collaborationApi.stats>>|null>(null);
 const[status,setStatus]=useState("loading");
 const[folder,setFolder]=useState("");
 const[scope,setScope]=useState<"current"|"descendants"|"all">("current");
 const[kind,setKind]=useState("");

 useEffect(()=>{
  let valid=true;
  setStatus("loading");
  collaborationApi.stats({folder:scope==="all"?"":folder,scope:scope==="descendants"?"descendants":"",type:kind})
   .then(data=>{if(valid){setStats(data);setStatus("ready");}})
   .catch(()=>{if(valid)setStatus("failed");});
  return()=>{valid=false;};
 },[folder,scope,kind]);

 return <div className="work-body">
  <div className="toolbar">
   <label className="sort-label">范围
    <select value={scope} onChange={e=>setScope(e.target.value as "current"|"descendants"|"all")}>
     <option value="current">当前目录</option>
     <option value="descendants">包含子目录</option>
     <option value="all">我可访问的全部</option>
    </select>
   </label>
   {scope!=="all"&&<label className="sort-label">目录 ID
    <input value={folder} onChange={e=>setFolder(e.target.value)} placeholder="folder_…"/>
   </label>}
   <label className="sort-label">类型
    <input value={kind} onChange={e=>setKind(e.target.value)} placeholder="如 text / 留空"/>
   </label>
   <a className="primary" href={collaborationApi.exportUrl({folder:scope==="all"?"":folder,scope:scope==="descendants"?"descendants":"",type:kind})}>导出 CSV</a>
  </div>
  {status==="loading"&&<p className="empty">正在统计…</p>}
  {status==="failed"&&<p role="alert" className="notice error">统计失败。</p>}
  {stats&&<>
   <div className="stat-cards">
    <div className="stat-card"><span className="stat-num">{stats.totalFiles}</span><span>文件数</span></div>
    <div className="stat-card"><span className="stat-num">{stats.totalFolders}</span><span>目录数</span></div>
    <div className="stat-card"><span className="stat-num">{formatBytes(stats.totalBytes)}</span><span>当前版本总字节</span></div>
    <div className="stat-card"><span className="stat-num">{stats.added30Days}</span><span>近 30 日新增</span></div>
   </div>
   <div className="table">
    <table>
     <thead><tr><th>类型</th><th>数量</th></tr></thead>
     <tbody>
      {stats.byType.length===0&&<tr><td colSpan={2} className="empty">无数据</td></tr>}
      {stats.byType.map(t=><tr key={t.type}><td>{t.type}</td><td>{t.count}</td></tr>)}
     </tbody>
    </table>
   </div>
   <div className="table">
    <table>
     <thead><tr><th>月份</th><th>新增文件</th></tr></thead>
     <tbody>
      {stats.byMonth.length===0&&<tr><td colSpan={2} className="empty">无数据</td></tr>}
      {stats.byMonth.map(m=><tr key={m.month}><td>{m.month}</td><td>{m.count}</td></tr>)}
     </tbody>
    </table>
   </div>
   <div className="table">
    <table>
     <thead><tr><th>上传人</th><th>上传文件数</th></tr></thead>
     <tbody>
      {stats.byUploader.length===0&&<tr><td colSpan={2} className="empty">无数据</td></tr>}
      {stats.byUploader.map(u=><tr key={u.uploaderId}><td>{u.uploaderName||u.uploaderId}</td><td>{u.count}</td></tr>)}
     </tbody>
    </table>
   </div>
  </>}
 </div>;
}
