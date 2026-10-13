import {GooeyNav,RareBadge,RareButton,RareDataTable,RareInput,RareNotice,RareRowActions,RareSelect,RareTabs} from "../../shared/ui/rare";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {toast} from "../../shared/ui/feedback";
import {observeWorkspaceChange} from "../../shared/resourceSync";
import {useEffect,useMemo,useRef,useState,type FormEvent} from "react";
import {Link,useSearchParams} from "react-router-dom";
import type {User} from "../../entities/user/model";
import {errorCode,errorCopy} from "../../shared/errors";
import {Dialog} from "../../shared/ui/Dialog";
import {permissionsApi,type DirectGrant,type ResourceFolder} from "./permissionsApi";
import {ResourceBrowser} from "./ResourceBrowser";
import {PermissionAudit,PermissionInsights} from "./PermissionInsights";
import {DocumentActivityPanel} from "./DocumentActivityPanel";
import "./permissions.css";
import {PERMISSION_ACTIONS} from "./permissionActions";
import {DirectGrantForm} from "./DirectGrantForm";

type Group={id:string;name:string};
type LoadState="loading"|"ready"|"failed";
const LABELS=new Map<string,string>(PERMISSION_ACTIONS.map(([key,label]):[string,string]=>[key,label]));
const HIGHRISK=new Set(["download","modify","delete","move"]);

export function PermissionsPanel({users,groups,usersState,groupsState,onRetryUsers,onRetryGroups,onDirtyChange,requestNavigation}:{
 users:User[];groups:Group[];usersState:LoadState;groupsState:LoadState;
 onRetryUsers:()=>void;onRetryGroups:()=>void;
 onDirtyChange:(dirty:boolean)=>void;requestNavigation:(navigate:()=>void)=>void;
}){
 const [params,setParams]=useSearchParams();
 const folderId=params.get("folder")??"";
 const auditView=params.get("view")==="audit";
 const documentAuditView=params.get("view")==="document-audit";
 const currentFolderRef=useRef(folderId);
 currentFolderRef.current=folderId;
 const [selectedName,setSelectedName]=useState<{id:string;name:string}|null>(null);
 const [grants,setGrants]=useState<DirectGrant[]>([]);
 const [state,setState]=useState<LoadState>("ready");
 const [refresh,setRefresh]=useState(0);
 useEffect(()=>observeWorkspaceChange(()=>setRefresh(n=>n+1),["permissions","folder"]),[]);
 const [notice,setNotice]=useState<{text:string;error:boolean}|null>(null);
 const [mode,setMode]=useState<"list"|"effective"|"create">("list");
 const [grantQuery,setGrantQuery]=useState("");

 const [subjectKind,setSubjectKind]=useState<"user"|"group">("group");
 const [subjectId,setSubjectId]=useState("");
 const [actions,setActions]=useState<string[]>(["list"]);
 const [scopeOnly,setScopeOnly]=useState(true);
 const [expiresAt,setExpiresAt]=useState("");
 const [submitState,setSubmitState]=useState<"edit"|"review"|"saving">("edit");
 const [reviewFolderId,setReviewFolderId]=useState("");
 const [riskAcknowledged,setRiskAcknowledged]=useState(false);
 const [revokeTarget,setRevokeTarget]=useState<DirectGrant|null>(null);
 const [revokeBusy,setRevokeBusy]=useState(false);
 const [revokeError,setRevokeError]=useState("");
 const dirty=!!folderId&&(subjectKind!=="group"||subjectId!==""||
  actions.length!==1||actions[0]!=="list"||!scopeOnly||expiresAt!==""||submitState==="review");
 useEffect(()=>onDirtyChange(dirty),[dirty,onDirtyChange]);
 useEffect(()=>()=>onDirtyChange(false),[onDirtyChange]);

 // URL navigation is independent of ResourceBrowser selection (back/forward,
 // deep links). Never reuse a confirmation or grant subject across resources.
 useEffect(()=>{
  setSubmitState("edit");setReviewFolderId("");setRiskAcknowledged(false);
  setSubjectId("");setActions(["list"]);setScopeOnly(true);setExpiresAt("");
  setRevokeTarget(null);setRevokeError("");setMode("list");setGrantQuery("");
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
  return subjectKind==="user"
   ?users.filter(u=>!u.disabled).map(u=>({id:u.id,name:u.displayName+(u.login?`（${u.login}）`:"")}))
   :groups.map(g=>({id:g.id,name:g.name}));
 },[users,groups,subjectKind]);
 const visibleGrants=useMemo(()=>{
  const q=grantQuery.trim().toLocaleLowerCase("zh-CN");
  if(!q)return grants;
  const lookup=new Map([...users.map(u=>["user:"+u.id,u.displayName+(u.login??"")] as const),
   ...groups.map(g=>["group:"+g.id,g.name] as const)]);
  return grants.filter(g=>(lookup.get(g.subjectKind+":"+g.subjectId)??g.subjectId).toLocaleLowerCase("zh-CN").includes(q));
 },[grants,grantQuery,users,groups]);
 const names=useMemo(()=>{
  const out=new Map<string,string>();
  users.forEach(u=>out.set("user:"+u.id,u.displayName));
  groups.forEach(g=>out.set("group:"+g.id,g.name));
  return out;
 },[users,groups]);
 const subjectSourceState=subjectKind==="user"?usersState:groupsState;
 const riskyActions=actions.filter(action=>HIGHRISK.has(action));
 const needsRiskConsent=riskyActions.length>0;
 const displayActions=(xs:string[])=>xs.map(x=>LABELS.get(x)??x).join("、");
 const reload=()=>setRefresh(x=>x+1);
 function selectFolder(folder:ResourceFolder){
  if(folder.id===folderId)return;
  requestNavigation(()=>{
   setSelectedName({id:folder.id,name:folder.path||folder.name});
   setParams(old=>{
    // The root browser may finish auto-selecting just as the user switches to
    // an audit view. Its stale callback must not pull the user back here.
    if(old.get("view")==="audit"||old.get("view")==="document-audit")return old;
    const next=new URLSearchParams(old);next.set("tab","permissions");next.set("view","folder");next.set("folder",folder.id);return next;
   });
   setSubmitState("edit");setRiskAcknowledged(false);setRevokeTarget(null);setNotice(null);setMode("list");
  });
 }
 async function submit(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(!folderId||!subjectId||!actions.length||submitState==="saving"||state!=="ready"||subjectSourceState!=="ready")return;
  if(submitState!=="review"){
   setReviewFolderId(folderId);setRiskAcknowledged(false);setSubmitState("review");return;
  }
  if(reviewFolderId!==folderId){setSubmitState("edit");return;}
  if(needsRiskConsent&&!riskAcknowledged)return;
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
   setSubjectKind("group");setSubjectId("");setExpiresAt("");setActions(["list"]);setScopeOnly(true);
   reload();setMode("list");
   toast.success("直接授权已提交，请以刷新后的服务端记录为准");
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
   toast.success("直接授权已撤销");
  }catch(e){
   if(currentFolderRef.current!==revokeFolder)return;
   setRevokeError(errorCode(e)==="E_NETWORK"
    ?"网络中断，撤销结果未知。关闭弹窗并刷新授权后确认。"
    :errorCopy(e,"撤销失败"));
  }finally{setRevokeBusy(false);}
 }
 return <div className="perm-content-root">
  <div className="perm-subnav">
   <GooeyNav className="perm-view-nav" aria-label="权限管理功能" size="sm" separation={12} radius={8}
    items={["资源授权","权限变更审计","文档活动审计"]}
    value={auditView?1:documentAuditView?2:0}
    activeColor="var(--brand-blue)" activeLabelColor="var(--text-inverse)"
    onChange={index=>requestNavigation(()=>{
     if(index!==0)setRevokeTarget(null);
     setParams(old=>{const next=new URLSearchParams(old);
      next.set("view",index===0?"folder":index===1?"audit":"document-audit");return next;});
    })}/>
  </div>
  {documentAuditView?<DocumentActivityPanel/>:auditView?<PermissionAudit users={users}/>:<div className="perm-workspace">
  <ResourceBrowser selected={folderId} onSelect={selectFolder}/>
  <section className="perm-detail" aria-label="目录权限">
   {!folderId?<div className="perm-empty-state"><strong>选择左侧目录开始管理权限</strong></div>:<>
    <div className="perm-detail-heading">
     <div className="perm-heading-copy"><h2 className="perm-path" title={selectedName?.id===folderId?selectedName.name:folderId}>{selectedName?.id===folderId?selectedName.name:folderId}</h2></div>
     <div className="perm-heading-actions"><Link to={"/doc?folder="+encodeURIComponent(folderId)}>在文档中打开</Link>
      <RareButton type="button" className="secondary-action" onClick={reload}>刷新授权</RareButton></div>
    </div>
    <div className="perm-manage-toolbar">
     <RareTabs className="perm-manage-tabs" label="目录权限视图">
      <RareButton type="button" role="tab" tabIndex={mode!=="effective"?0:-1} aria-selected={mode==="list"}
       aria-controls="perm-list-panel" className={mode==="list"?"active":""}
       onClick={()=>setMode("list")}>授权列表 <RareBadge tone="neutral">{grants.length}</RareBadge></RareButton>
      <RareButton type="button" role="tab" tabIndex={mode==="effective"?0:-1} aria-selected={mode==="effective"}
       aria-controls="perm-effective-panel" className={mode==="effective"?"active":""}
       onClick={()=>requestNavigation(()=>setMode("effective"))}>生效权限</RareButton>
     </RareTabs>
     <RareButton type="button" className="primary perm-create-trigger" tone={mode==="create"?"ghost":"primary"}
      onClick={()=>mode==="create"?requestNavigation(()=>setMode("list")):setMode("create")}>
      {mode==="create"?"返回授权列表":"新增授权"}</RareButton>
    </div>
    <div className="perm-view-body">
     {mode==="effective"&&<div id="perm-effective-panel" role="tabpanel" aria-label="生效权限" className="perm-mode-panel"><PermissionInsights folderId={folderId} users={users} usersState={usersState} refreshToken={refresh}/></div>}
     {mode==="list"&&<section id="perm-list-panel" role="tabpanel" className="perm-card perm-overview" aria-label="直接授权记录">
      {grants.length>0&&<div className="perm-list-filter">
       <span className="perm-list-heading">直接授权</span>
       <RareInput type="search" className="perm-grant-search" aria-label="筛选授权用户或工作组" placeholder="搜索用户或工作组"
        value={grantQuery} onChange={event=>setGrantQuery(event.target.value)}/>
      </div>}
      {notice?.error&&<RareNotice tone="danger">{notice.text}</RareNotice>}
      {state==="loading"&&<p role="status" className="hint perm-list-hint"><BrandLoadingLabel>正在读取授权…</BrandLoadingLabel></p>}
      {state==="failed"&&<RareNotice tone="danger">读取授权失败，无法管理当前目录。<RareButton type="button" onClick={reload}>重试</RareButton></RareNotice>}
      {state==="ready"&&<div className="perm-grants-scroller">{visibleGrants.length
       ?<RareDataTable className="perm-table perm-grants-table"><thead><tr><th>授权对象</th><th>允许的操作</th><th>适用范围</th><th>有效期</th><th>操作</th></tr></thead>
       <tbody>{visibleGrants.map(g=><tr key={g.id}>
        <td className="perm-grant-subject"><strong>{names.get(g.subjectKind+":"+g.subjectId)??g.subjectId}</strong>
         <small>{g.subjectKind==="user"?"用户":"工作组"}</small></td>
        <td><div className="perm-grant-tags">{g.actions.map(action=><RareBadge key={action} tone="neutral">{LABELS.get(action)??action}</RareBadge>)}</div></td>
        <td><RareBadge tone={g.scopeOnly?"neutral":"info"}>{g.scopeOnly?"本目录":"包含子目录"}</RareBadge></td>
        <td className="rare-data-date">{g.expiresAt?new Date(g.expiresAt).toLocaleDateString("zh-CN"):"长期有效"}</td>
        <td><RareRowActions><RareButton type="button" className="danger" tone="danger"
         onClick={()=>{setRevokeError("");setRevokeTarget(g);}}>撤销</RareButton></RareRowActions></td>
       </tr>)}</tbody></RareDataTable>
       :<div className="perm-empty-grants"><strong>{grantQuery?"没有匹配的授权":"暂无直接授权"}</strong></div>}
      </div>}
     </section>}
     {mode==="create"&&<div className="perm-create-view">
      {notice?.error&&<RareNotice tone={notice.text.includes("结果未知")?"warning":"danger"}>{notice.text}</RareNotice>}
      <div className="perm-create-heading"><strong>新增直接授权</strong></div>
      <DirectGrantForm folderName={selectedName?.id===folderId?selectedName.name:folderId}
       usersState={usersState} groupsState={groupsState} onRetryUsers={onRetryUsers} onRetryGroups={onRetryGroups}
       subjectKind={subjectKind} setSubjectKind={setSubjectKind} subjectId={subjectId} setSubjectId={setSubjectId}
       actions={actions} setActions={setActions} scopeOnly={scopeOnly} setScopeOnly={setScopeOnly}
       expiresAt={expiresAt} setExpiresAt={setExpiresAt} submitState={submitState} setSubmitState={setSubmitState}
       riskAcknowledged={riskAcknowledged} setRiskAcknowledged={setRiskAcknowledged}
       subjectSourceState={subjectSourceState} candidates={candidates} names={names}
       riskyActions={riskyActions} needsRiskConsent={needsRiskConsent} displayActions={displayActions}
       grantLoadState={state} onSubmit={submit}/>
     </div>}
    </div>
   </>}
  </section>
  </div>}
  <Dialog open={revokeTarget!==null} title="撤销直接授权" onClose={()=>{if(!revokeBusy)setRevokeTarget(null);}} closeGuard={()=>!revokeBusy} className="dialog">
   {revokeTarget&&<>
    <p>确定撤销 {names.get(revokeTarget.subjectKind+":"+revokeTarget.subjectId)??revokeTarget.subjectId} 的「{displayActions(revokeTarget.actions)}」直接授权？</p>
    <p className="hint">只撤销这一条记录。工作组、父目录及共享仍可能赋予相同权限。</p>
    {revokeError&&<RareNotice tone={revokeError.includes("结果未知")?"warning":"danger"}>{revokeError}</RareNotice>}
    <div className="dialog-actions"><RareButton type="button" className="secondary-action" disabled={revokeBusy} onClick={()=>setRevokeTarget(null)}>取消</RareButton>
     <RareButton type="button" tone="danger" className="danger" loading={revokeBusy} onClick={()=>void revoke()}>{revokeBusy?"撤销中…":"确认撤销"}</RareButton></div>
   </>}
  </Dialog>
 </div>;
}
