import {useEffect,useState} from "react";
import {RareBadge,RareButton} from "../../shared/ui/rare";
import {errorCopy} from "../../shared/errors";
import {sealsApi} from "./api";
import type {SealUserPermission} from "../../entities/seal/model";

export function SealPermissionMatrix(){
 const[users,setUsers]=useState<SealUserPermission[]>([]);
 const[busy,setBusy]=useState("");
 const[error,setError]=useState("");
 const[success,setSuccess]=useState("");
 const[retry,setRetry]=useState(0);
 useEffect(()=>{let live=true;sealsApi.permissions().then(v=>{if(live)setUsers(v);}).catch(err=>{if(live)setError(errorCopy(err,"签章权限加载失败"));});return()=>{live=false};},[retry]);
 async function toggle(user:SealUserPermission,field:"canSign"|"canStamp"){
  setBusy(user.userId);setError("");setSuccess("");
  try{
   const updated={...user,[field]:!user[field]};
   await sealsApi.updatePermission(user.userId,updated.canSign,updated.canStamp);
   setUsers(prev=>prev.map(item=>item.userId===user.userId?updated:item));
   setSuccess(user.displayName+"的"+(field==="canSign"?"个人签名":"公章使用")+"权限已更新");
  }catch(err){setError(errorCopy(err,"权限更新失败"));setRetry(n=>n+1);}finally{setBusy("")}
 }
 return <section className="seal-permission-matrix">
  {(error||success)&&<p role={error?"alert":"status"} className={error?"notice error":"notice"}>{error||success}</p>}
  <div className="seal-permission-head"><strong>签章使用权限</strong><RareButton type="button" onClick={()=>setRetry(i=>i+1)}>刷新</RareButton></div>
  <div className="seal-permission-grid" role="table" aria-label="用户签章权限">
   <div role="row" className="seal-permission-row seal-permission-header"><span role="columnheader">账号</span><span role="columnheader">个人签名</span><span role="columnheader">使用公章</span></div>
   {users.map(user=><div role="row" className="seal-permission-row" key={user.userId}>
    <strong role="cell">{user.displayName}</strong>
    <div role="cell"><RareButton type="button" aria-label={user.displayName+"个人签名权限"} aria-pressed={user.canSign} disabled={busy!==""} onClick={()=>void toggle(user,"canSign")}><RareBadge tone={user.canSign?"success":"neutral"}>{user.canSign?"允许签名":"禁止签名"}</RareBadge></RareButton></div>
    <div role="cell"><RareButton type="button" aria-label={user.displayName+"公章使用权限"} aria-pressed={user.canStamp} disabled={busy!==""} onClick={()=>void toggle(user,"canStamp")}><RareBadge tone={user.canStamp?"success":"neutral"}>{user.canStamp?"允许盖章":"禁止盖章"}</RareBadge></RareButton></div>
   </div>)}
  </div>
 </section>
}
