import {RareButton,RareInput} from "../../shared/ui/rare";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {useEffect,useMemo,useState,type FormEvent} from "react";
import {collaborationApi,type Workgroup} from "./api";
import {errorCode,errorCopy} from "../../shared/errors";
import {Dialog} from "../../shared/ui/Dialog";
import type {User} from "../../entities/user/model";
import "./share.css";

export type ShareResource={kind:"file"|"folder";id:string;name:string};

// Share actions are the passive subset the server accepts (SPEC §2.4): the
// repository rejects anything outside this vocabulary as E_BAD, so the wizard
// never offers upload/modify/delete/rename/move/print.
const SHARE_ACTIONS:Record<string,string>={
 list:"查看列表",
 preview:"预览",
 download:"下载",
};

const SHARE_ACTION_KEYS=["list","preview","download"];

// Bounded page over the loaded recipient list; the remainder stays reachable by
// narrowing the search box instead of rendering an unbounded list.
const RECIPIENT_PAGE=40;

// Share-creation wizard (COMPLEX-WORKFLOWS-v1 §9 "分享", WF-21). The resource is
// chosen by the host before the dialog opens; here the user picks a real user or
// workgroup, the passive action set, folder inheritance and an optional expiry.
// The server re-validates the recipient, the actions, the expiry and the
// caller's rights on the resource — this dialog only prepares the request, and
// every rejection keeps the form open for a corrected retry.
export function ShareDialog({resource,onClose,onCreated}:{
 resource:ShareResource;
 onClose:()=>void;
 onCreated:()=>void;
}){
 const[recipientKind,setRecipientKind]=useState<"user"|"group">("user");
 const[recipientId,setRecipientId]=useState("");
 const[query,setQuery]=useState("");
 const[users,setUsers]=useState<User[]>([]);
 const[groups,setGroups]=useState<Workgroup[]>([]);
 const[recipients,setRecipients]=useState<"loading"|"ready"|"denied"|"failed">("loading");
 const[recipientToken,setRecipientToken]=useState(0);
 // Default to the least privilege that still makes the resource usable: a file
 // needs preview, a folder needs list so the recipient can enter it.
 const[actions,setActions]=useState<string[]>(resource.kind==="file"?["preview"]:["list","preview"]);
 const[includeDescendants,setIncludeDescendants]=useState(resource.kind==="folder");
 const[expiresLocal,setExpiresLocal]=useState("");
 const[busy,setBusy]=useState(false);
 const[message,setMessage]=useState("");

 // Both recipient lists are real server data. /users and /groups are admin-only,
 // so a denied read is reported as such instead of showing an empty picker.
 useEffect(()=>{
  let valid=true;
  setRecipients("loading");
  Promise.all([collaborationApi.users(),collaborationApi.groups()])
   .then(([loadedUsers,loadedGroups])=>{
    if(!valid)return;
    setUsers(loadedUsers.filter(user=>user.disabled!==true));
    setGroups(loadedGroups);
    setRecipients("ready");
   })
   .catch(error=>{
    if(!valid)return;
    setRecipients(errorCode(error)==="E_FORBIDDEN"?"denied":"failed");
   });
  return()=>{valid=false;};
 },[recipientToken]);

 const candidates=useMemo(()=>{
  const keyword=query.trim().toLowerCase();
  if(recipientKind==="user"){
   return users
    .filter(user=>keyword===""||user.displayName.toLowerCase().includes(keyword)||(user.login??"").toLowerCase().includes(keyword))
    .map(user=>({id:user.id,name:user.displayName,detail:user.login??""}));
  }
  return groups
   .filter(group=>keyword===""||group.name.toLowerCase().includes(keyword))
   .map(group=>({id:group.id,name:group.name,detail:""}));
 },[groups,query,recipientKind,users]);
 const shown=candidates.slice(0,RECIPIENT_PAGE);

 // The submitted id is resolved against the list of the selected kind, so a
 // stale id from the other kind can never be sent as this one.
 const selectedUser=recipientKind==="user"?users.find(user=>user.id===recipientId):undefined;
 const selectedGroup=recipientKind==="group"?groups.find(group=>group.id===recipientId):undefined;
 const recipientName=selectedUser?selectedUser.displayName:(selectedGroup?.name??"");
 const recipientOk=selectedUser!==undefined||selectedGroup!==undefined;

 // datetime-local carries no offset, so it is read as local time; the wire
 // format is the RFC3339 instant the server parses. An empty value means no
 // expiry at all, which is not the same as an invalid one.
 const expiresAt=expiresLocal===""?null:new Date(expiresLocal);
 const expiryError=expiresAt===null
  ?""
  :Number.isNaN(expiresAt.getTime())
   ?"有效期格式无效，请重新选择。"
   :expiresAt.getTime()<=Date.now()
    ?"有效期必须晚于当前时间。"
    :"";

 const canSubmit=recipients==="ready"&&recipientOk&&actions.length>0&&expiryError===""&&!busy;

 function submit(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(!canSubmit)return;
  const body:{resourceKind:string;resourceId:string;recipientKind:string;recipientId:string;actions:string[];includeDescendants:boolean;expiresAt?:string}={
   resourceKind:resource.kind,
   resourceId:resource.id,
   recipientKind,
   recipientId,
   // Canonical order regardless of the click order the boxes were toggled in.
   actions:SHARE_ACTION_KEYS.filter(key=>actions.includes(key)),
   includeDescendants:resource.kind==="folder"&&includeDescendants,
  };
  if(expiresAt)body.expiresAt=expiresAt.toISOString();
  setBusy(true);setMessage("");
  collaborationApi.createShare(body)
   .then(()=>{onCreated();})
   .catch(error=>{
    // Stay open: a forbidden action set, a vanished resource or a rejected
    // recipient is fixed here, not by retrying the same request.
    setMessage(errorCode(error)==="E_BAD"
     ?"接收方或权限动作未被服务端接受，请调整后重试。"
     :errorCopy(error,"分享创建失败，请重试"));
   })
   .finally(()=>{setBusy(false);});
 }

 return <Dialog open title={`创建分享 — ${resource.name}`} onClose={onClose}
  closeGuard={()=>!busy} initialFocus="#share-recipient-search" className="share-dialog">
  <form onSubmit={submit}>
   <p className="hint">资源：{resource.kind==="file"?"文件":"目录"}「{resource.name}」。分享只传递查看列表/预览/下载，不含写操作；服务端保留最终授权判定。</p>
   <fieldset className="share-fieldset">
    <legend>接收方类型</legend>
    <div className="share-kind-switch" role="group" aria-label="接收方类型">
     <RareButton type="button" className={recipientKind==="user"?"on":""} aria-pressed={recipientKind==="user"}
      disabled={busy} onClick={()=>{setRecipientKind("user");setRecipientId("");}}>用户</RareButton>
     <RareButton type="button" className={recipientKind==="group"?"on":""} aria-pressed={recipientKind==="group"}
      disabled={busy} onClick={()=>{setRecipientKind("group");setRecipientId("");}}>工作组</RareButton>
    </div>
   </fieldset>
   {recipients==="loading"&&<p className="hint"><BrandLoadingLabel>正在读取接收方…</BrandLoadingLabel></p>}
   {recipients==="denied"&&<p role="alert" className="notice error">当前账号无法读取用户/工作组列表（服务端仅对管理员开放），暂时不能选择接收方。</p>}
   {recipients==="failed"&&<>
    <p role="alert" className="notice error">接收方列表加载失败。</p>
    <RareButton type="button" className="secondary-action" disabled={busy} onClick={()=>setRecipientToken(token=>token+1)}>重试</RareButton>
   </>}
   {recipients==="ready"&&<>
    <label htmlFor="share-recipient-search">接收方（{recipientKind==="user"?"用户":"工作组"}）</label>
    <RareInput id="share-recipient-search" type="search" value={query} placeholder="按姓名或账号筛选"
     autoComplete="off" disabled={busy} onChange={event=>setQuery(event.target.value)}
     onKeyDown={event=>{
      if(event.key!=="Enter")return;
      // Enter picks the first visible candidate; it never submits the form, so
      // no share is created from a keystroke in the filter box.
      event.preventDefault();
      const first=shown[0];
      if(first)setRecipientId(first.id);
     }}/>
    <div role="radiogroup" aria-label={"选择"+(recipientKind==="user"?"用户":"工作组")} className="share-recipient-list">
     {shown.length===0&&<p className="share-list-empty">没有匹配的接收方。</p>}
     {shown.map(item=><RareButton key={item.id} type="button" role="radio" aria-checked={recipientId===item.id}
      className={"share-option"+(recipientId===item.id?" on":"")} disabled={busy}
      onClick={()=>setRecipientId(item.id)}>
      <span className="share-option-kind">{recipientKind==="user"?"用户":"工作组"}</span>
      <span className="share-option-name">{item.name}</span>
      {item.detail!==""&&<span className="share-option-detail">{item.detail}</span>}
     </RareButton>)}
    </div>
    {candidates.length>shown.length&&<p className="hint">匹配 {candidates.length} 条，仅显示前 {RECIPIENT_PAGE} 条，请继续输入以缩小范围。</p>}
   </>}
   <fieldset className="share-fieldset">
    <legend>权限动作</legend>
    <div className="share-actions">
     {SHARE_ACTION_KEYS.map(key=><label key={key} className="checkbox-label">
      <RareInput type="checkbox" checked={actions.includes(key)} disabled={busy}
       onChange={event=>setActions(prev=>event.target.checked?[...prev,key]:prev.filter(item=>item!==key))}/>
      {SHARE_ACTIONS[key]??key}
     </label>)}
    </div>
   </fieldset>
   {resource.kind==="folder"
    ?<label className="checkbox-label">
     <RareInput type="checkbox" checked={includeDescendants} disabled={busy}
      onChange={event=>setIncludeDescendants(event.target.checked)}/>
     继承到子目录
    </label>
    :<p className="hint">文件分享不涉及子目录继承。</p>}
   <label htmlFor="share-expiry">有效期（留空表示长期有效）</label>
   <RareInput id="share-expiry" type="datetime-local" value={expiresLocal} disabled={busy}
    onChange={event=>setExpiresLocal(event.target.value)}/>
   {expiryError!==""&&<p role="alert" className="notice error">{expiryError}</p>}
   {message&&<p role="alert" className="notice error">{message}</p>}
   {recipientOk&&<p className="hint">将分享给{recipientKind==="user"?"用户":"工作组"}「{recipientName}」。</p>}
   <div className="dialog-actions">
    <RareButton type="button" className="secondary-action" onClick={onClose} disabled={busy}>取消</RareButton>
    <RareButton type="submit" className="primary" loading={busy} disabled={!canSubmit}>创建分享</RareButton>
   </div>
  </form>
 </Dialog>;
}
