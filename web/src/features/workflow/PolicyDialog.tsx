import {useEffect,useState,type FormEvent} from "react";
import {workflowApi} from "./api";
import {errorCopy} from "../../shared/errors";
import type {Folder} from "../../entities/folder/model";

export type Approver={id:string;displayName:string;login?:string};

// Admin-only approval policy configuration for one folder. The approver list
// is supplied by the composing page so this feature stays self-contained.
export function PolicyDialog({folder,approvers,onClose}:{folder:Folder;approvers:Approver[];onClose:()=>void}){
 const[approverId,setApproverId]=useState("");
 const[enabled,setEnabled]=useState(true);
 const[message,setMessage]=useState("");
 const[configured,setConfigured]=useState(false);

 useEffect(()=>{
  let valid=true;
  workflowApi.policy(folder.id)
   .then(policy=>{
    if(!valid)return;
    setConfigured(policy.configured);
    if(policy.approverId)setApproverId(policy.approverId);
    if(policy.enabled!==undefined)setEnabled(policy.enabled);
   })
   .catch(()=>{if(valid)setMessage("读取策略失败（可能没有权限）");});
  return()=>{valid=false;};
 },[folder.id]);

 async function submit(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(approverId==="")return;
  setMessage("");
  try{
   await workflowApi.setPolicy(folder.id,approverId,enabled);
   setConfigured(true);
   setMessage("策略已保存");
  }catch(error){
   setMessage(errorCopy(error,"保存策略失败"));
  }
 }

 async function clear(){
  setMessage("");
  try{
   await workflowApi.clearPolicy(folder.id);
   setConfigured(false);
   setMessage("策略已移除");
  }catch(error){
   setMessage(errorCopy(error,"移除策略失败"));
  }
 }

 return <dialog open className="dialog">
  <form onSubmit={submit}>
   <h3>审批策略 — {folder.name}</h3>
   <p className="hint">启用后，该目录下文件的修改与回滚必须先经审批人同意才会生成新版本。</p>
   <label htmlFor="policy-approver">审批人</label>
   <select id="policy-approver" value={approverId} onChange={e=>setApproverId(e.target.value)} required>
    <option value="">请选择</option>
    {approvers.map(a=><option key={a.id} value={a.id}>{a.displayName}{a.login?`（${a.login}）`:""}</option>)}
   </select>
   <label className="checkbox-label">
    <input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/>
    启用审批
   </label>
   {message&&<p role="alert" className="notice error">{message}</p>}
   <div className="dialog-actions">
    {configured&&<button type="button" className="secondary-action" onClick={clear}>移除策略</button>}
    <button type="button" className="secondary-action" onClick={onClose}>关闭</button>
    <button type="submit" className="primary" disabled={approverId===""}>保存策略</button>
   </div>
  </form>
 </dialog>;
}
