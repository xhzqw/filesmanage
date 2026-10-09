import {useEffect,useState,type FormEvent} from "react";
import type {Folder} from "../../entities/folder/model";
import type {User} from "../../entities/user/model";
import {request} from "../../shared/http";
import {folderApi,type Grant} from "./api";
import {errorCopy} from "../../shared/errors";
import {Dialog} from "../../shared/ui/Dialog";

const ACTION_LABELS:Record<string,string>={
 list:"查看列表",
 preview:"预览",
 upload:"上传/新建",
 download:"下载",
 modify:"修改",
 delete:"删除",
 rename:"重命名",
 move:"移动",
 print:"打印",
};

const ACTION_KEYS=Object.keys(ACTION_LABELS);

type GroupRow={id:string;name:string};

// Retained for the page's existing call site only: the dialog loads the real
// per-kind data sources itself and never reads this list (AUD-08).
type Subject={id:string;displayName:string;login?:string};

// The subject picker loads GET /users and GET /groups through the shared JSON
// client (cross-feature imports would break the layer gate); the server stays
// the final authority on expiry and on who may actually be granted.
export function GrantDialog({folder,onClose,subjects}:{folder:Folder;onClose:()=>void;subjects?:Subject[]}){
 const[grants,setGrants]=useState<Grant[]>([]);
 const[subjectKind,setSubjectKind]=useState<"user"|"group">("user");
 const[subjectId,setSubjectId]=useState("");
 const[actions,setActions]=useState<string[]>(["list"]);
 const[scopeOnly,setScopeOnly]=useState(false);
 const[expiresAt,setExpiresAt]=useState("");
 const[users,setUsers]=useState<User[]>([]);
 const[groups,setGroups]=useState<GroupRow[]>([]);
 const[subjectsState,setSubjectsState]=useState<"loading"|"ready"|"failed">("loading");
 const[reloadToken,setReloadToken]=useState(0);
 const[message,setMessage]=useState("");
 const[messageTone,setMessageTone]=useState<"info"|"error">("info");
 // The grant held here waits for an explicit confirmation; every write shares
 // the single `busy` flag so the form and the revocation cannot overlap.
 const[pendingRevoke,setPendingRevoke]=useState<Grant|null>(null);
 const[revokeMessage,setRevokeMessage]=useState("");
 const[busy,setBusy]=useState(false);

 // One notice channel: failures keep the error styling while a completed
 // revocation reports success in the same place.
 function say(text:string,tone:"info"|"error"="info"){
  setMessage(text);
  setMessageTone(tone);
 }

 useEffect(()=>{
  let valid=true;
  folderApi.grants(folder.id)
   .then(data=>{if(valid)setGrants(data);})
   .catch(()=>{if(valid)say("读取授权列表失败","error");});
  return()=>{valid=false;};
 },[folder.id]);

 // Both lists load together so switching the kind always offers real ids from
 // the matching endpoint instead of reusing the other kind's list.
 useEffect(()=>{
  let valid=true;
  setSubjectsState("loading");
  Promise.all([request<User[]>("/users"),request<GroupRow[]>("/groups")])
   .then(([userRows,groupRows])=>{
    if(!valid)return;
    setUsers(userRows);
    setGroups(groupRows);
    setSubjectsState("ready");
   })
   .catch(()=>{if(valid)setSubjectsState("failed");});
  return()=>{valid=false;};
 },[reloadToken]);

 // Disabled accounts are not offered for new grants; the grants list still
 // resolves display names from the unfiltered roster.
 const candidates=subjectKind==="user"
  ?users.filter(u=>!u.disabled).map(u=>({id:u.id,label:userLabel(u)}))
  :groups.map(g=>({id:g.id,label:g.name}));
 const kindLabel=subjectKind==="user"?"用户":"工作组";

 // Display-only name lookup: an unknown subject falls back to its raw id, and
 // no permission is derived from this.
 function subjectName(kind:"user"|"group",id:string):string{
  if(kind==="user"){
   const user=users.find(u=>u.id===id);
   return user?userLabel(user):id;
  }
  const group=groups.find(g=>g.id===id);
  return group?group.name:id;
 }

 async function submit(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(subjectId===""||actions.length===0||busy)return;
  // The client only refuses a timestamp that is already past; whether a grant
  // is still valid stays a server decision.
  const expiresMs=expiresAt===""?null:Date.parse(expiresAt);
  if(expiresMs!==null&&(Number.isNaN(expiresMs)||expiresMs<=Date.now())){
   say("到期时间必须晚于当前时间","error");
   return;
  }
  say("");setBusy(true);
  // RFC3339 UTC on the wire; the handler parses with time.RFC3339.
  const expiresISO=expiresMs===null?undefined:new Date(expiresMs).toISOString();
  try{
   await folderApi.createGrant(folder.id,subjectKind,subjectId,actions,scopeOnly,expiresISO);
   const refreshed=await folderApi.grants(folder.id);
   setGrants(refreshed);
   setSubjectId("");
   setExpiresAt("");
  }catch(error){
   say(errorCopy(error,"授权失败"),"error");
  }finally{setBusy(false);}
 }

 // Called only by the confirmation step: the revocation commits first and the
 // list is then re-read from the server. A failed re-read must not be reported
 // as a failed revocation, so the two outcomes are reported separately.
 async function confirmRevoke(){
  const grant=pendingRevoke;
  if(!grant||busy)return;
  setRevokeMessage("");setBusy(true);
  try{
   await folderApi.revokeGrant(grant.id);
  }catch(error){
   setRevokeMessage(errorCopy(error,"撤销失败"));
   setBusy(false);
   return;
  }
  setPendingRevoke(null);
  setGrants(prev=>prev.filter(g=>g.id!==grant.id));
  say("已撤销该授权记录");
  try{
   setGrants(await folderApi.grants(folder.id));
  }catch{
   say("授权已撤销，但列表刷新失败，请重新打开本对话框查看最新授权。","error");
  }finally{setBusy(false);}
 }

 // Escape unwinds only the confirmation step; the grant list stays reachable.
 // The confirmation is an in-dialog step, not a second dialog, so the host
 // keeps the single focus trap (DESKTOP-INTERACTION-v1 §4.1, VIS-11).
 return <Dialog open title={pendingRevoke?"撤销授权确认":`目录授权 — ${folder.name}`}
  onClose={()=>{if(pendingRevoke)setPendingRevoke(null);else onClose();}} closeGuard={()=>!busy}
  initialFocus={pendingRevoke?"#revoke-cancel":undefined} className="dialog grant-dialog">
  {pendingRevoke?<form onSubmit={event=>{event.preventDefault();confirmRevoke();}}>
   <p className="hint">撤销后该条直接授权将被删除；继承授权与最终生效能力由服务端重新判定，本对话框不重新计算。</p>
   <p>目录：{folder.name}</p>
   <p>主体：{pendingRevoke.subjectKind==="user"?"用户":"工作组"} {subjectName(pendingRevoke.subjectKind,pendingRevoke.subjectId)}</p>
   <p>移除的动作：{pendingRevoke.actions.map(a=>ACTION_LABELS[a]??a).join("、")}</p>
   <p>范围：{pendingRevoke.scopeOnly?"仅本目录":"本目录及子目录（以服务端判定为准）"}{pendingRevoke.expiresAt?`；原到期 ${new Date(pendingRevoke.expiresAt).toLocaleString("zh-CN")}`:""}</p>
   {revokeMessage&&<p role="alert" className="notice error">{revokeMessage}</p>}
   <div className="dialog-actions">
    <button type="button" id="revoke-cancel" className="secondary-action" onClick={()=>setPendingRevoke(null)} disabled={busy}>取消</button>
    <button type="submit" className="danger" disabled={busy}>{busy?"撤销中…":"确认撤销"}</button>
   </div>
  </form>:<form onSubmit={submit}>
   <p className="hint">下列为直接授权记录；继承授权与最终生效能力由服务端判定，本对话框不重新计算。</p>
   <div className="grant-existing">
    {grants.length===0&&<p className="hint">当前没有显式授权（管理员不受限）。</p>}
    {grants.map(g=><div key={g.id} className="grant-row">
     <span>{g.subjectKind==="user"?"用户":"工作组"} {subjectName(g.subjectKind,g.subjectId)}</span>
     <span>{g.actions.map(a=>ACTION_LABELS[a]??a).join("、")}{g.scopeOnly?"（仅本目录）":""}{g.expiresAt?`；到期 ${new Date(g.expiresAt).toLocaleString("zh-CN")}`:""}</span>
     <button type="button" className="danger" disabled={busy} onClick={()=>{setRevokeMessage("");setPendingRevoke(g);}}>撤销</button>
    </div>)}
   </div>
   <div className="grant-form">
    <label htmlFor="subject-kind">主体类型</label>
    <select id="subject-kind" value={subjectKind} onChange={e=>{setSubjectKind(e.target.value as "user"|"group");setSubjectId("");}} disabled={busy||subjectsState!=="ready"}>
     <option value="user">用户</option>
     <option value="group">工作组</option>
    </select>
    <label htmlFor="subject-id">主体</label>
    <select id="subject-id" value={subjectId} onChange={e=>setSubjectId(e.target.value)} required disabled={busy||subjectsState!=="ready"}>
     <option value="">请选择</option>
     {candidates.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}
    </select>
    {subjectsState==="loading"&&<p className="hint">正在读取用户与工作组…</p>}
    {subjectsState==="ready"&&candidates.length===0&&<p className="hint">没有可选择的{kindLabel}。</p>}
    {subjectsState==="failed"&&<>
     <p role="alert" className="notice error">获取用户/工作组列表失败，无法选择授权主体。</p>
     <button type="button" className="secondary-action" onClick={()=>setReloadToken(token=>token+1)} disabled={busy}>重试</button>
    </>}
    <label htmlFor="grant-expires">到期时间（可选）</label>
    <input id="grant-expires" type="datetime-local" value={expiresAt} onChange={e=>setExpiresAt(e.target.value)} disabled={busy}/>
    <p className="hint">留空表示不设到期时间；所填时间按本机时区解释，是否过期以服务端判定为准。</p>
    <fieldset>
     <legend>动作</legend>
     {ACTION_KEYS.map(key=><label key={key} className="checkbox-label">
      <input type="checkbox" checked={actions.includes(key)} disabled={busy}
       onChange={e=>setActions(prev=>e.target.checked?[...prev,key]:prev.filter(a=>a!==key))}/>
      {ACTION_LABELS[key]}
     </label>)}
    </fieldset>
    <label className="checkbox-label">
     <input type="checkbox" checked={scopeOnly} onChange={e=>setScopeOnly(e.target.checked)} disabled={busy}/>
     仅本目录（不向子目录继承）
    </label>
   </div>
   {message&&<p role={messageTone==="error"?"alert":"status"} className={"notice"+(messageTone==="error"?" error":"")}>{message}</p>}
   <div className="dialog-actions">
    <button type="button" className="secondary-action" onClick={onClose} disabled={busy}>关闭</button>
    <button type="submit" className="primary" disabled={busy||subjectsState!=="ready"||subjectId===""||actions.length===0}>{busy?"提交中…":"添加授权"}</button>
   </div>
  </form>}
 </Dialog>;
}

function userLabel(user:User):string{
 return user.displayName+(user.login?`（${user.login}）`:"");
}
