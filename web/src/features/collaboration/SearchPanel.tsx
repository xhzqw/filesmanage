import {RareButton,RareInput,RareSelect} from "../../shared/ui/rare";
import {useEffect,useMemo,useRef,useState,type FormEvent} from "react";
import {Link} from "react-router-dom";
import {collaborationApi,formatBytes} from "./api";
import type {FileItem} from "../../entities/file/model";
import type {Folder} from "../../entities/folder/model";
import {FolderPicker} from "../../shared/ui/FolderPicker";
import {Dialog} from "../../shared/ui/Dialog";
import {readSearchPresets,saveSearchPreset,writeSearchPresets,type SearchPresetFields} from "./searchPresets";
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
 const[presets,setPresets]=useState(()=>readSearchPresets(userId));
 const[presetName,setPresetName]=useState("");
 const[showPresets,setShowPresets]=useState(false);
 useEffect(()=>{setPresets(readSearchPresets(userId));setPresetName("");},[userId]);
 function savePreset(){
  const title=presetName.trim();
  if(!title){setMessage("请输入预设名称");return;}
  const fields:SearchPresetFields={q,category,tag,uploader,type,sort,limit:pageSize,scope,folder,from,to};
  const saved=saveSearchPreset(presets,title,fields);
  writeSearchPresets(userId,saved);
  setPresets(saved);setPresetName("");setMessage(`已保存筛选：${title}`);
 }
 function loadPreset(preset:SearchPresetFields){
  setQ(preset.q);setCategory(preset.category);setTag(preset.tag);setUploader(preset.uploader);
  setType(preset.type);setSort(preset.sort);setPageSize(preset.limit);setScope(preset.scope);
  setFolder(preset.folder);setFrom(preset.from);setTo(preset.to);setShowAdvanced(true);
  epochRef.current++;setQuery(null);setItems([]);setStatus("idle");
  setMessage("预设已加载，点击搜索或应用筛选执行");
 }
 function deletePreset(id:string){
  const updated=presets.filter(p=>p.id!==id);
  writeSearchPresets(userId,updated);setPresets(updated);
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
  setQ("");setCategory("");setTag("");setUploader("");setType("");setScope("all");setFolder("");
  setFrom("");setTo("");setSort("updated_desc");setPageSize(DEFAULT_PAGE_SIZE);
  epochRef.current++;moreBusyRef.current=false;setQuery(null);setItems([]);setNextCursor("");setTotal(0);setStatus("idle");setMessage("");
 }
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
  if(from&&to&&from>to){setMessage("开始日期不能晚于结束日期");return;}
  if(scope!=="all"&&!folder){setMessage("请先选择搜索目录");return;}
  if(!q.trim()&&!category.trim()&&!tag.trim()&&!uploader.trim()&&!type.trim()&&!from&&!to&&scope==="all"){
   setMessage("请输入关键词或至少设置一个筛选条件");return;
  }
  // Invalidate the previous revision before React commits, so a page request
  // that resolves in the gap between render and effect cannot append old rows.
  epochRef.current++;
  moreBusyRef.current=false;
  setQuery({q:q.trim(),category:category.trim(),tag:tag.trim(),uploader:uploader.trim(),type:type.trim(),sort,limit:pageSize,folder:scope==="all"?"":folder,scope:scope==="descendants"?"descendants":"",from:boundaryDate(from,false),to:boundaryDate(to,true)});
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
  <form id="advanced-search-form" className="toolbar search-bar search-primary" onSubmit={submit} role="search">
   <RareInput id="search-q" type="search" aria-label="文件名或正文关键词" value={q} onChange={event=>setQ(event.target.value)} placeholder="搜索文件名或正文…" maxLength={200}/>
   <RareButton type="submit" className="primary">搜索</RareButton>
   <RareButton type="button" aria-expanded={showAdvanced} onClick={()=>setShowAdvanced(v=>!v)}>高级筛选</RareButton>
   <RareButton type="button" onClick={clearFilters}>重置</RareButton>
   <RareButton type="button" disabled={status!=="ready"||items.length===0} onClick={exportLoaded}>导出已加载 {items.length} 条</RareButton>
   <RareButton type="button" aria-expanded={showPresets} onClick={()=>setShowPresets(v=>!v)}>搜索预设 {presets.length}</RareButton>
   {message&&<span className="error" role="alert">{message}</span>}
  </form>
  {showPresets&&<div className="search-presets" aria-label="已保存搜索条件">
   <RareInput aria-label="预设名称" placeholder="给当前筛选命名…" maxLength={48} value={presetName} onChange={e=>setPresetName(e.target.value)}/>
   <RareButton type="button" onClick={savePreset} disabled={!presetName.trim()}>保存当前条件</RareButton>
   {presets.map(preset=><div className="search-preset-item" key={preset.id}>
    <RareButton type="button" title="载入搜索条件" onClick={()=>loadPreset(preset.fields)}>{preset.name}</RareButton>
    <RareButton type="button" aria-label={"删除预设 "+preset.name} onClick={()=>deletePreset(preset.id)}>×</RareButton>
   </div>)}
   {presets.length===0&&<span className="hint">暂无预设（最多 12 项）</span>}
  </div>}
  <div className={"search-workbench"+(showAdvanced?" with-filters":"")}>
   {showAdvanced&&<aside className="search-filters" aria-label="高级搜索条件">
    <div className="search-filter-heading"><strong>筛选条件</strong><RareButton type="button" onClick={()=>setShowAdvanced(false)}>收起</RareButton></div>
    <label>范围<RareSelect aria-label="搜索范围" value={scope} onChange={e=>setScope(e.target.value as "all"|"current"|"descendants")}>
     <option value="all">全部可访问</option><option value="current">指定目录</option><option value="descendants">包含子目录</option>
    </RareSelect></label>
    {scope!=="all"&&<div className="search-folder-select">
     <span title={currentFolder?.name??""}>{folder?(currentFolder?.name??"所选目录"):"未选择目录"}</span>
     <RareButton type="button" onClick={()=>{setCandidate(folder);setPickerOpen(true);}}>选择目录</RareButton>
    </div>}
    <label>分类<RareInput id="search-category" value={category} onChange={e=>setCategory(e.target.value)} placeholder="如：工程图纸" maxLength={80}/></label>
    <label>标签<RareInput id="search-tag" value={tag} onChange={e=>setTag(e.target.value)} placeholder="精确标签" maxLength={80}/></label>
    <label>上传人 ID<RareInput id="search-uploader" value={uploader} onChange={e=>setUploader(e.target.value)} placeholder="上传人 ID" maxLength={100}/></label>
    <label>格式<RareSelect aria-label="文件格式筛选" value={type} onChange={e=>setType(e.target.value)}>
     <option value="">全部格式</option><option value="application/pdf">PDF</option><option value="image/">图片</option>
     <option value="video/">视频</option><option value="audio/">音频</option><option value="text/">纯文本</option>
     <option value="application/vnd.">Office / 结构化文档</option>
    </RareSelect></label>
    <div className="search-date-range">
     <label>修改开始<RareInput type="date" aria-label="修改开始日期" value={from} onChange={e=>setFrom(e.target.value)}/></label>
     <label>修改结束<RareInput type="date" aria-label="修改结束日期" value={to} onChange={e=>setTo(e.target.value)}/></label>
    </div>
    <label>排序<RareSelect id="search-sort" value={sort} onChange={e=>setSort(e.target.value)}>
     <option value="updated_desc">最近修改</option><option value="name_asc">名称 A→Z</option><option value="size_desc">大小降序</option>
    </RareSelect></label>
    <label>每页<RareSelect id="search-limit" value={pageSize} onChange={e=>setPageSize(Number(e.target.value))}>
     {PAGE_SIZES.map(size=><option key={size} value={size}>{size} 条</option>)}
    </RareSelect></label>
    <RareButton type="submit" form="advanced-search-form" className="primary">应用筛选</RareButton>
   </aside>}
   <div className="search-results">

  {status==="loading"?<p className="notice" role="status">检索中…</p>:null}
  {status==="failed"?<>
   <p role="alert" className="notice error">检索失败，请稍后重试。</p>
   <RareButton type="button" className="secondary-action" onClick={()=>setReloadToken(token=>token+1)}>重试</RareButton>
  </>:null}
  {status==="ready"?<div className="table">
   <div className="search-total">已显示 {items.length} / 共 {capped?TOTAL_CAP+"+":total} 个结果 · 每页最多 {loadedLimit} 条（仅显示你有权访问的文件）{limitReached?<> · 已达本次检索可浏览的上限，请添加筛选条件缩小范围</>:null}</div>
   {items.length===0?<p className="empty">没有匹配的文件。换个关键词，或确认你有该内容的预览权限。</p>:(
    <table>
     <thead><tr><th scope="col">文件名</th><th scope="col">大小</th><th scope="col">上传人</th><th scope="col">版本</th><th scope="col">修改日期</th><th scope="col">所在目录</th></tr></thead>
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
    <RareButton type="button" className="secondary-action" disabled={moreStatus==="loading"} onClick={loadMore}>
     {moreStatus==="loading"?"加载中…":moreStatus==="failed"?"重试加载":"加载更多"}
    </RareButton>
   </div>:null}
  </div>:null}
  {status==="idle"?<p className="empty">输入关键词或使用高级筛选检索有权限访问的文件。</p>:null}
   </div>
  </div>
  {pickerOpen&&<Dialog open title="选择检索目录" onClose={()=>setPickerOpen(false)}>
   {treeState==="loading"?<p className="empty">正在读取目录…</p>:treeState==="failed"?<div role="alert" className="notice error">目录读取失败 <RareButton type="button" onClick={()=>setTreeToken(v=>v+1)}>重试</RareButton></div>
    :<FolderPicker open title="选择检索目录" folders={folders} selectedId={candidate} onSelect={setCandidate} onClose={()=>setPickerOpen(false)}
     footer={<><RareButton type="button" onClick={()=>setPickerOpen(false)}>取消</RareButton>
      <RareButton type="button" className="primary" disabled={!candidate} onClick={()=>{setFolder(candidate);setPickerOpen(false);}}>确定</RareButton></>}/>}
  </Dialog>}
 </div>;
}
