import {RareButton,RareDataTable,RareInput,RareSelect} from "../../shared/ui/rare";
import {toast} from "../../shared/ui/feedback";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {errorCode,errorCopy} from "../../shared/errors";
import {observeWorkspaceChange} from "../../shared/resourceSync";
import {useEffect,useMemo,useRef,useState,type FormEvent} from "react";
import {Link} from "react-router-dom";
import {collaborationApi,formatBytes} from "./api";
import type {FileItem} from "../../entities/file/model";
import type {Folder} from "../../entities/folder/model";
import {FolderPicker} from "../../shared/ui/FolderPicker";
import {Dialog} from "../../shared/ui/Dialog";
import {FileTypeIcon} from "../../shared/ui/FileTypeIcon";
import {readSearchPresets,writeSearchPresets,type SearchPresetFields} from "./searchPresets";
import {searchPresetsApi} from "./searchPresetsApi";
import "./search.css";

// The API caps the authorized total at 1001, which the UI renders as "1000+"
// (SPEC §10.2 permits a hard-capped total).
const TOTAL_CAP=1000;
const PAGE_SIZES=[50,100,200];
const DEFAULT_PAGE_SIZE=50;
const SEARCH_DEBOUNCE_MS=180;

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

type Query={q:string;category:string;tag:string;uploader:string;type:string;sort:string;limit:number;folder:string;scope:string;from:string;to:string};
function boundaryDate(value:string,end:boolean):string{return value?new Date(value+"T"+(end?"23:59:59":"00:00:00")).toISOString():"";}
function csvField(value:string|number):string{
 const raw=String(value);
 const protectedValue=/^[=+@\-\t\r]/.test(raw)?"\u0027"+raw:raw;
 return "\""+protectedValue.replaceAll("\"","\"\"")+"\"";
}

// Full-text search workbench (SPEC C13/§10, WF-30): query plus uploader/type/
// sort filters, authorized results with snippets and safe highlighting, and
// cursor paging that appends strictly by the server's nextCursor (DI-16 §9).
export function SearchPanel({userId}:{userId:string}){
 const[q,setQ]=useState("");
 const[category,setCategory]=useState("");
 const[tag,setTag]=useState("");
 const[uploader,setUploader]=useState("");
 const[type,setType]=useState("");
 const[sort,setSort]=useState("updated_desc");
 const[pageSize,setPageSize]=useState<number>(DEFAULT_PAGE_SIZE);
 const[showAdvanced,setShowAdvanced]=useState(false);
 const[scope,setScope]=useState<"all"|"current"|"descendants">("all");
 const[folder,setFolder]=useState("");
 const[from,setFrom]=useState("");
 const[to,setTo]=useState("");
 const[pickerOpen,setPickerOpen]=useState(false);
 const[candidate,setCandidate]=useState("");
 const[folders,setFolders]=useState<Folder[]>([]);
 const[treeState,setTreeState]=useState<"loading"|"ready"|"failed">("loading");
 const[treeToken,setTreeToken]=useState(0);
 const[presets,setPresets]=useState<Awaited<ReturnType<typeof searchPresetsApi.list>>>([]);
 const[presetName,setPresetName]=useState("");
 const[filtersOpen,setFiltersOpen]=useState(false);
 const[presetBusy,setPresetBusy]=useState(false);
 const[presetError,setPresetError]=useState("");
 const[presetToken,setPresetToken]=useState(0);
 useEffect(()=>observeWorkspaceChange(()=>setPresetToken(n=>n+1),["presets"]),[]);
 useEffect(()=>{
  let active=true;setPresets([]);setPresetName("");setPresetError("");
  void (async()=>{
   try{
    let remote=await searchPresetsApi.list();
    // One-time import of older browser-only presets, without replacing
    // existing server records from other devices.
    const legacy=readSearchPresets(userId).filter(p=>!remote.some(r=>r.name===p.name));
    for(const item of legacy.slice(0,Math.max(0,12-remote.length))){
     if(!active)return;
     remote=await searchPresetsApi.save(item.name,item.fields);
    }
    writeSearchPresets(userId,[]);
    if(active)setPresets(remote);
   }catch{if(active)setPresetError("无法读取云端搜索预设，请重试");}
  })();
  return()=>{active=false;};
 },[userId,presetToken]);
 async function savePreset(){
  const title=presetName.trim();
  if(!title||presetBusy)return;
  setPresetBusy(true);setPresetError("");
  const fields:SearchPresetFields={q,category,tag,uploader,type,sort,limit:pageSize,scope,folder,from,to};
  try{
   setPresets(await searchPresetsApi.save(title,fields));
   setPresetName("");toast.success("搜索预设已保存");
  }catch(error){
   setPresetError(errorCode(error)==="E_NETWORK"
    ?"网络中断，预设保存结果未确认；请重新读取预设后核对"
    :errorCopy(error,"保存搜索预设失败，请检查名称或数量限制"));
  }
  finally{setPresetBusy(false);}
 }
 function loadPreset(preset:SearchPresetFields){
  cancelPendingSearch();
  setQ(preset.q);setCategory(preset.category);setTag(preset.tag);setUploader(preset.uploader);
  setType(preset.type);setSort(preset.sort);setPageSize(preset.limit);setScope(preset.scope);
  setFolder(preset.folder);setFrom(preset.from);setTo(preset.to);setShowAdvanced(true);
  epochRef.current++;setQuery(null);setItems([]);setStatus("idle");
  setMessage("");
  toast.info("搜索预设已加载，请点击搜索执行");
 }
 async function deletePreset(id:string){
  if(presetBusy)return;
  setPresetBusy(true);setPresetError("");
  try{
   await searchPresetsApi.remove(id);
   try{setPresets(await searchPresetsApi.list());}
   catch{setPresetError("预设已删除，但列表刷新失败；请重新读取预设");setPresetToken(n=>n+1);return;}
   toast.success("搜索预设已删除");
  }catch(error){
   setPresetError(errorCode(error)==="E_NETWORK"
    ?"网络中断，删除结果未确认；请先核对预设列表，勿重复操作"
    :errorCopy(error,"删除搜索预设失败，请重试"));
  }
  finally{setPresetBusy(false);}
 }
 useEffect(()=>{
  if(!pickerOpen)return;
  let active=true;setTreeState("loading");
  collaborationApi.folderTree().then(value=>{if(active){setFolders(value);setTreeState("ready");}})
   .catch(()=>{if(active)setTreeState("failed");});
  return()=>{active=false;};
 },[pickerOpen,treeToken]);
 const currentFolder=useMemo(()=>folders.find(item=>item.id===folder),[folders,folder]);
 function exportLoaded(){
  if(status!=="ready"||items.length===0)return;
  // Only the loaded, authorized rows are exported. This is not a server-wide
  // export and deliberately cannot leak items beyond the current cursor page.
  const lines=[["文件名","大小（字节）","上传人","版本","修改时间","目录ID"],...items.map(file=>
   [file.name,file.sizeBytes,file.uploadedBy,file.currentVersionSeq,file.updatedAt,file.folderId])];
  const csv="\uFEFF"+lines.map(cols=>cols.map(csvField).join(",")).join("\r\n");
  const url=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));
  const link=document.createElement("a");link.href=url;link.download="检索结果-已加载.csv";
  document.body.append(link);link.click();link.remove();window.setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 function clearFilters(){
  cancelPendingSearch();
  setQ("");setCategory("");setTag("");setUploader("");setType("");setScope("all");setFolder("");
  setFrom("");setTo("");setSort("updated_desc");setPageSize(DEFAULT_PAGE_SIZE);setShowAdvanced(false);
  epochRef.current++;moreBusyRef.current=false;setQuery({q:"",category:"",tag:"",uploader:"",type:"",sort:"updated_desc",limit:DEFAULT_PAGE_SIZE,folder:"",scope:"",from:"",to:""});setItems([]);setNextCursor("");setTotal(0);setStatus("loading");setMessage("");
 }
 const[query,setQuery]=useState<Query|null>({q:"",category:"",tag:"",uploader:"",type:"",sort:"updated_desc",limit:DEFAULT_PAGE_SIZE,folder:"",scope:"",from:"",to:""});
 const[items,setItems]=useState<FileItem[]>([]);
 const[total,setTotal]=useState(0);
 const[nextCursor,setNextCursor]=useState("");
 const[status,setStatus]=useState<"idle"|"loading"|"ready"|"failed">("idle");
 const[moreStatus,setMoreStatus]=useState<"idle"|"loading"|"failed">("idle");
 const[message,setMessage]=useState("");
 const[reloadToken,setReloadToken]=useState(0);
 useEffect(()=>observeWorkspaceChange(()=>setReloadToken(n=>n+1),["file","folder","search","permissions"]),[]);
 // Query generation plus the append mutex (DI-16 §9): the generation discards
 // every response of an older revision, the mutex keeps 加载更多 single-flight.
 const epochRef=useRef(0);
 const moreBusyRef=useRef(false);
 const autoSearchTimer=useRef<number|null>(null);
 const composing=useRef(false);

 function cancelPendingSearch(){
  if(autoSearchTimer.current!==null)window.clearTimeout(autoSearchTimer.current);
  autoSearchTimer.current=null;
 }
 useEffect(()=>()=>cancelPendingSearch(),[]);

 function searchDraft(term:string):Query{
  return {q:term.trim(),category:category.trim(),tag:tag.trim(),uploader:uploader.trim(),
   type:type.trim(),sort,limit:pageSize,folder:scope==="all"?"":folder,
   scope:scope==="descendants"?"descendants":"",from:boundaryDate(from,false),to:boundaryDate(to,true)};
 }
 function onKeywordChange(term:string){
  setQ(term);
  cancelPendingSearch();
  // Invalidate the in-flight request synchronously at the first keystroke.
  // It must never display a result page for an older query while the new
  // debounce is waiting; the effect also aborts the old transport on commit.
  epochRef.current++;
  moreBusyRef.current=false;
  setItems([]);setNextCursor("");setTotal(0);setMoreStatus("idle");
  if((scope!=="all"&&!folder)||(from&&to&&from>to)||composing.current){
   setStatus("idle");
   setQuery(null);
   return;
  }
  setMessage("");
  setStatus("loading");
  autoSearchTimer.current=window.setTimeout(()=>{
   autoSearchTimer.current=null;
   setQuery(searchDraft(term));
  },SEARCH_DEBOUNCE_MS);
 }

 // The first page of the committed query. Bumping the generation synchronously
 // on a new query (and on cleanup) discards a response still in flight, so an
 // older page can never overwrite a newer one; rows are replaced, not appended.
 useEffect(()=>{
  if(!query)return;
  const epoch=++epochRef.current;
  const controller=new AbortController();
  // The new revision owns the append state: a previous revision's page request
  // is stale now, and this first page is not a 加载更多.
  moreBusyRef.current=false;
  setStatus("loading");
  setMoreStatus("idle");
  collaborationApi.search({...query},controller.signal)
   .then(page=>{
    if(epochRef.current!==epoch)return;
    setItems(page.items);
    setTotal(page.total);
    setNextCursor(page.nextCursor??"");
    setStatus("ready");
   })
   .catch(()=>{if(epochRef.current===epoch)setStatus("failed");});
  return()=>{epochRef.current++;controller.abort();};
 },[query,reloadToken]);

 function submit(event:FormEvent){
  event.preventDefault();
  cancelPendingSearch();
  setMessage("");
  if(from&&to&&from>to){setMessage("开始日期不能晚于结束日期");return;}
  if(scope!=="all"&&!folder){setMessage("请先选择搜索目录");return;}
  // Invalidate the previous revision before React commits, so a page request
  // that resolves in the gap between render and effect cannot append old rows.
  epochRef.current++;
  moreBusyRef.current=false;
  setQuery(searchDraft(q));
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
 const hasMore=nextCursor!=="";
 const limitReached=!hasMore&&(capped||items.length<total);

  const activeFilters=[category,tag,uploader,type,scope!=="all"?folder:"",from,to].filter(Boolean).length;
  const recentView=Boolean(query&&!query.q&&!query.category&&!query.tag&&!query.uploader&&!query.type&&!query.folder&&!query.from&&!query.to);
  const title=recentView?"最近更新":query?.q?"搜索结果":"筛选结果";
  const shownTotal=capped?TOTAL_CAP+"+":String(total);
  return <div className="work-body global-search">
   <form id="advanced-search-form" className="search-primary" onSubmit={submit} role="search">
    <div className="search-input-wrap">
     <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
     <RareInput id="search-q" type="search" aria-label="文件名或正文关键词" value={q}
      onChange={event=>onKeywordChange(event.target.value)}
      onCompositionStart={()=>{composing.current=true;cancelPendingSearch();}}
      onCompositionEnd={event=>{composing.current=false;onKeywordChange(event.currentTarget.value);}}
      placeholder="搜索文件名或正文…" maxLength={200}/>
    </div>
    <RareButton type="submit" className="primary">搜索</RareButton>
    <RareButton type="button" onClick={clearFilters}>重置</RareButton>
    <RareButton type="button" className="search-mobile-filters" aria-expanded={filtersOpen} onClick={()=>setFiltersOpen(v=>!v)}>筛选{activeFilters>0?" · "+activeFilters:""}</RareButton>
    {message&&<span className="search-feedback" role="status">{message}</span>}
   </form>
   <div className={"search-workbench"+(filtersOpen?" filters-open":"")}>
    <aside className="search-filters" aria-label="搜索筛选条件">
     <div className="search-filter-heading"><strong>筛选条件</strong><RareButton type="button" onClick={clearFilters}>清除</RareButton></div>
     <label>搜索范围<RareSelect aria-label="搜索范围" value={scope} onChange={e=>setScope(e.target.value as "all"|"current"|"descendants")}>
      <option value="all">全部可访问文件</option><option value="current">指定目录</option><option value="descendants">含子目录</option>
     </RareSelect></label>
     {scope!=="all"&&<div className="search-folder-select">
      <span title={currentFolder?.name??""}>{folder?(currentFolder?.name??"已选目录"):"请选择目录"}</span>
      <RareButton type="button" onClick={()=>{setCandidate(folder);setPickerOpen(true);}}>选择</RareButton>
     </div>}
     <label>文件类型<RareSelect aria-label="文件格式筛选" value={type} onChange={e=>setType(e.target.value)}>
      <option value="">全部格式</option><option value="application/pdf">PDF</option>
      <option value="image/">图片</option><option value="video/">视频</option><option value="audio/">音频</option>
      <option value="text/">纯文本</option><option value="application/vnd.">Office 文档</option>
     </RareSelect></label>
     <label>分类<RareInput id="search-category" value={category} onChange={e=>setCategory(e.target.value)} placeholder="按分类筛选" maxLength={80}/></label>
     <label>标签<RareInput id="search-tag" value={tag} onChange={e=>setTag(e.target.value)} placeholder="按标签筛选" maxLength={80}/></label>
     <RareButton type="button" className="search-advanced-toggle" aria-expanded={showAdvanced} onClick={()=>setShowAdvanced(v=>!v)}>
      {showAdvanced?"收起高级筛选":"高级筛选"}
     </RareButton>
     {showAdvanced&&<div className="search-advanced-fields">
      <label>上传人 ID<RareInput id="search-uploader" value={uploader} onChange={e=>setUploader(e.target.value)} placeholder="输入上传人 ID" maxLength={100}/></label>
      <div className="search-date-range">
       <label>修改开始<RareInput type="date" aria-label="修改开始日期" value={from} onChange={e=>setFrom(e.target.value)}/></label>
       <label>修改结束<RareInput type="date" aria-label="修改结束日期" value={to} onChange={e=>setTo(e.target.value)}/></label>
      </div>
     </div>}
     <RareButton type="submit" form="advanced-search-form" className="primary search-apply">应用筛选</RareButton>
     <div className="search-filter-divider"/>
     <section className="search-saved" aria-label="搜索预设">
      <div className="search-saved-heading"><strong>搜索预设</strong><span>{presets.length}/12</span></div>
      <div className="search-preset-new">
       <RareInput aria-label="预设名称" placeholder="保存当前条件…" maxLength={48} value={presetName} onChange={e=>setPresetName(e.target.value)}/>
       <RareButton type="button" onClick={()=>void savePreset()} disabled={!presetName.trim()||presetBusy}>保存</RareButton>
      </div>
      {presetError&&<span className="error" role="alert">{presetError}</span>}
      <div className="search-preset-list">
       {presets.map(preset=><div className="search-preset-item" key={preset.id}>
        <RareButton type="button" title={"载入 "+preset.name} onClick={()=>loadPreset(preset.fields)}>{preset.name}</RareButton>
        <RareButton type="button" aria-label={"删除预设 "+preset.name} onClick={()=>void deletePreset(preset.name)}>×</RareButton>
       </div>)}
       {presets.length===0&&<span className="search-preset-empty">暂无已保存条件</span>}
      </div>
     </section>
    </aside>
    <section className="search-results" aria-label="搜索结果">
     <div className="search-results-toolbar">
      <div className="search-results-caption"><strong>{title}</strong>
       <span className="search-total">{status==="ready"?"已显示 "+items.length+" / 共 "+shownTotal+" 项":status==="loading"?"":status==="failed"?"检索失败":"应用筛选查看结果"}</span>
      </div>
      <div className="search-results-actions">
       <label>排序<RareSelect id="search-sort" aria-label="搜索结果排序" value={sort} onChange={e=>{
        const next=e.target.value;setSort(next);if(query)setQuery({...query,sort:next});
       }}>
        <option value="updated_desc">最近修改</option><option value="relevance">最佳匹配</option>
        <option value="name_asc">名称 A→Z</option><option value="size_desc">大小降序</option>
       </RareSelect></label>
       <label>每页<RareSelect id="search-limit" aria-label="搜索每页条数" value={pageSize} onChange={e=>{
        const next=Number(e.target.value);setPageSize(next);if(query)setQuery({...query,limit:next});
       }}>{PAGE_SIZES.map(size=><option key={size} value={size}>{size}</option>)}</RareSelect></label>
       <RareButton type="button" disabled={status!=="ready"||items.length===0} onClick={exportLoaded}>导出{items.length>0?" ("+items.length+")":""}</RareButton>
      </div>
     </div>
     {status==="loading"&&<div className="search-result-message" role="status"><BrandLoadingLabel size="sm">检索中…</BrandLoadingLabel></div>}
     {status==="failed"&&<div className="search-result-message" role="alert">检索失败 <RareButton type="button" onClick={()=>setReloadToken(token=>token+1)}>重试</RareButton></div>}
     {status==="ready"&&<div className="table search-table-wrap">
      {items.length===0?<div className="search-empty">
       <strong>{recentView?"暂无可访问的文件":"没有找到匹配的文件"}</strong>
       <span>{recentView?"前往文档管理上传或查看文件。":"可更换关键词，或清除筛选条件。"}</span>
       {recentView?<Link to="/doc">打开文档管理</Link>:<RareButton type="button" onClick={clearFilters}>清除筛选</RareButton>}
      </div>:<RareDataTable className="search-data-table">
       <thead><tr><th scope="col">文件名</th><th className="search-secondary" scope="col">大小</th><th className="search-secondary" scope="col">上传人</th><th className="search-secondary" scope="col">版本</th><th className="search-secondary" scope="col">修改时间</th><th scope="col">所在目录</th></tr></thead>
       <tbody>{items.map(file=><tr key={file.id}>
        <td><Link to={"/preview/"+file.id} title={file.name} className="search-file-link"><FileTypeIcon name={file.name} size={18}/><span>{file.name}</span></Link>
         <div className="search-mobile-meta">{formatBytes(file.sizeBytes)} · v{file.currentVersionSeq} · {file.uploadedBy} · {new Date(file.updatedAt).toLocaleDateString("zh-CN")}</div>
         {file.snippet&&<div className="snippet"><Highlighted text={file.snippet} query={query?.q??""}/></div>}
        </td>
        <td className="search-secondary">{formatBytes(file.sizeBytes)}</td>
        <td className="search-secondary">{file.uploadedBy}</td>
        <td className="search-secondary">v{file.currentVersionSeq}</td>
        <td className="search-secondary rare-data-date">{new Date(file.updatedAt).toLocaleString("zh-CN")}</td>
        <td><Link to={"/doc?folder="+file.folderId} aria-label={"在目录中打开 "+file.name}>打开</Link></td>
       </tr>)}</tbody>
      </RareDataTable>}
      {hasMore&&<div className="search-more">
       {moreStatus==="failed"&&<span className="error" role="alert">加载下一页失败。</span>}
       <RareButton type="button" disabled={moreStatus==="loading"} loading={moreStatus==="loading"} onClick={loadMore}>
        {moreStatus==="failed"?"重试加载":"加载更多"}
       </RareButton>
      </div>}
      {limitReached&&<div className="search-limit-hint">已达检索上限，可进一步缩小筛选范围。</div>}
     </div>}
     {status==="idle"&&<div className="search-result-message">点击「应用筛选」查看结果</div>}
    </section>
   </div>
   {pickerOpen&&<Dialog open title="选择检索目录" onClose={()=>setPickerOpen(false)}>
    {treeState==="loading"?<p className="empty"><BrandLoadingLabel>正在读取目录…</BrandLoadingLabel></p>:treeState==="failed"?<div role="alert" className="notice error">目录读取失败 <RareButton type="button" onClick={()=>setTreeToken(v=>v+1)}>重试</RareButton></div>
     :<FolderPicker open title="选择检索目录" folders={folders} selectedId={candidate} onSelect={setCandidate} onClose={()=>setPickerOpen(false)}
      footer={<><RareButton type="button" onClick={()=>setPickerOpen(false)}>取消</RareButton>
       <RareButton type="button" className="primary" disabled={!candidate} onClick={()=>{setFolder(candidate);setPickerOpen(false);}}>确定</RareButton></>}/>}
   </Dialog>}
  </div>;
}
