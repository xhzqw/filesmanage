import {useEffect,useLayoutEffect,useMemo,useRef,useState} from "react";
import {Link,useLocation,useSearchParams} from "react-router-dom";
import type {User} from "../entities/user/model";
import {AppShell} from "../shared/ui/AppShell";
import {RareButton,RareInput,RareSelect,RareTextarea} from "../shared/ui/rare";
import {ApiError,request} from "../shared/http";
import {errorCopy} from "../shared/errors";
import "./knowledgeWorkspace.css";

type Kind="paragraph"|"heading1"|"heading2"|"bullet"|"todo"|"quote";
type Block={id:string;type:Kind;text:string;checked?:boolean};
type FileRef={fileId:string;fileName:string};
type Page={id:string;ownerId:string;title:string;parentId:string|null;folderId:string|null;revision:number;blocks:Block[];canEdit?:boolean;files?:FileRef[]};
type Backlink={pageId:string;title:string};
type Version={revision:number;title:string;blocks:Block[];editorId:string;recordedAt:string};
type PageLink={pageId:string;title:string;direction:"incoming"|"outgoing"};
const enc=encodeURIComponent,base="/knowledge/pages/";
const kinds:Kind[]=["paragraph","heading1","heading2","bullet","todo","quote"];
const labels=["正文","标题","小标题","项目符号","待办","引用"];
const fresh=():Block=>({id:"block_"+crypto.randomUUID(),type:"paragraph",text:""});
export function KnowledgeWorkspace({user,onLogout,embedded=false}:{user:User;onLogout:()=>void;embedded?:boolean}){
 const[params,setParams]=useSearchParams();
 const pageId=params.get("page")||"",folderId=params.get("folder")||"";
 const fileId=params.get("file")||"",attachFile=params.get("attachFile")||"";
 const[pages,setPages]=useState<Page[]>([]);
 const[page,setPage]=useState<Page|null>(null),[draft,setDraft]=useState<Page|null>(null);
 const[homeId,setHomeId]=useState(""),[backlinks,setBacklinks]=useState<Backlink[]>([]);
 const[history,setHistory]=useState<Version[]|null>(null);
 const[links,setLinks]=useState<PageLink[]>([]),[targetPage,setTargetPage]=useState("");
 const[title,setTitle]=useState(""),[createParent,setCreateParent]=useState<string|null>(null);
 const[error,setError]=useState(""),[notice,setNotice]=useState(""),[busy,setBusy]=useState(false),[stamp,setStamp]=useState(0);
 const[slashBlock,setSlashBlock]=useState<string|null>(null);
 const[saving,setSaving]=useState(false),[saveBlocked,setSaveBlocked]=useState(false);
 const[conflictServer,setConflictServer]=useState<Page|null>(null);
 const savingRef=useRef(false);
 const routerLocation=useLocation();
 const lastRoute=useRef({href:window.location.href,index:window.history.state?.idx as number|undefined});
 useLayoutEffect(()=>{
  lastRoute.current={href:window.location.href,index:window.history.state?.idx as number|undefined};
 },[routerLocation.key,routerLocation.pathname,routerLocation.search]);
 const activePageId=useRef(pageId);
 activePageId.current=pageId;
 const showHistory=async()=>{if(!page)return;setError("");if(history!==null){setHistory(null);return}try{setHistory(await request<Version[]>(base+enc(page.id)+"/history"))}catch(e){setError(errorCopy(e,"修订历史读取失败"))}};
 const dirty=Boolean(page&&draft&&(page.title!==draft.title||JSON.stringify(page.blocks)!==JSON.stringify(draft.blocks)));
 const reload=()=>setStamp(x=>x+1);
 const hasPendingChanges=dirty||saving;
 const leaveMessage="当前页面有尚未保存的修改。确定放弃这些修改并离开吗？";
 // An in-flight write cannot be cancelled: navigation must wait for its
 // authoritative acknowledgement rather than promise an impossible discard.
 const confirmLeave=()=>!saving&&window.confirm(leaveMessage);
 const go=(id:string)=>{
  if(id===pageId)return;
  if(hasPendingChanges&&!confirmLeave())return;
  const next=new URLSearchParams(params);if(id)next.set("page",id);else next.delete("page");setParams(next);
 };
 useEffect(()=>{
  if(!embedded||!hasPendingChanges)return;
  const beforeUnload=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue="";};
  let rollingBack=false;
  const beforePop=(event:PopStateEvent)=>{
   if(rollingBack){rollingBack=false;event.stopImmediatePropagation();return;}
   if(confirmLeave())return;
   // BrowserRouter listens in the bubble phase. Prevent its transition and
   // return to the original history index without discarding the draft.
   event.stopImmediatePropagation();
   const current=lastRoute.current;
   const nextIndex=event.state?.idx;
   const delta=typeof current.index==="number"&&typeof nextIndex==="number"
    ?current.index-nextIndex:0;
   if(delta){rollingBack=true;window.history.go(delta);}
   else window.history.replaceState({...window.history.state,idx:current.index}, "",current.href);
  };
  // Links in the global shell, page tree and breadcrumb live outside the
  // editor; React Router's BrowserRouter does not guard those transitions.
  const beforeClick=(event:MouseEvent)=>{
   if(event.defaultPrevented||event.button!==0)return;
   const element=event.target;
   if(!(element instanceof Element))return;
   const anchor=element.closest<HTMLAnchorElement>("a[href]");
   if(anchor){
    if(anchor.hasAttribute("download")||anchor.target==="_blank")return;
    const destination=new URL(anchor.href,window.location.href);
    const here=new URL(window.location.href);
    if(destination.pathname===here.pathname&&destination.search===here.search)return;
   }else{
    const button=element.closest<HTMLButtonElement>("button");
    if(!button||!button.matches(".cdw-rail-item, .wbn-new-child, .wbn-pages-head button, .wbn-empty"))return;
    if(button.matches(".cdw-rail-item.is-current"))return;
   }
   if(!confirmLeave()){event.preventDefault();event.stopPropagation();}
  };
  window.addEventListener("beforeunload",beforeUnload);
  window.addEventListener("popstate",beforePop,true);
  document.addEventListener("click",beforeClick,true);
  return()=>{
   window.removeEventListener("beforeunload",beforeUnload);
   window.removeEventListener("popstate",beforePop,true);
   document.removeEventListener("click",beforeClick,true);
  };
 },[embedded,hasPendingChanges]);
 useEffect(()=>{let live=true;request<Page[]>("/knowledge/pages").then(x=>{if(live)setPages(x||[])}).catch(e=>{if(live)setError(errorCopy(e,"页面树加载失败"))});return()=>{live=false}},[stamp]);
 useEffect(()=>{let live=true;setPage(null);setDraft(null);setError("");setNotice("");setHistory(null);setSaveBlocked(false);setConflictServer(null);setSlashBlock(null);
  if(pageId)request<Page>(base+enc(pageId)).then(p=>{if(live){setPage(p);setDraft({...p,blocks:p.blocks.map(b=>({...b}))})}}).catch(e=>{if(live)setError(errorCopy(e,"页面读取失败"))});
  return()=>{live=false};
 },[pageId,stamp]);
 useEffect(()=>{let live=true;setLinks([]);
  if(pageId)request<PageLink[]>(base+enc(pageId)+"/links").then(items=>{if(live)setLinks(items||[])})
    .catch(e=>{if(live)setError(errorCopy(e,"页面关联读取失败"))});
  return()=>{live=false};
 },[pageId,stamp]);
 useEffect(()=>{let live=true;setHomeId("");if(folderId)request<{pageId:string}>("/knowledge/folders/"+enc(folderId)+"/home").then(x=>{if(live)setHomeId(x.pageId)}).catch(e=>{if(live)setError(errorCopy(e,"文件夹首页读取失败"))});return()=>{live=false}},[folderId,stamp]);
 useEffect(()=>{let live=true;setBacklinks([]);if(fileId)request<Backlink[]>("/knowledge/files/"+enc(fileId)+"/backlinks").then(x=>{if(live)setBacklinks(x||[])}).catch(e=>{if(live)setError(errorCopy(e,"反向引用读取失败"))});return()=>{live=false}},[fileId,stamp]);
 async function create(){if(!title.trim()||busy)return;setBusy(true);try{const p=await request<Page>("/knowledge/pages",{method:"POST",body:JSON.stringify({title:title.trim(),parentId:createParent||"",folderId})});setCreateParent(null);setTitle("");window.dispatchEvent(new Event("filesmanage:knowledge-changed"));go(p.id);reload()}catch(e){setError(errorCopy(e,"创建页面失败"))}finally{setBusy(false)}}
 async function save(){
  if(!draft||!dirty||busy||savingRef.current)return;
   const snapshot={...draft,blocks:draft.blocks.map(b=>({...b}))};
   savingRef.current=true;setSaving(true);setSaveBlocked(false);
   setConflictServer(null);
  try{
   const saved=await request<Page>(base+enc(snapshot.id),{
    method:"PUT",body:JSON.stringify({title:snapshot.title,blocks:snapshot.blocks,revision:snapshot.revision})
   });
   // Never destroy unsaved keystrokes or move the caret after a debounced save.
   setPage(current=>current?.id===snapshot.id?saved:current);
   setDraft(current=>{
    if(current?.id!==snapshot.id)return current;
    // A save may normalize blocks server-side. When no newer keystrokes exist,
    // align with the returned canonical revision/content to clear dirty state.
    // If typing continued during the request, retain the newer draft.
    const unchanged=current.title===snapshot.title&&
     JSON.stringify(current.blocks)===JSON.stringify(snapshot.blocks);
    return unchanged?{...current,title:saved.title,blocks:saved.blocks,revision:saved.revision}
     :{...current,revision:saved.revision};
   });
   if(activePageId.current===snapshot.id)setError("");
   window.dispatchEvent(new Event("filesmanage:knowledge-changed"));
  }catch(e){
   if(activePageId.current===snapshot.id){
    setSaveBlocked(true);
    if(e instanceof ApiError&&(e.httpStatus===409||e.httpStatus===0)){
     try{
      const latest=await request<Page>(base+enc(snapshot.id));
      if(activePageId.current!==snapshot.id)return;
      if(latest.title===snapshot.title&&JSON.stringify(latest.blocks)===JSON.stringify(snapshot.blocks)){
       setPage(latest);
       setDraft(current=>current?.id===snapshot.id?{...current,revision:latest.revision}:current);
       setSaveBlocked(false);setError("");return;
      }
      if(e.httpStatus===409&&e.code==="E_CONFLICT"){
       setConflictServer(latest);
       setError("页面已有更新，当前草稿仍保留。请选择要使用的版本。");
       return;
      }
     }catch{ /* Keep the current draft if the read-back fails. */ }
    }
    setError(errorCopy(e,"保存未确认，草稿已保留。请核对网络后重试。"));
   }
  }finally{
   savingRef.current=false;setSaving(false);
  }
 }
 function resolveConflict(useMine:boolean){
  if(!draft||!conflictServer||draft.id!==conflictServer.id)return;
  if(!window.confirm(useMine
   ?"将以你的当前草稿覆盖服务器最新内容，可能替换他人的修改。确定继续？"
   :"放弃当前未保存的修改，使用服务器的最新版本？"))return;
  const latest=conflictServer;
  setPage(latest);
  setDraft(current=>current?.id===latest.id
   ?useMine?{...current,revision:latest.revision}:{...latest,blocks:latest.blocks.map(b=>({...b}))}
   :current);
  setConflictServer(null);setError("");setSaveBlocked(false);
 }
 useEffect(()=>{
  if(!embedded||!draft?.canEdit||!dirty||busy||saving||saveBlocked)return;
  const timer=window.setTimeout(()=>{void save()},1500);
  return()=>window.clearTimeout(timer);
 },[embedded,draft,page,dirty,busy,saving,saveBlocked]);
 async function setHome(){if(!draft?.folderId||draft.folderId!==folderId)return;setBusy(true);try{await request("/knowledge/folders/"+enc(folderId)+"/home",{method:"PUT",body:JSON.stringify({pageId:draft.id})});setHomeId(draft.id);setNotice("已手动关联为当前文件夹的知识首页")}catch(e){setError(errorCopy(e,"关联失败"))}finally{setBusy(false)}}
 async function unlinkHome(){
  if(!folderId||!homeId||busy)return;
  setBusy(true);
  try{
   await request("/knowledge/folders/"+enc(folderId)+"/home",{method:"DELETE"});
   setHomeId("");setNotice("已解除知识首页关联，知识页及历史记录已保留");
  }catch(e){setError(errorCopy(e,"解除知识首页失败"))}finally{setBusy(false)}
 }
 async function fileLink(id:string,remove=false){if(!draft)return;if(dirty){setError("请先保存页面内容，再修改文件引用");return;}setBusy(true);try{await request(base+enc(draft.id)+"/files/"+enc(id),{method:remove?"DELETE":"PUT"});setNotice(remove?"已解除引用":"文件引用已建立，原文件权限不变");reload()}catch(e){setError(errorCopy(e,"更新文件引用失败"))}finally{setBusy(false)}}
 async function pageLink(id:string,remove=false){
  if(!draft||!id||busy)return;
  if(dirty){setError("请先保存页面内容，再修改页面关联");return;}
  setBusy(true);setError("");
  try{
   await request(base+enc(draft.id)+"/links/"+enc(id),{method:remove?"DELETE":"PUT"});
   setTargetPage("");setNotice(remove?"已解除页面关联":"已关联知识页面，双方均可查看来源");
   reload();
  }catch(e){setError(errorCopy(e,"知识页面关联失败"))}finally{setBusy(false)}
 }
 async function archive(){if(!draft)return;if(dirty){setError("请先保存页面内容，再归档");return;}if(!confirm("归档知识页？有子页面或已设为首页时不可归档。"))return;setBusy(true);try{await request(base+enc(draft.id)+"/archive",{method:"POST",body:JSON.stringify({revision:draft.revision})});window.dispatchEvent(new Event("filesmanage:knowledge-changed"));go("");reload()}catch(e){setError(errorCopy(e,"无法归档该页面"))}finally{setBusy(false)}}
 function editBlock(index:number,change:Partial<Block>){setDraft(prev=>prev?{...prev,blocks:prev.blocks.map((b,i)=>i===index?{...b,...change}:b)}:prev)}
 function selectBlockKind(index:number,type:Kind){
  editBlock(index,{type});setSlashBlock(null);
 }
 function focusBlock(id:string,atEnd=false){
  requestAnimationFrame(()=>{
   const element=document.querySelector<HTMLTextAreaElement>('[data-kn-block="'+id+'"] textarea');
   element?.focus();
   const offset=atEnd?element?.value.length??0:0;
   element?.setSelectionRange(offset,offset);
  });
 }
 const available=pages.filter(p=>!folderId||p.folderId===folderId);
 function tree(parent:string|null,depth=0):React.ReactNode{
  if(depth>25)return null;
  return available.filter(p=>p.parentId===parent||(depth===0&&!available.some(x=>x.id===p.parentId))).map(p=><div key={p.id}>
   <div className={"kn-tree-item"+(pageId===p.id?" is-current":"")} style={{paddingLeft:10+depth*15}}>
    <RareButton type="button" tone="ghost" onClick={()=>go(p.id)}>▤　{p.title}</RareButton>
    {p.ownerId===user.id?<RareButton type="button" tone="ghost" aria-label={"在"+p.title+"下新建子页面"} onClick={()=>{setCreateParent(p.id);setTitle("");}}>＋</RareButton>:null}
   </div>
   {tree(p.id,depth+1)}
  </div>);
 }
 const canEdit=Boolean(draft?.canEdit);
 const siblingPages=pages.filter(p=>p.folderId===folderId);
 const ancestors=useMemo(()=>{
  const byId=new Map(pages.map(p=>[p.id,p]));
  const chain:Page[]=[];
  const visited=new Set<string>(draft?[draft.id]:[]);
  let cursor=draft?.parentId;
  while(cursor&&!visited.has(cursor)&&chain.length<20){
   visited.add(cursor);
   const parent=byId.get(cursor);
   if(!parent)break;
   chain.unshift(parent);
   cursor=parent.parentId;
  }
  return chain;
 },[pages,draft?.id,draft?.parentId]);
 const content=<div className="kn-in-workbench">
  <div className="kn-shell">
   {!embedded?<aside className="kn-nav" aria-label="知识页面树">
    <div className="kn-nav-header"><Link to="/workbench">‹ 工作台</Link><strong>知识空间</strong></div>
    <div className="kn-nav-actions"><RareButton tone="primary" type="button" onClick={()=>{setCreateParent("");setTitle("")}}>＋ 新建页面</RareButton></div>
    {folderId?<div className="kn-context"><Link to={"/doc?folder="+enc(folderId)}>返回当前文件夹</Link><span>文件夹关联页面</span></div>:<div className="kn-context">我的知识页面</div>}
    <div className="kn-tree">{tree(null)}{!available.length?<p className="kn-muted">尚无页面，从新建开始</p>:null}</div>
   </aside>:null}
   <main className="kn-canvas">
    {embedded?<nav className="kn-breadcrumb" aria-label="页面位置">
      <Link to="/workbench">工作空间</Link><span>/</span>
      {ancestors.map(parent=><span className="kn-ancestor" key={parent.id}>
       <Link to={"/workbench?view=knowledge&page="+enc(parent.id)+(folderId?"&folder="+enc(folderId):"")}>{parent.title}</Link>
       <span>/</span>
      </span>)}
      <span>{draft?.title||"知识页面"}</span>
     </nav>:null}
    {error?<p role="alert" className="kn-alert">{error}</p>:null}
    {conflictServer&&draft?.id===conflictServer.id?<section className="kn-conflict" role="region" aria-label="页面保存冲突">
     <strong>检测到新的服务器版本</strong>
     <p>服务器为 v{conflictServer.revision}；当前未保存草稿仍在编辑区。请对照内容后自行决定，不会自动覆盖任何版本。</p>
     <details><summary>查看服务器版本内容</summary>
      <strong>{conflictServer.title}</strong>
      {conflictServer.blocks.map(b=><p key={b.id}>{b.text||"（空内容块）"}</p>)}
     </details>
     <div className="kn-conflict-actions">
      <RareButton type="button" onClick={()=>resolveConflict(false)}>使用服务器版本</RareButton>
      <RareButton type="button" tone="danger" onClick={()=>resolveConflict(true)}>以我的草稿覆盖</RareButton>
     </div>
    </section>:null}
    {saveBlocked&&!conflictServer&&draft?.canEdit?<div className="kn-retry">
     <RareButton type="button" disabled={saving} onClick={()=>void save()}>重试保存</RareButton>
    </div>:null}
    {notice?<p role="status" className="kn-notice">{notice}</p>:null}
    {createParent!==null?<div className="kn-create">
     <strong>{createParent?"创建子页面":folderId?"在当前文件夹新建知识页":"新建独立知识页"}</strong>

     <RareInput autoFocus maxLength={180} placeholder="知识页面标题" value={title} onChange={e=>setTitle(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")void create()}}/>
     <div><RareButton tone="primary" type="button" disabled={!title.trim()||busy} onClick={()=>void create()}>创建</RareButton> <RareButton type="button" onClick={()=>setCreateParent(null)}>取消</RareButton></div>
    </div>:null}
    {fileId?<section className="kn-context-panel"><strong>引用当前文件的知识页面</strong>
      {!backlinks.length?<p className="kn-muted">暂无你有权访问的关联页面</p>:backlinks.map(b=><RareButton key={b.pageId} type="button" onClick={()=>go(b.pageId)}>{b.title}</RareButton>)}
    </section>:null}
    {folderId?<section className="kn-context-panel"><strong>文件夹知识首页</strong>
     {homeId?<><Link to={"/workbench?view=knowledge&folder="+enc(folderId)+"&page="+enc(homeId)}>打开已关联的知识首页</Link><RareButton type="button" tone="ghost" disabled={busy} onClick={()=>void unlinkHome()}>解除关联</RareButton></>:<span className="kn-muted">尚未关联；默认不会自动创建</span>}
     {!homeId&&siblingPages.length?<span className="kn-muted">选择已有知识页后，可将其手动关联</span>:null}
    </section>:null}
    {draft?<article className="kn-page" aria-label="知识页面编辑区">
     <div className="kn-page-top"><span aria-live="polite">{saving?"保存中…":saveBlocked?"保存失败":dirty?"未保存":"已保存"}</span><div>
      {folderId&&draft.folderId===folderId&&canEdit?<RareButton type="button" disabled={busy||dirty} onClick={()=>void setHome()}>{homeId===draft.id?"当前文件夹首页":"关联为文件夹首页"}</RareButton>:null}
      <RareButton type="button" tone="ghost" onClick={()=>void showHistory()}>历史</RareButton> {canEdit?<RareButton type="button" tone="ghost" disabled={!dirty||busy||saving||Boolean(conflictServer)} onClick={()=>void save()}>立即保存</RareButton>:null}
      {canEdit?<RareButton type="button" tone="danger" disabled={busy} onClick={()=>void archive()}>归档</RareButton>:null}
     </div></div>
     <RareInput className="kn-title" aria-label="页面标题" autoFocus={draft.title==="无标题"} value={draft.title} readOnly={!canEdit} onChange={e=>setDraft({...draft,title:e.target.value})}/>
     {history!==null?<section className="kn-history" aria-label="页面修订历史"><strong>修订记录（只读）</strong>
      {!history.length?<p className="kn-muted">还没有修订记录</p>:history.map(v=><details key={v.revision}>
       <summary>v{v.revision} · {v.title} · {new Date(v.recordedAt).toLocaleString()}</summary>
       <p className="kn-muted">编辑人：{v.editorId}</p>{v.blocks.map(b=><p key={b.id}>{b.text}</p>)}
      </details>)}</section>:null}
     <div className="kn-blocks">{draft.blocks.map((b,i)=><div className={"kn-block kn-block-"+b.type} key={b.id} data-kn-block={b.id} draggable={canEdit}
       onDragStart={e=>{if(canEdit)e.dataTransfer.setData("application/x-knowledge-block",String(i))}}
       onDragOver={e=>{if(canEdit&&e.dataTransfer.types.includes("application/x-knowledge-block"))e.preventDefault()}}
       onDrop={e=>{if(!canEdit||!draft)return;const from=Number(e.dataTransfer.getData("application/x-knowledge-block"));if(Number.isInteger(from)&&from>=0&&from<draft.blocks.length){e.preventDefault();setDraft({...draft,blocks:reorder(draft.blocks,from,i)})}}}>
      {canEdit?<div className="kn-block-tools">
       <RareSelect aria-label="块类型" value={b.type} onChange={e=>editBlock(i,{type:e.target.value as Kind})}>{kinds.map((kind,j)=><option key={kind} value={kind}>{labels[j]}</option>)}</RareSelect>
       <RareButton type="button" aria-label="上移" disabled={i===0} onClick={()=>setDraft({...draft,blocks:reorder(draft.blocks,i,i-1)})}>↑</RareButton>
       <RareButton type="button" aria-label="下移" disabled={i===draft.blocks.length-1} onClick={()=>setDraft({...draft,blocks:reorder(draft.blocks,i,i+1)})}>↓</RareButton>
       <RareButton type="button" aria-label="移除" onClick={()=>setDraft({...draft,blocks:draft.blocks.filter((_,j)=>i!==j)})}>×</RareButton>
      </div>:null}
      <div className="kn-block-content">{b.type==="todo"?<RareInput type="checkbox" checked={Boolean(b.checked)} disabled={!canEdit} onChange={e=>editBlock(i,{checked:e.target.checked})}/>:null}
       {b.type==="bullet"?<span aria-hidden="true">•</span>:null}
       <RareTextarea rows={b.type==="paragraph"?2:1} aria-label={labels[kinds.indexOf(b.type)]} readOnly={!canEdit}
        placeholder={i===0?"输入内容，按 / 选择块类型…":"输入内容…"} value={b.text}
        onChange={e=>editBlock(i,{text:e.target.value})}
        onKeyDown={e=>{
         if(!canEdit||e.nativeEvent.isComposing)return;
         if((e.metaKey||e.ctrlKey)&&e.altKey&&["1","2","0"].includes(e.key)){
          e.preventDefault();
          selectBlockKind(i,e.key==="1"?"heading1":e.key==="2"?"heading2":"paragraph");
          return;
         }
         if(e.key==="Escape"&&slashBlock===b.id){e.preventDefault();setSlashBlock(null);return;}
         if(e.key==="/"&&!b.text&&slashBlock!==b.id){e.preventDefault();setSlashBlock(b.id);return;}
         if(!e.shiftKey&&!e.altKey&&!e.ctrlKey&&!e.metaKey&&e.currentTarget.selectionStart===e.currentTarget.selectionEnd){
          if(e.key==="ArrowUp"&&e.currentTarget.selectionStart===0&&i>0){
           const previous=draft.blocks[i-1];
           if(previous){e.preventDefault();focusBlock(previous.id,true);return;}
          }
          if(e.key==="ArrowDown"&&e.currentTarget.selectionEnd===b.text.length&&i<draft.blocks.length-1){
           const next=draft.blocks[i+1];
           if(next){e.preventDefault();focusBlock(next.id);return;}
          }
         }
         if(e.key==="Backspace"&&!b.text&&i>0){
          e.preventDefault();setSlashBlock(null);
          const prev=draft.blocks[i-1];
          if(!prev)return;
          setDraft({...draft,blocks:draft.blocks.filter((_,j)=>i!==j)});
          focusBlock(prev.id,true);
          return;
         }
         if(e.key==="Backspace"&&!b.text&&i===0&&b.type!=="paragraph"){
          e.preventDefault();selectBlockKind(i,"paragraph");return;
         }
         if(e.key==="Enter"&&!e.shiftKey&&!e.ctrlKey&&!e.metaKey&&!e.altKey){
          e.preventDefault();setSlashBlock(null);
          if(!b.text&&b.type!=="paragraph"){
           editBlock(i,{type:"paragraph",checked:false});return;
          }
          const caret=e.currentTarget.selectionStart??b.text.length;
          const left=b.text.slice(0,caret),right=b.text.slice(e.currentTarget.selectionEnd??caret);
          const nextType:Kind=b.type==="bullet"||b.type==="todo"?b.type:"paragraph";
          const nextBlock={...fresh(),type:nextType,text:right,checked:false};
          const next=[...draft.blocks];next.splice(i,1,{...b,text:left});
          next.splice(i+1,0,nextBlock);setDraft({...draft,blocks:next});
          focusBlock(nextBlock.id);
         }
        }}/>
      </div>
      {slashBlock===b.id&&canEdit?<div className="kn-slash-menu" role="group" aria-label="选择内容块类型">
       <div className="kn-slash-title">添加内容块</div>
       {kinds.map((type,j)=><RareButton key={type} type="button" tone="ghost"
        onClick={()=>selectBlockKind(i,type)}>{labels[j]}</RareButton>)}
      </div>:null}
     </div>)}</div>
     {canEdit?<RareButton className="kn-add" type="button" tone="ghost" onClick={()=>setDraft({...draft,blocks:[...draft.blocks,fresh()]})}>＋ 添加内容块</RareButton>:null}
     <section className="kn-files"><strong>文件引用</strong>
      {(draft.files||[]).map(f=><div key={f.fileId}><Link to={"/preview/"+enc(f.fileId)}>{f.fileName}</Link>
       {canEdit?<RareButton type="button" tone="ghost" onClick={()=>void fileLink(f.fileId,true)}>解除引用</RareButton>:null}</div>)}
      {attachFile&&canEdit?<RareButton type="button" tone="primary" disabled={busy} onClick={()=>void fileLink(attachFile)}>引用从预览选择的文件</RareButton>:null}
      <p className="kn-muted">引用是双向关联，不复制文件、不修改文件的受控状态。</p>
     </section>
    </article>:!createParent&&!fileId?<div className="kn-empty">
      <span className="kn-empty-icon" aria-hidden="true">▤</span>
      <h2>知识页面</h2>
      <p>从左侧页面树中选择页面，或点击「私人页面」旁的＋创建新页面。</p>
     </div>:null}
   </main>
  </div>
 </div>;
 return embedded ? content : <AppShell user={user} onLogout={onLogout}>{content}</AppShell>;
}
function reorder(items:Block[],from:number,to:number):Block[]{const next=[...items];const [moved]=next.splice(from,1);if(!moved)return items;next.splice(to,0,moved);return next;}
