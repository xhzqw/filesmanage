// DocumentPicker.tsx
// 「关联文档」的选择面板：从受控文件库里挑文件，而不是手输名字。
// 落地位置：web/src/shared/ui/DocumentPicker.tsx（与 FolderPicker 同层，可被其它模块复用）。
//
// 设计约束（对齐 shared/ui/FolderPicker.tsx 的既有约定）：
//  · 面板本身不是 dialog，渲染在宿主 Dialog 里，因此背景/焦点陷阱/遮罩都由 Dialog 负责；
//  · shared 层不得依赖 features/entities（scripts/check_architecture.py），因此数据源由宿主
//    通过 `source` 注入：生产环境用 fileApi.list / folderApi.children，测试可注入假数据；
//  · 颜色全部取 theme.css 语义 token，不写裸色值。
//
// 逐级浏览：从根目录进入，点文件夹下钻、用面包屑回退；切换目录时文件与子文件夹同页刷新。
// 已选中的文件跨目录保留 —— 用户可以在多个目录里凑齐一批再一起关联。

import{useCallback,useEffect,useMemo,useRef,useState}from "react";
import{Dialog}from"./Dialog";
import{RareButton,RareInput}from"./rare";
import{FolderResourceIcon}from"./ResourceIcons";
import{FileTypeIcon}from"./FileTypeIcon";
import{errorCopy}from"../errors";
import"./documentPicker.css";

export type PickedDocument={docId:string;name:string;kind:"gdrive"|"pdf"|"figma"|"file"};

// Structural copies of the document/folder read rows: a shared -> entities or
// shared -> features import fails the architecture gate, and the host already
// holds richer objects, so these shapes stay assignable without casts.
export type DocumentPickerItem={
 id:string;name:string;sizeBytes:number;updatedAt:string;
 kind?:PickedDocument["kind"];
};
export type DocumentPickerFolder={id:string;name:string;hasChildren:boolean};
export type DocumentPickerPage={items:DocumentPickerItem[];nextCursor:string};
export type DocumentPickerSource={
 folders:(parentId:string)=>Promise<DocumentPickerFolder[]>;
 files:(folderId:string,cursor:string,signal?:AbortSignal)=>Promise<DocumentPickerPage>;
};

const PAGE_SIZE=20;
const FOLDER_LIMIT=50;
const MAX_DEPTH=32;
type Crumb={id:string;name:string};

function kindOf(name:string,contentType:string):PickedDocument["kind"]{
 const lower=name.toLowerCase();
 if(lower.endsWith(".pdf")||contentType==="application/pdf")return"pdf";
 if(lower.endsWith(".fig")||lower.endsWith(".figma"))return"figma";
 if(/\.(gdoc|gsheet|gslide)$/.test(lower))return"gdrive";
 return"file";
}
function sizeText(bytes:number){
 if(!Number.isFinite(bytes)||bytes<=0)return"—";
 const u=["B","KB","MB","GB"];let n=bytes,i=0;
 while(n>=1024&&i<u.length-1){n/=1024;i++;}
 return (i===0?String(n):n.toFixed(n>=10?0:1))+" "+u[i];
}
function shortTime(iso:string){
 if(!iso)return"—";
 const d=new Date(iso);
 if(Number.isNaN(d.getTime()))return"—";
 const p=(n:number)=>String(n).padStart(2,"0");
 return d.getFullYear()+"/"+p(d.getMonth()+1)+"/"+p(d.getDate());
}

export function DocumentPicker({open,title="选择要关联的文档",excludeIds=[],source,onPick,onClose}:{
 open:boolean;
 title?:string;
 excludeIds?:readonly string[];
 source:DocumentPickerSource;
 onPick:(docs:PickedDocument[])=>void;
 onClose:()=>void;
}){
 // 当前目录："" 表示根
 const[folderId,setFolderId]=useState("");
 const[crumbs,setCrumbs]=useState<Crumb[]>([{id:"",name:"全部文件"}]);

 const[folders,setFolders]=useState<DocumentPickerFolder[]>([]);
 const[items,setItems]=useState<DocumentPickerItem[]>([]);
 const[cursor,setCursor]=useState("");
 const[hasMore,setHasMore]=useState(false);
 const[busy,setBusy]=useState(false);
 const[error,setError]=useState("");
 const[query,setQuery]=useState("");

 // 选中项按 id 存，并缓存名字/类型：跨目录挑选后仍要能正确回填
 const[picked,setPicked]=useState<{docId:string;name:string;kind:PickedDocument["kind"]}[]>([]);
 const listRef=useRef<HTMLDivElement|null>(null);
 const exclude=useMemo(()=>new Set(excludeIds),[excludeIds]);

 // 一次请求同时取「子文件夹 + 文件」，切换目录时两者一起换，不会出现新旧混排
 const loadDir=useCallback(async(dirId:string,cursorIn:string,append:boolean,signal?:AbortSignal)=>{
  setBusy(true);setError("");
  try{
   const [folderList,filePage]=await Promise.all([
    append?Promise.resolve(null):source.folders(dirId),
    source.files(dirId,cursorIn,signal),
   ]);
   if(folderList){
    setFolders(folderList.slice(0,FOLDER_LIMIT));
   }
   setItems(prev=>{
    const base=append?prev:[];
    const seen=new Set(base.map(f=>f.id));
    return base.concat((filePage.items??[]).filter(f=>!seen.has(f.id)));
   });
   setCursor(filePage.nextCursor??"");
   setHasMore(!!filePage.nextCursor);
  }catch(e){
   if(e instanceof DOMException&&e.name==="AbortError")return;
   setError(errorCopy(e,"目录加载失败"));
  }finally{setBusy(false);}
 },[source]);

 // 进入/切换目录
 useEffect(()=>{
  if(!open)return;
  const controller=new AbortController();
  setItems([]);setFolders([]);setCursor("");setHasMore(false);
  void loadDir(folderId,"",false,controller.signal);
  return()=>controller.abort();
 },[open,folderId,loadDir]);

 // 打开时重置到根目录，并清空上一次的选择
 useEffect(()=>{
  if(!open)return;
  setFolderId("");setCrumbs([{id:"",name:"全部文件"}]);setQuery("");setPicked([]);
 },[open]);

 useEffect(()=>{
  if(!open)return;
  const t=window.setTimeout(()=>{listRef.current?.querySelector<HTMLInputElement>(".doc-picker-search")?.focus();},30);
  return()=>window.clearTimeout(t);
 },[open]);

 function enterFolder(f:{id:string;name:string}){
  if(crumbs.length>MAX_DEPTH)return;
  setFolderId(f.id);
  setCrumbs(c=>[...c,{id:f.id,name:f.name}]);
  setQuery("");
 }
 function gotoCrumb(i:number){
  const next=crumbs.slice(0,i+1);
  const last=next[next.length-1];
  if(!last)return;
  setFolderId(last.id);setCrumbs(next);setQuery("");
 }
 function goUp(){
  if(crumbs.length<=1)return;
  gotoCrumb(crumbs.length-2);
 }

 const folderMatches=useMemo(()=>{
  const q=query.trim().toLowerCase();
  if(!q)return folders;
  return folders.filter(f=>f.name.toLowerCase().includes(q));
 },[folders,query]);

 const fileMatches=useMemo(()=>{
  const q=query.trim().toLowerCase();
  if(!q)return items;
  return items.filter(f=>f.name.toLowerCase().includes(q));
 },[items,query]);

 const pickable=fileMatches.filter(f=>!exclude.has(f.id)&&!picked.some(p=>p.docId===f.id));
 const allPickedInView=pickable.length>0&&pickable.every(f=>picked.some(p=>p.docId===f.id));

 function kindFor(f:DocumentPickerItem){return f.kind??kindOf(f.name,"");}
 function toggle(f:DocumentPickerItem){
  setPicked(list=>{
   const hit=list.some(p=>p.docId===f.id);
   if(hit)return list.filter(p=>p.docId!==f.id);
   return [...list,{docId:f.id,name:f.name,kind:kindFor(f)}];
  });
 }
 function removePicked(id:string){setPicked(list=>list.filter(p=>p.docId!==id));}
 function selectAllVisible(){
  const ids=pickable.map(f=>f.id);
  setPicked(list=>{
   const every=ids.length>0&&ids.every(id=>list.some(p=>p.docId===id));
   if(every)return list.filter(p=>!ids.includes(p.docId));
   const add=pickable.filter(f=>!list.some(p=>p.docId===f.id))
    .map(f=>({docId:f.id,name:f.name,kind:kindFor(f)}));
   return [...list,...add];
  });
 }
 function confirmPick(){
  if(!picked.length){onClose();return;}
  onPick(picked);setPicked([]);onClose();
 }

 const isEmpty=!busy&&!error&&folderMatches.length===0&&pickable.length===0;

 return<Dialog open={open} title={title} onClose={onClose} className="doc-picker-dialog" initialFocus=".doc-picker-search">
  <div className="doc-picker" ref={listRef}>
   {/* 面包屑：逐级回退，当前层不可点 */}
   <nav className="doc-picker-crumbs" aria-label="目录路径">
    {crumbs.length>1&&<button type="button" className="doc-crumb-up" onClick={goUp} aria-label="返回上一级" title="返回上一级">↑</button>}
    {crumbs.map((c,i)=>{
     const last=i===crumbs.length-1;
     return<span className="doc-crumb" key={c.id||"root"}>
      {i>0&&<span className="doc-crumb-sep" aria-hidden="true">/</span>}
      {last
       ?<span className="doc-crumb-now" aria-current="location">{c.name}</span>
       :<button type="button" className="doc-crumb-btn" onClick={()=>gotoCrumb(i)}>{c.name}</button>}
     </span>;
    })}
   </nav>

   <div className="doc-picker-bar">
    <RareInput type="search" className="doc-picker-search" placeholder="在当前目录内筛选…" value={query}
     aria-label="在当前目录内筛选" onChange={e=>setQuery(e.target.value)}/>
    <RareButton type="button" tone="ghost" onClick={selectAllVisible} disabled={!pickable.length}>
     {allPickedInView?"取消全选":"全选当前"}
    </RareButton>
   </div>

   {error&&<p className="doc-picker-error" role="alert">{error}
    <RareButton type="button" tone="ghost" onClick={()=>void loadDir(folderId,"",false)}>重试</RareButton></p>}

   <div className="doc-picker-list" role="listbox" aria-multiselectable="true"
    aria-busy={busy?"true":undefined} aria-label={crumbs[crumbs.length-1]?.name??"文件列表"}>

    {/* 子文件夹在前，点进去继续浏览 */}
    {folderMatches.map(f=>
     <button type="button" key={"f-"+f.id} className="doc-picker-row doc-picker-folder"
      onClick={()=>enterFolder(f)} aria-label={"进入文件夹 "+f.name}>
      <span className="doc-picker-check doc-picker-check-empty" aria-hidden="true"/>
      <FolderResourceIcon size={16}/>
      <span className="doc-picker-name" title={f.name}>{f.name}</span>
      <span className="doc-picker-chev" aria-hidden="true">›</span>
     </button>)}

    {pickable.map(f=>{
     const on=picked.some(p=>p.docId===f.id);
     return<button type="button" role="option" aria-selected={on} key={f.id}
      className={"doc-picker-row"+(on?" picked":"")} onClick={()=>toggle(f)}>
      <span className="doc-picker-check" aria-hidden="true">{on?"✓":""}</span>
      <FileTypeIcon name={f.name} size={18}/>
      <span className="doc-picker-name" title={f.name}>{f.name}</span>
      <span className="doc-picker-meta">{sizeText(f.sizeBytes)}</span>
      <span className="doc-picker-meta doc-picker-time">{shortTime(f.updatedAt)}</span>
     </button>;
    })}

    {isEmpty&&<p className="doc-picker-empty">
     {query.trim()
      ?"当前目录里没有匹配项，换个关键词或切到上层目录"
      :(crumbs.length>1?"这个文件夹是空的":"这里还没有可关联的文档")}
    </p>}
    {busy&&items.length===0&&folders.length===0&&<p className="doc-picker-empty">正在加载…</p>}
   </div>

   {hasMore&&!query.trim()&&<div className="doc-picker-more">
    <RareButton type="button" tone="ghost" loading={busy} onClick={()=>void loadDir(folderId,cursor,true)}>加载更多</RareButton>
   </div>}

   {/* 已选清单：跨目录挑选时能一眼确认到底选了哪些 */}
   {picked.length>0&&<div className="doc-picker-chosen" aria-label="已选文档">
    {picked.map(p=>
     <span className="doc-chosen-chip" key={p.docId}>
      <FileTypeIcon name={p.name} size={13}/>
      <span className="doc-chosen-name" title={p.name}>{p.name}</span>
      <button type="button" aria-label={"移除 "+p.name} onClick={()=>removePicked(p.docId)}>✕</button>
     </span>)}
   </div>}

   <div className="doc-picker-foot">
    <span className="doc-picker-count">{picked.length?"已选 "+picked.length+" 个":"未选择"}</span>
    <span className="doc-picker-spacer"/>
    <RareButton type="button" tone="ghost" onClick={onClose}>取消</RareButton>
    <RareButton type="button" tone="primary" disabled={!picked.length} onClick={confirmPick}>
     {picked.length?"关联 "+picked.length+" 个":"关联"}
    </RareButton>
   </div>
  </div>
 </Dialog>;
}
