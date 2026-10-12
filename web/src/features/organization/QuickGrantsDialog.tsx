import {useEffect,useMemo,useState,type FormEvent} from "react";
import {toast} from "../../shared/ui/feedback";
import type {Folder} from "../../entities/folder/model";
import type {User} from "../../entities/user/model";
import {RareButton,RareInput,RareNotice} from "../../shared/ui/rare";
import {Dialog} from "../../shared/ui/Dialog";
import {errorCode,errorCopy} from "../../shared/errors";
import {PermissionActionPicker} from "./PermissionActionPicker";
import {PERMISSION_ACTIONS,HIGH_RISK_PERMISSION_ACTIONS} from "./permissionActions";
import {PermissionGrantSubjectFields,PermissionGrantScopeFields} from "./PermissionGrantFields";
import {organizationApi,type Workgroup} from "./api";
import {permissionsApi,type DirectGrant} from "./permissionsApi";
import "./quickGrants.css";

const LABELS=new Map<string,string>(PERMISSION_ACTIONS.map(([key,label])=>[key,label]));
type LoadState="loading"|"ready"|"failed";
function actionLabels(keys:string[]){return keys.map(key=>LABELS.get(key)??key).join("、");}

export function QuickGrantsDialog({folder,onClose}:{folder:Folder;onClose:()=>void}){
 const [grants,setGrants]=useState<DirectGrant[]>([]);
 const [users,setUsers]=useState<User[]>([]);
 const [groups,setGroups]=useState<Workgroup[]>([]);
 const [grantsState,setGrantsState]=useState<LoadState>("loading");
 const [usersState,setUsersState]=useState<LoadState>("loading");
 const [groupsState,setGroupsState]=useState<LoadState>("loading");
 const [refreshKey,setRefreshKey]=useState(0);
 const [subjectsKey,setSubjectsKey]=useState(0);
 const [busy,setBusy]=useState(false);
 const [unknown,setUnknown]=useState(false);
 const [notice,setNotice]=useState<{text:string;error:boolean}|null>(null);
 const [kind,setKind]=useState<"user"|"group">("group");
 const [subject,setSubject]=useState("");
 const [actions,setActions]=useState<string[]>(["list"]);
 const [scopeOnly,setScopeOnly]=useState(true);
 const [expiresAt,setExpiresAt]=useState("");
 const [review,setReview]=useState(false);
 const [ack,setAck]=useState(false);
 const [revokeId,setRevokeId]=useState<string|null>(null);

 useEffect(()=>{
  let live=true;setGrantsState("loading");
  permissionsApi.grants(folder.id).then(data=>{if(live){setGrants(data);setGrantsState("ready");setUnknown(false);}})
   .catch(error=>{if(live){setGrantsState("failed");setNotice({text:errorCopy(error,"读取授权失败"),error:true});}});
  return()=>{live=false;};
 },[folder.id,refreshKey]);
 useEffect(()=>{
  let live=true;setUsersState("loading");setGroupsState("loading");
  organizationApi.users().then(data=>{if(live){setUsers(data);setUsersState("ready");}}).catch(()=>{if(live)setUsersState("failed");});
  organizationApi.groups().then(data=>{if(live){setGroups(data);setGroupsState("ready");}}).catch(()=>{if(live)setGroupsState("failed");});
  return()=>{live=false;};
 },[subjectsKey]);

 const names=useMemo(()=>new Map<string,string>([
  ...users.map(u=>["user:"+u.id,u.displayName] as const),
  ...groups.map(g=>["group:"+g.id,g.name] as const),
 ]),[users,groups]);
 const choices=kind==="user"
  ?users.filter(u=>!u.disabled).map(u=>({id:u.id,name:u.displayName+(u.login?`（${u.login}）`:"")}))
  :groups.map(g=>({id:g.id,name:g.name}));
 const subjectReady=kind==="user"?usersState==="ready":groupsState==="ready";
 const risk=actions.filter(a=>HIGH_RISK_PERMISSION_ACTIONS.has(a));
 const canSave=grantsState==="ready"&&subjectReady&&!!subject&&actions.length>0&&!unknown&&!busy;
 function edit(){setReview(false);setAck(false);setNotice(null);}
 function refresh(){setRevokeId(null);edit();setRefreshKey(n=>n+1);}
 async function submit(e:FormEvent<HTMLFormElement>){
  e.preventDefault();if(!canSave)return;
  const exp=expiresAt?Date.parse(expiresAt):null;
  if(exp!==null&&(!Number.isFinite(exp)||exp<=Date.now())){setNotice({text:"到期时间必须晚于当前时间",error:true});return;}
  if(!review){setReview(true);setAck(false);return;}
  if(risk.length&&!ack)return;
  setBusy(true);setNotice(null);
  try{
   await permissionsApi.create(folder.id,{subjectKind:kind,subjectId:subject,actions,scopeOnly,
    ...(exp!==null?{expiresAt:new Date(exp).toISOString()}:{})});
   setSubject("");setActions(["list"]);setScopeOnly(true);setExpiresAt("");setReview(false);setAck(false);
   setNotice({text:"授权已添加",error:false});setRefreshKey(n=>n+1);
   toast.success("授权已添加");
  }catch(error){
   const uncertain=errorCode(error)==="E_NETWORK";if(uncertain)setUnknown(true);
   setReview(false);setNotice({text:uncertain?"网络中断，结果未知，请刷新授权记录确认":errorCopy(error,"添加授权失败"),error:true});
  }finally{setBusy(false);}
 }
 async function revoke(grant:DirectGrant){
  if(busy||unknown||grantsState!=="ready")return;
  setBusy(true);setNotice(null);
  try{
   await permissionsApi.revoke(grant.id);setRevokeId(null);setNotice({text:"直接授权已撤销",error:false});setRefreshKey(n=>n+1);
   toast.success("直接授权已撤销");
  }catch(error){
   const uncertain=errorCode(error)==="E_NETWORK";if(uncertain)setUnknown(true);
   setNotice({text:uncertain?"网络中断，结果未知，请刷新授权记录确认":errorCopy(error,"撤销失败"),error:true});
  }finally{setBusy(false);}
 }
 return <Dialog open title={`快捷授权 · ${folder.name}`} onClose={onClose} closeGuard={()=>!busy}
  className="quick-grants-dialog" initialFocus=".quick-grants-fields .rare-select">
  <div className="quick-grants-body">
   <div className="quick-grants-section-heading">
    <strong>直接授权</strong>
    <div><RareButton type="button" className="secondary-action" onClick={refresh} disabled={busy}>刷新</RareButton>
     {grantsState==="ready"&&<span className="quick-grants-count">{grants.length} 条</span>}</div>
   </div>
   {notice?.error&&<RareNotice tone={unknown?"warning":"danger"}>{notice.text}</RareNotice>}
   {grantsState==="loading"&&<p role="status" className="hint">正在读取授权…</p>}
   {grantsState==="failed"&&<RareNotice tone="danger">读取失败，已暂停授权修改。请刷新重试。</RareNotice>}
   {grantsState==="ready"&&<div className="quick-grants-list">
    {grants.length===0?<p className="quick-grants-empty">暂无直接授权</p>:grants.map(grant=>
     <div className="quick-grants-record" key={grant.id}>
      <div className="quick-grants-record-text">
       <strong>{names.get(grant.subjectKind+":"+grant.subjectId)??grant.subjectId}</strong>
       <span>{grant.subjectKind==="user"?"用户":"工作组"} · {actionLabels(grant.actions)}</span>
       <small>{grant.scopeOnly?"仅当前目录":"包含子目录"} · {grant.expiresAt?new Date(grant.expiresAt).toLocaleString("zh-CN"):"不限期"}</small>
      </div>
      {revokeId===grant.id?<div className="quick-grants-row-actions">
       <span>确认撤销？</span>
       <RareButton type="button" disabled={busy} onClick={()=>setRevokeId(null)}>取消</RareButton>
       <RareButton type="button" tone="danger" className="danger" disabled={busy||unknown} onClick={()=>void revoke(grant)}>撤销</RareButton>
      </div>:<RareButton type="button" className="secondary-action" disabled={busy||unknown} onClick={()=>setRevokeId(grant.id)}>撤销</RareButton>}
     </div>)}
   </div>}
   <div className="quick-grants-section-heading"><strong>添加授权</strong></div>
   {(usersState==="failed"||groupsState==="failed")&&<div className="quick-grants-retry">
    <RareNotice tone="danger">授权对象加载不完整</RareNotice>
    <RareButton type="button" disabled={busy} onClick={()=>setSubjectsKey(n=>n+1)}>重试</RareButton>
   </div>}
   <form className="quick-grants-form" onSubmit={submit}>
    <PermissionGrantSubjectFields className="quick-grants-fields" kind={kind} subject={subject}
     candidates={choices} disabled={busy} subjectDisabled={!subjectReady}
     onKindChange={value=>{setKind(value);setSubject("");edit();}}
     onSubjectChange={value=>{setSubject(value);edit();}}/>
    <PermissionActionPicker options={PERMISSION_ACTIONS} value={actions} preset="basic" disabled={busy}
     className="quick-grants-fieldset" optionsClassName="quick-grants-actions-grid" toolbarClassName="quick-grants-action-toolbar"
     onChange={next=>{setActions(next);edit();}}/>
    <PermissionGrantScopeFields className="quick-grants-fields" scopeOnly={scopeOnly} expiresAt={expiresAt}
     disabled={busy} onScopeChange={value=>{setScopeOnly(value);edit();}}
     onExpiryChange={value=>{setExpiresAt(value);edit();}}/>
    {review&&<div className="quick-grants-review" role="status">
     <strong>确认授权</strong>
     <span>{folder.name} → {names.get(kind+":"+subject)??subject}</span>
     <span>{actionLabels(actions)} · {scopeOnly?"当前目录":"包含子目录"} · {expiresAt||"不限期"}</span>
     {!!risk.length&&<label className="quick-grants-consent">
      <RareInput type="checkbox" checked={ack} disabled={busy} onChange={e=>setAck(e.target.checked)}/>
      <span>确认授予高影响权限（{actionLabels(risk)}）</span></label>}
    </div>}
    <div className="quick-grants-footer">
     {review&&<RareButton type="button" disabled={busy} onClick={()=>setReview(false)}>返回修改</RareButton>}
     <RareButton type="submit" tone="primary" className="primary" loading={busy}
      disabled={!canSave||(review&&risk.length>0&&!ack)}>{busy?"保存中…":review?"确认添加":"添加授权"}</RareButton>
    </div>
   </form>
  </div>
 </Dialog>;
}
