import {useEffect,useMemo,useRef,useState,type FormEvent,type ReactNode} from "react";
import {Link,useSearchParams} from "react-router-dom";
import type {User} from "../../entities/user/model";
import {errorCode,errorCopy} from "../../shared/errors";
import {Dialog} from "../../shared/ui/Dialog";
import {permissionsApi,type DirectGrant,type FolderPage,type ResourceFolder} from "./permissionsApi";
import {PermissionAudit,PermissionInsights} from "./PermissionInsights";
import "./permissions.css";

type Group={id:string;name:string};
type LoadState="loading"|"ready"|"failed";
const ACTIONS=[
 ["list","查看列表"],["preview","预览"],["upload","上传/新建"],
 ["download","下载"],["modify","修改"],["delete","删除"],
 ["rename","重命名"],["move","移动"],["print","打印"],
] as const;
const LABELS=new Map<string,string>(ACTIONS.map(([key,label]):[string,string]=>[key,label]));
const HIGHRISK=new Set(["download","modify","delete","move"]);
const EMPTY_PAGE:FolderPage={items:[],nextCursor:""};

// Directory resource tree, not the department hierarchy. Every expansion and
// search is a keyset page from the server, not a browser-side full-tree query.
function ResourceBrowser({selected,onSelect}:{selected:string;onSelect:(folder:ResourceFolder)=>void}){
 const [pages,setPages]=useState<Record<string,FolderPage>>({});
 const [loading,setLoading]=useState<Record<string,boolean>>({"":true});
 const [errors,setErrors]=useState<Record<string,string>>({});
 const [expanded,setExpanded]=useState<Set<string>>(()=>new Set());
 const [query,setQuery]=useState("");
 const [searchPage,setSearchPage]=useState<FolderPage>(EMPTY_PAGE);
 const [searchState,setSearchState]=useState<LoadState>("ready");
 const [searchError,setSearchError]=useState("");
 const [moreSearch,setMoreSearch]=useState(false);
 const busyParents=useRef(new Set<string>());
 const searchRef=useRef(0);
 const requestSerial=useRef<Record<string,number>>({});

 async function load(parentId:string,cursor=""){
  if(busyParents.current.has(parentId))return;
  busyParents.current.add(parentId);
  const generation=(requestSerial.current[parentId]??0)+1;
  requestSerial.current[parentId]=generation;
  setLoading(old=>({...old,[parentId]:true}));
  setErrors(old=>({...old,[parentId]:""}));
  try{
   const page=await permissionsApi.children(parentId,cursor);
   if(requestSerial.current[parentId]!==generation)return;
   setPages(old=>({...old,[parentId]:cursor
    ?{items:[...(old[parentId]?.items??[]),...page.items],nextCursor:page.nextCursor}
    :page}));
  }catch(e){
   if(requestSerial.current[parentId]===generation)setErrors(old=>({...old,[parentId]:errorCopy(e,"目录读取失败")}));
  }finally{
   busyParents.current.delete(parentId);
   if(requestSerial.current[parentId]===generation)setLoading(old=>({...old,[parentId]:false}));
  }
 }
 useEffect(()=>{void load("");},[]);
 const needle=query.trim();
 useEffect(()=>{
  const serial=++searchRef.current;
  if(!needle){setSearchPage(EMPTY_PAGE);setSearchState("ready");return;}
  setSearchState("loading");
  const timer=window.setTimeout(()=>{
   permissionsApi.search(needle).then(page=>{
    if(serial===searchRef.current){setSearchPage(page);setSearchState("ready");}
   }).catch(e=>{
    if(serial===searchRef.current){setSearchError(errorCopy(e,"搜索失败"));setSearchState("failed");}
   });
  },250);
  return()=>window.clearTimeout(timer);
 },[needle]);
 async function loadMoreSearch(){
  if(!searchPage.nextCursor||moreSearch)return;
  const serial=searchRef.current;
  setMoreSearch(true);
  try{
   const page=await permissionsApi.search(needle,searchPage.nextCursor);
   if(serial===searchRef.current)setSearchPage(old=>({items:[...old.items,...page.items],nextCursor:page.nextCursor}));
  }catch(e){if(serial===searchRef.current){setSearchError(errorCopy(e,"加载更多结果失败"));setSearchState("failed");}}
  finally{setMoreSearch(false);}
 }
 function toggle(folder:ResourceFolder){
  if(!folder.hasChildren)return;
  if(expanded.has(folder.id))setExpanded(old=>{const next=new Set(old);next.delete(folder.id);return next;});
  else{
   setExpanded(old=>new Set(old).add(folder.id));
   if(!pages[folder.id])void load(folder.id);
  }
 }
 function rows(parent:string,depth:number,ancestors:Set<string>):ReactNode{
  if(depth>32)return null;
  return (pages[parent]?.items??[]).map(folder=>{
   if(ancestors.has(folder.id))return null;
   const open=expanded.has(folder.id);
   const nextAncestors=new Set(ancestors).add(folder.id);
   return <li key={folder.id}>
    <div className={"perm-tree-row"+(selected===folder.id?" selected":"")} style={{paddingLeft:depth*14+6}}>
     {folder.hasChildren?<button type="button" className="perm-tree-toggle" aria-expanded={open}
      aria-label={(open?"折叠":"展开")+folder.name} onClick={()=>toggle(folder)}>{open?"▾":"▸"}</button>
      :<span className="perm-tree-spacer" aria-hidden="true"/>}
     <button type="button" className="perm-tree-name" aria-current={selected===folder.id?"true":undefined}
      onClick={()=>onSelect(folder)} title={folder.name}>{folder.name}</button>
    </div>
    {open&&<>
     {loading[folder.id]&&<p className="hint perm-tree-info">正在读取…</p>}
     {errors[folder.id]&&<p role="alert" className="perm-tree-info">{errors[folder.id]} <button type="button" onClick={()=>void load(folder.id)}>重试</button></p>}
     <ul>{rows(folder.id,depth+1,nextAncestors)}</ul>
     {pages[folder.id]?.nextCursor&&<button type="button" className="perm-more" disabled={loading[folder.id]}
      onClick={()=>void load(folder.id,pages[folder.id]?.nextCursor??"")}>加载更多</button>}
    </>}
   </li>;
  });
 }
 return <aside className="perm-browser" aria-label="资源目录">
  <div className="perm-browser-title">资源目录 <button type="button" className="secondary-action" onClick={()=>void load("")}>刷新</button></div>
  <label className="perm-browser-search">按名称搜索目录<input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="查找资源目录"/></label>
  <div className="perm-browser-scroll">
   {needle?<>
    {searchState==="loading"&&<p className="hint">正在搜索…</p>}
    {searchState==="failed"&&<p role="alert" className="notice error">{searchError}</p>}
    {searchState==="ready"&&searchPage.items.length===0&&<p className="hint">没有匹配的目录</p>}
    {searchState==="ready"&&searchPage.items.map(f=><button type="button" key={f.id} className="perm-result" onClick={()=>onSelect(f)}>
     <span>{f.name}</span><small>{f.path||"资源目录"}</small></button>)}
    {searchState==="ready"&&searchPage.nextCursor&&<button type="button" className="perm-more" disabled={moreSearch} onClick={()=>void loadMoreSearch()}>加载更多结果</button>}
   </>:<>
    {loading[""]&&<p className="hint">正在读取资源目录…</p>}
    {errors[""]&&<p role="alert" className="notice error">{errors[""]} <button type="button" onClick={()=>void load("")}>重试</button></p>}
    {pages[""]?.items.length===0&&<p className="hint">没有目录</p>}
    <ul className="perm-tree">{rows("",0,new Set())}</ul>
    {pages[""]?.nextCursor&&<button type="button" className="perm-more" disabled={loading[""]}
     onClick={()=>void load("",pages[""]?.nextCursor??"")}>加载更多根目录</button>}
   </>}
  </div>
 </aside>;
}

export function PermissionsPanel({users,groups,usersState,groupsState,onRetryUsers,onRetryGroups}:{
 users:User[];groups:Group[];usersState:LoadState;groupsState:LoadState;
 onRetryUsers:()=>void;onRetryGroups:()=>void;
}){
 const [params,setParams]=useSearchParams();
 const folderId=params.get("folder")??"";
 const auditView=params.get("view")==="audit";
 const currentFolderRef=useRef(folderId);
 currentFolderRef.current=folderId;
 const [selectedName,setSelectedName]=useState<{id:string;name:string}|null>(null);
 const [grants,setGrants]=useState<DirectGrant[]>([]);
 const [state,setState]=useState<LoadState>("ready");
 const [refresh,setRefresh]=useState(0);
 const [notice,setNotice]=useState<{text:string;error:boolean}|null>(null);
 const [subjectKind,setSubjectKind]=useState<"user"|"group">("group");
 const [subjectId,setSubjectId]=useState("");
 const [subjectQuery,setSubjectQuery]=useState("");
 const [actions,setActions]=useState<string[]>(["list"]);
 const [scopeOnly,setScopeOnly]=useState(true);
 const [expiresAt,setExpiresAt]=useState("");
 const [submitState,setSubmitState]=useState<"edit"|"review"|"saving">("edit");
 const [reviewFolderId,setReviewFolderId]=useState("");
 const [revokeTarget,setRevokeTarget]=useState<DirectGrant|null>(null);
 const [revokeBusy,setRevokeBusy]=useState(false);
 const [revokeError,setRevokeError]=useState("");

 // URL navigation is independent of ResourceBrowser selection (back/forward,
 // deep links). Never reuse a confirmation or grant subject across resources.
 useEffect(()=>{
  setSubmitState("edit");setReviewFolderId("");
  setSubjectId("");setActions(["list"]);setScopeOnly(true);setExpiresAt("");
  setRevokeTarget(null);setRevokeError("");
 },[folderId]);

 useEffect(()=>{
  if(!folderId){setGrants([]);setState("ready");return;}
  let live=true;
  setState("loading");
  permissionsApi.grants(folderId).then(data=>{if(live){setGrants(data);setState("ready");}})
   .catch(e=>{if(live){setGrants([]);setState("failed");setNotice({text:errorCopy(e,"读取授权失败"),error:true});}});
  return()=>{live=false;};
 },[folderId,refresh]);
 const candidates=useMemo(()=>{
  const q=subjectQuery.trim().toLowerCase();
  const rows=subjectKind==="user"
   ?users.filter(u=>!u.disabled).map(u=>({id:u.id,name:u.displayName+(u.login?`（${u.login}）`:"")}))
   :groups.map(g=>({id:g.id,name:g.name}));
  return rows.filter(r=>!q||r.name.toLowerCase().includes(q)).slice(0,50);
 },[users,groups,subjectKind,subjectQuery]);
 const names=useMemo(()=>{
  const out=new Map<string,string>();
  users.forEach(u=>out.set("user:"+u.id,u.displayName));
  groups.forEach(g=>out.set("group:"+g.id,g.name));
  return out;
 },[users,groups]);
 const subjectSourceState=subjectKind==="user"?usersState:groupsState;
 const displayActions=(xs:string[])=>xs.map(x=>LABELS.get(x)??x).join("、");
 const reload=()=>setRefresh(x=>x+1);
 function selectFolder(folder:ResourceFolder){
  setSelectedName({id:folder.id,name:folder.path||folder.name});
  setParams(old=>{const next=new URLSearchParams(old);next.set("tab","permissions");next.set("view","folder");next.set("folder",folder.id);return next;});
  setSubmitState("edit");setRevokeTarget(null);setNotice(null);
 }
 async function submit(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(!folderId||!subjectId||!actions.length||submitState==="saving"||subjectSourceState!=="ready")return;
  if(submitState!=="review"){setReviewFolderId(folderId);setSubmitState("review");return;}
  if(reviewFolderId!==folderId){setSubmitState("edit");return;}
  const parsed=expiresAt?Date.parse(expiresAt):null;
  if(parsed!==null&&(!Number.isFinite(parsed)||parsed<=Date.now())){
   setNotice({text:"到期时间必须晚于当前时间",error:true});return;
  }
  setSubmitState("saving");setNotice(null);
  try{
   await permissionsApi.create(folderId,{subjectKind,subjectId,actions,scopeOnly,
    ...(parsed!==null?{expiresAt:new Date(parsed).toISOString()}:{})});
   if(currentFolderRef.current!==folderId)return;
   setNotice({text:"直接授权已提交，请以刷新后的服务端记录为准。",error:false});
   setSubjectId("");setExpiresAt("");setActions(["list"]);setScopeOnly(true);
   reload();
  }catch(e){
   if(currentFolderRef.current!==folderId)return;
   setNotice({text:errorCode(e)==="E_NETWORK"
    ?"网络中断，提交结果未知。请刷新列表核实，避免重复授权。"
    :errorCopy(e,"授权失败"),error:true});
  }finally{if(currentFolderRef.current===folderId)setSubmitState("edit");}
 }
 async function revoke(){
  if(!revokeTarget||revokeBusy)return;
  const revokeFolder=folderId;
  setRevokeBusy(true);setRevokeError("");
  try{
   await permissionsApi.revoke(revokeTarget.id);
   if(currentFolderRef.current!==revokeFolder)return;
   setRevokeTarget(null);setNotice({text:"直接授权已撤销，已重新读取服务端记录。",error:false});reload();
  }catch(e){
   if(currentFolderRef.current!==revokeFolder)return;
   setRevokeError(errorCode(e)==="E_NETWORK"
    ?"网络中断，撤销结果未知。关闭弹窗并刷新授权后确认。"
    :errorCopy(e,"撤销失败"));
  }finally{setRevokeBusy(false);}
 }
 return <div className="perm-content-root">
  <nav className="perm-subnav" aria-label="权限管理功能">
   <button type="button" className={!auditView?"active":""} aria-current={!auditView?"page":undefined}
    onClick={()=>setParams(old=>{const next=new URLSearchParams(old);next.set("view","folder");return next;})}>目录授权与有效权限</button>
   <button type="button" className={auditView?"active":""} aria-current={auditView?"page":undefined}
    onClick={()=>{setRevokeTarget(null);setParams(old=>{const next=new URLSearchParams(old);next.set("view","audit");return next;});}}>权限变更审计</button>
  </nav>
  {auditView?<PermissionAudit users={users}/>:<div className="perm-workspace">
  <ResourceBrowser selected={folderId} onSelect={selectFolder}/>
  <section className="perm-detail" aria-label="目录权限">
   {!folderId?<div className="empty">请选择左侧资源目录，查看或配置直接授权。</div>:<>
    <div className="perm-detail-heading">
     <div><strong>目录权限</strong><span className="perm-path" title={folderId}>{selectedName?.id===folderId?selectedName.name:folderId}</span></div>
     <div><Link to={"/doc?folder="+encodeURIComponent(folderId)}>返回文档目录</Link> <button type="button" className="secondary-action" onClick={reload}>刷新授权</button></div>
    </div>
    <div className="perm-section-title">直接授权记录</div>
    <p className="perm-hint">显示的仅是当前目录直接 ACL；继承与共享可能仍赋予相同动作，不代表最终有效权限。</p>
    {notice&&<p role={notice.error?"alert":"status"} className={"notice"+(notice.error?" error":"")}>{notice.text}</p>}
    {state==="loading"&&<p role="status" className="hint">正在读取直接授权…</p>}
    {state==="failed"&&<p className="notice error" role="alert">读取失败，不能编辑该目录的授权。</p>}
    {state==="ready"&&<div className="perm-grants-scroller"><table className="perm-table"><thead><tr><th>授权主体</th><th>动作</th><th>范围</th><th>到期</th><th>操作</th></tr></thead>
     <tbody>{grants.map(g=><tr key={g.id}><td>{names.get(g.subjectKind+":"+g.subjectId)??g.subjectId}<small>{g.subjectKind==="user"?"用户":"工作组"}</small></td>
      <td>{displayActions(g.actions)}</td><td>{g.scopeOnly?"仅当前目录":"包括子目录"}</td>
      <td>{g.expiresAt?new Date(g.expiresAt).toLocaleString("zh-CN"):"不过期"}</td>
      <td><button type="button" className="danger" onClick={()=>{setRevokeError("");setRevokeTarget(g);}}>撤销</button></td></tr>)}</tbody></table>
     {grants.length===0&&<p className="empty">没有直接授权；可能仍存在父目录继承或共享权限。</p>}
    </div>}
    <PermissionInsights folderId={folderId} users={users} usersState={usersState}/>
    <div className="perm-section-title">新增直接授权</div>
    <form className="perm-form" onSubmit={submit} onChange={()=>{if(submitState==="review")setSubmitState("edit");}}>
     {usersState==="failed"&&<p role="alert" className="notice error">读取用户列表失败。<button type="button" className="secondary-action" onClick={onRetryUsers}>重试用户列表</button></p>}
     {groupsState==="failed"&&<p role="alert" className="notice error">读取工作组列表失败。<button type="button" className="secondary-action" onClick={onRetryGroups}>重试工作组列表</button></p>}
     {subjectSourceState==="loading"&&<p role="status" className="hint">正在读取可授权主体…</p>}
     <div className="perm-form-row">
      <label>主体类型<select value={subjectKind} onChange={e=>{setSubjectKind(e.target.value as "user"|"group");setSubjectId("");}}>
       <option value="group">工作组</option><option value="user">用户</option></select></label>
      <label>查找主体<input type="search" value={subjectQuery} onChange={e=>{setSubjectQuery(e.target.value);setSubjectId("");}} placeholder="按名称或账号筛选"/></label>
      <label>授权给<select value={subjectId} required disabled={subjectSourceState!=="ready"} onChange={e=>setSubjectId(e.target.value)}>
       <option value="">请选择</option>{candidates.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
     </div>
     <fieldset><legend>允许执行的文件动作</legend><div className="perm-action-grid">
      {ACTIONS.map(([key,label])=><label key={key}><input type="checkbox" checked={actions.includes(key)}
       onChange={e=>setActions(old=>e.target.checked?[...old,key]:old.filter(x=>x!==key))}/>{label}</label>)}
     </div></fieldset>
     <div className="perm-form-row">
      <label>生效范围<select value={scopeOnly?"only":"subtree"} onChange={e=>setScopeOnly(e.target.value==="only")}>
       <option value="only">仅当前目录（默认）</option><option value="subtree">包括全部子目录</option></select></label>
      <label>到期时间（可选）<input type="datetime-local" value={expiresAt} onChange={e=>setExpiresAt(e.target.value)}/></label>
     </div>
     {submitState==="review"&&<div className="perm-review" role="status">
      <strong>请核对授权摘要</strong><p>主体：{names.get(subjectKind+":"+subjectId)??subjectId}；动作：{displayActions(actions)}</p>
      <p>范围：{scopeOnly?"仅当前目录":"当前及全部子目录"}；到期：{expiresAt||"不过期"}</p>
      {actions.some(a=>HIGHRISK.has(a))&&<p>含下载、修改、删除或移动等高影响动作，请确认授权对象及范围。</p>}
     </div>}
     <div className="perm-form-actions"><span className="hint">授权效果以服务端判定为准。</span>
      {submitState==="review"&&<button type="button" className="secondary-action" onClick={()=>setSubmitState("edit")}>返回修改</button>}
      <button type="submit" className="primary" disabled={submitState==="saving"||!subjectId||!actions.length||state!=="ready"||subjectSourceState!=="ready"}>
       {submitState==="saving"?"提交中…":submitState==="review"?"确认添加授权":"预览授权"}</button>
     </div>
    </form>
   </>}
  </section>
  </div>}
  <Dialog open={revokeTarget!==null} title="撤销直接授权" onClose={()=>{if(!revokeBusy)setRevokeTarget(null);}} closeGuard={()=>!revokeBusy} className="dialog">
   {revokeTarget&&<>
    <p>确定撤销 {names.get(revokeTarget.subjectKind+":"+revokeTarget.subjectId)??revokeTarget.subjectId} 的「{displayActions(revokeTarget.actions)}」直接授权？</p>
    <p className="hint">只撤销这一条记录。工作组、父目录及共享仍可能赋予相同权限。</p>
    {revokeError&&<p role="alert" className="notice error">{revokeError}</p>}
    <div className="dialog-actions"><button type="button" className="secondary-action" disabled={revokeBusy} onClick={()=>setRevokeTarget(null)}>取消</button>
     <button type="button" className="danger" disabled={revokeBusy} onClick={()=>void revoke()}>{revokeBusy?"撤销中…":"确认撤销"}</button></div>
   </>}
  </Dialog>
 </div>;
}
