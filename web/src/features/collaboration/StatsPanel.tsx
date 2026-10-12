import {useEffect,useMemo,useState} from "react";
import {observeWorkspaceChange} from "../../shared/resourceSync";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {RareButton,RareSelect,AnimatedCounter,GooeyNav} from "../../shared/ui/rare";
import {request} from "../../shared/http";
import {Dialog} from "../../shared/ui/Dialog";
import {FolderPicker} from "../../shared/ui/FolderPicker";
import type {Folder} from "../../entities/folder/model";
import {collaborationApi,formatBytes,type Stats} from "./api";
import {FolderTreemap} from "./FolderTreemap";
import {StatsTrend} from "./StatsTrend";
import "./stats.css";

type Scope="all"|"current"|"descendants";
type Metric="count"|"bytes";
const rangeOptions=[{value:"all",label:"全部时间"},{value:"30",label:"最近 30 天"},{value:"90",label:"最近 90 天"},{value:"365",label:"最近一年"}] as const;
function dateFromRange(range:string){
 if(range==="all")return "";
 return new Date(Date.now()-Number(range)*86400000).toISOString();
}
function metricLabel(metric:Metric,value:number){return metric==="bytes"?formatBytes(value):value.toLocaleString("zh-CN");}
function EmptyChart({label}:{label:string}){return <div className="stats-no-data">{label}</div>;}
function RankRows({items,metric,onChoose}:{items:{key:string;name:string;count:number;bytes:number;detail?:string}[];metric:Metric;onChoose?:(id:string)=>void}){
 const max=Math.max(1,...items.map(item=>item[metric]));
 return <div className="stats-rank-list">
  {items.length===0?<EmptyChart label="当前筛选下暂无数据"/>:items.map(item=>
   <div className="stats-rank-row" key={item.key}>
    <div className="stats-rank-main">
     {onChoose?<RareButton type="button" tone="ghost" className="stats-rank-link" onClick={()=>onChoose(item.key)} title={"筛选："+item.name}>{item.name}<span aria-hidden="true"> ↗</span></RareButton>
      :<span className="stats-rank-name" title={item.name}>{item.name}</span>}
     <strong>{metricLabel(metric,item[metric])}</strong>
    </div>
    <div className="stats-track" role="img" aria-label={item.name+"，"+metricLabel(metric,item[metric])}>
     <span style={{width:Math.max(item[metric]>0?2:0,item[metric]/max*100)+"%"}}/>
    </div>
    {item.detail&&<span className="stats-rank-detail">{item.detail}</span>}
   </div>)}
 </div>;
}

export function StatsPanel(){
 const[stats,setStats]=useState<Stats|null>(null);
 const[status,setStatus]=useState<"loading"|"ready"|"failed">("loading");
 const[scope,setScope]=useState<Scope>("all");
 const[folder,setFolder]=useState("");
 const[type,setType]=useState("");
 const[range,setRange]=useState("all");
 const[metric,setMetric]=useState<Metric>("count");
 const[uploader,setUploader]=useState("");
 const[reload,setReload]=useState(0);
 useEffect(()=>observeWorkspaceChange(()=>setReload(n=>n+1),["file","folder","stats","permissions"]),[]);
 const[pickerOpen,setPickerOpen]=useState(false);
 const[pendingScope,setPendingScope]=useState<Scope>("descendants");
 const[candidate,setCandidate]=useState("");
 const[folders,setFolders]=useState<Folder[]>([]);
 const[treeState,setTreeState]=useState<"loading"|"ready"|"failed">("loading");
 const[treeToken,setTreeToken]=useState(0);

 const from=useMemo(()=>dateFromRange(range),[range]);
 // Shared folder metadata is already permission-filtered by /folders/tree.
 useEffect(()=>{let active=true;collaborationApi.folderTree().then(data=>{if(active)setFolders(data);}).catch(()=>{});return()=>{active=false;};},[reload]);
 const filters=useMemo(()=>({folder:scope==="all"?"":folder,scope:scope==="descendants"?"descendants":"",type,uploader,from}),[folder,scope,type,uploader,from]);
 const folderPath=useMemo(()=>pathOf(folders,folder),[folders,folder]);
 const folderLabel=scope==="all"?"全部可见目录":folderPath||"已选目录";

 useEffect(()=>{
  let active=true;
  setStatus("loading");
  collaborationApi.stats(filters).then(data=>{if(active){setStats(data);setStatus("ready");}})
   .catch(()=>{if(active)setStatus("failed");});
  return()=>{active=false;};
 },[filters,reload]);
 useEffect(()=>{
  if(!pickerOpen)return;
  let active=true;
  setTreeState("loading");
  request<Folder[]>("/folders/tree").then(data=>{if(active){setFolders(data);setTreeState("ready");}})
   .catch(()=>{if(active)setTreeState("failed");});
  return()=>{active=false;};
 },[pickerOpen,treeToken]);

 function openPicker(nextScope:Scope=scope==="all"?"descendants":scope){
  setPendingScope(nextScope);
  setCandidate(folder);
  setTreeState("loading");
  setPickerOpen(true);
 }
 function applyFolder(){
  if(!candidate)return;
  setFolder(candidate);
  setScope(pendingScope);
  setPickerOpen(false);
 }
 function changeScope(next:Scope){
  if(next!=="all"&&!folder){openPicker(next);return;}
  setScope(next);
 }
 function resetFilters(){
  setScope("all");setFolder("");setType("");setRange("all");setUploader("");
 }
 const activeFilters=scope!=="all"||!!type||range!=="all"||!!uploader;
 const monthSeries=stats?.byMonth?.filter(m=>/^\d{4}-\d{2}$/.test(m.month))||[];
 const types=stats?.byType||[];
 const byUploader=stats?.byUploader||[];

 return <div className="work-body stats-workbench">
  <div className="stats-toolbar">
   <div className="stats-heading"><strong>文件资产概览</strong></div>
   <div className="stats-filters">
    <label className="stats-field"><span>目录</span><RareSelect aria-label="目录范围" value={scope} onChange={e=>changeScope(e.target.value as Scope)}>
     <option value="all">全部可见</option><option value="current">仅当前目录</option><option value="descendants">包含子目录</option>
    </RareSelect></label>
    <RareButton type="button" tone="neutral" onClick={()=>openPicker()} title={folderLabel} className="stats-folder-trigger">{folderLabel==="全部可见目录"?"选择目录":folderLabel}</RareButton>
    <label className="stats-field"><span>时间</span><RareSelect aria-label="修改时间" value={range} onChange={e=>setRange(e.target.value)}>
     {rangeOptions.map(item=><option key={item.value} value={item.value}>{item.label}</option>)}
    </RareSelect></label>
    <label className="stats-field"><span>类型</span><RareSelect aria-label="文件 MIME 类型" value={type} onChange={e=>setType(e.target.value)}>
     <option value="">全部格式</option><option value="image/">图片</option><option value="video/">视频</option>
     <option value="audio/">音频</option><option value="application/pdf">PDF</option>
     <option value="text/">文本</option><option value="application/">其他应用文件</option>
    </RareSelect></label>
    <MetricSwitch value={metric} onChange={setMetric}/>
    {uploader&&<RareButton tone="ghost" type="button" onClick={()=>setUploader("")}>清除上传人</RareButton>}
    {activeFilters&&<RareButton tone="ghost" type="button" onClick={resetFilters}>重置</RareButton>}
    <a className="stats-export" href={collaborationApi.exportUrl(filters)} aria-label="导出当前统计筛选的文件 CSV">导出 CSV</a>
   </div>
  </div>
  {scope!=="all"&&<div className="stats-scope-note">当前目录：{folderLabel} <RareButton tone="ghost" type="button" onClick={()=>openPicker(scope)}>更改</RareButton></div>}
  {status==="loading"&&<div className="stats-state" role="status"><BrandLoadingLabel size="sm">正在加载统计数据…</BrandLoadingLabel></div>}
  {status==="failed"&&<div className="stats-state" role="alert">统计加载失败 <RareButton type="button" tone="neutral" onClick={()=>setReload(n=>n+1)}>重试</RareButton></div>}
  {status==="ready"&&stats&&<>
   <div className="stats-summary">
    <div className="stats-summary-card"><span>文件</span><strong><AnimatedCounter value={stats.totalFiles}/></strong></div>
    <div className="stats-summary-card"><span>目录</span><strong><AnimatedCounter value={stats.totalFolders}/></strong></div>
    <div className="stats-summary-card"><span>存储容量</span><strong>{formatBytes(stats.totalBytes)}</strong></div>
    <div className="stats-summary-card"><span>近 30 天新增</span><strong><AnimatedCounter value={stats.added30Days}/></strong></div>
   </div>
   <div className="stats-layout">
    <section className="stats-panel stats-map-panel" aria-labelledby="stats-map-title">
     <div className="stats-panel-head"><div><h2 id="stats-map-title">目录空间分布</h2><p>面积代表容量 · 点击进入下级目录</p></div></div>
     <FolderTreemap key={scope+folder+type+range+uploader} stats={stats} folders={folders} onChoose={id=>{setFolder(id);setScope("descendants");}}/>
    </section>
    <div className="stats-insights">
     <section className="stats-panel stats-types-panel" aria-labelledby="stats-types-title">
      <div className="stats-panel-head"><h2 id="stats-types-title">文件类型</h2></div>
      <RankRows metric={metric} items={types.slice(0,5).map(t=>({key:t.type,name:t.type==="无扩展名"?"无扩展名":"."+t.type,count:t.count,bytes:t.bytes}))}/>
     </section>
     <section className="stats-panel stats-growth-panel" aria-labelledby="stats-growth-title">
      <div className="stats-panel-head"><h2 id="stats-growth-title">新增趋势</h2><span className="stats-panel-subtitle">{metric==="count"?"文件数":"容量"}</span></div>
      {monthSeries.length===0?<EmptyChart label="暂无月份记录"/>:<StatsTrend series={monthSeries} metric={metric}/>}
     </section>
     <section className="stats-panel stats-uploader-panel" aria-labelledby="stats-uploader-title">
      <div className="stats-panel-head"><h2 id="stats-uploader-title">上传活跃度</h2><span className="stats-panel-subtitle">按文件数</span></div>
      <RankRows metric="count" items={byUploader.slice(0,4).map(u=>({key:u.uploaderId,name:u.uploaderName||u.uploaderId,count:u.count,bytes:u.bytes}))} onChoose={setUploader}/>
     </section>
    </div>
   </div>
   <div className="stats-footer">容量按当前版本逻辑大小统计；新增按文件首次上传时间计算。</div>
  </>}
  {pickerOpen&&<Dialog open title="选择统计目录" onClose={()=>setPickerOpen(false)} className="dialog">
   {treeState==="loading"&&<p className="empty"><BrandLoadingLabel>正在读取目录…</BrandLoadingLabel></p>}
   {treeState==="failed"&&<div role="alert" className="notice error">获取目录失败 <RareButton type="button" onClick={()=>setTreeToken(n=>n+1)}>重试</RareButton></div>}
   {treeState==="ready"&&<FolderPicker open title="选择统计目录" folders={folders} selectedId={candidate}
    onSelect={setCandidate} onClose={()=>setPickerOpen(false)}
    footer={<div className="dialog-actions">
     <RareButton type="button" tone="ghost" onClick={()=>setPickerOpen(false)}>取消</RareButton>
     <RareButton type="button" tone="primary" disabled={!candidate} onClick={applyFolder}>应用</RareButton>
    </div>}/>}
  </Dialog>}
 </div>;
}
function MetricSwitch({value,onChange}:{value:Metric;onChange:(value:Metric)=>void}){
 return <GooeyNav className="stats-metric" aria-label="统计单位" size="xs" items={["数量","容量"]}
  value={value==="count"?0:1} separation={7} radius={6} activeColor="var(--brand-blue)"
  activeLabelColor="var(--text-inverse)" onChange={index=>onChange(index===0?"count":"bytes")}/>;
}
function pathOf(folders:Folder[],id:string){
 const byId=new Map(folders.map(item=>[item.id,item]));
 const parts:string[]=[];const seen=new Set<string>();
 let current=byId.get(id);
 while(current&&!seen.has(current.id)){seen.add(current.id);parts.unshift(current.name);current=current.parentId?byId.get(current.parentId):undefined;}
 return parts.join(" / ");
}
