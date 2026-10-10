import {RareButton,RareInput,RareSelect} from "../../shared/ui/rare";
import {useEffect,useState,type FormEvent} from "react";
import {workflowApi} from "./api";
import {errorCopy} from "../../shared/errors";
import {Dialog} from "../../shared/ui/Dialog";
import type {Folder} from "../../entities/folder/model";
import "./policyDialog.css";

export type Approver={id:string;displayName:string;login?:string};

// Admin-only approval policy configuration for one folder. The approver list
// is supplied by the composing page so this feature stays self-contained.
export function PolicyDialog({folder,approvers,onClose}:{folder:Folder;approvers:Approver[];onClose:()=>void}){
 const[chain,setChain]=useState<string[]>([""]);
 const[enabled,setEnabled]=useState(true);
 const[message,setMessage]=useState("");
 const[configured,setConfigured]=useState(false);
 const[busy,setBusy]=useState(false);

 useEffect(()=>{
  let valid=true;
  workflowApi.policy(folder.id)
   .then(policy=>{
    if(!valid)return;
    setConfigured(policy.configured);
    if(policy.approverIds?.length)setChain(policy.approverIds);else if(policy.approverId)setChain([policy.approverId]);
    if(policy.enabled!==undefined)setEnabled(policy.enabled);
   })
   .catch(()=>{if(valid)setMessage("读取策略失败（可能没有权限）");});
  return()=>{valid=false;};
 },[folder.id]);

 async function submit(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(chain.some(id=>!id)||new Set(chain).size!==chain.length||busy)return;
  setMessage("");setBusy(true);
  try{
   await workflowApi.setPolicy(folder.id,chain,enabled);
   setConfigured(true);
   setMessage("策略已保存");
  }catch(error){
   setMessage(errorCopy(error,"保存策略失败"));
  }finally{setBusy(false);}
 }

 async function clear(){
  if(busy)return;
  setMessage("");setBusy(true);
  try{
   await workflowApi.clearPolicy(folder.id);
   setConfigured(false);
   setMessage("策略已移除");
  }catch(error){
   setMessage(errorCopy(error,"移除策略失败"));
  }finally{setBusy(false);}
 }

 return <Dialog open title={`审批策略 — ${folder.name}`} onClose={onClose} closeGuard={()=>!busy} className="dialog">
  <form onSubmit={submit}>
   <p className="hint">启用后，该目录下文件的修改与回滚必须先经审批人同意才会生成新版本。</p>
   <div className="policy-chain-steps">
    {chain.map((id,index)=><div className="policy-chain-step" key={index}>
     <label htmlFor={"policy-approver-"+index}>第 {index+1} 级审批</label>
     <RareSelect id={"policy-approver-"+index} value={id} required disabled={busy}
      onChange={e=>setChain(list=>list.map((value,i)=>i===index?e.target.value:value))}>
      <option value="">请选择</option>
      {approvers.map(a=><option key={a.id} value={a.id}>{a.displayName}{a.login?`（${a.login}）`:""}</option>)}
     </RareSelect>
     {chain.length>1&&<RareButton type="button" disabled={busy} onClick={()=>setChain(list=>list.filter((_,i)=>i!==index))}>移除</RareButton>}
    </div>)}
    {chain.length<5&&<RareButton type="button" disabled={busy} onClick={()=>setChain(list=>[...list,""])}>添加一级</RareButton>}
   </div>
   <label className="checkbox-label">
    <RareInput type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)} disabled={busy}/>
    启用审批
   </label>
   {message&&<p role="alert" className="notice error">{message}</p>}
   <div className="dialog-actions">
    {configured&&<RareButton type="button" className="secondary-action" onClick={clear} disabled={busy}>移除策略</RareButton>}
    <RareButton type="button" className="secondary-action" onClick={onClose} disabled={busy}>关闭</RareButton>
    <RareButton type="submit" className="primary" disabled={busy||chain.some(id=>!id)||new Set(chain).size!==chain.length}>{busy?"保存中…":"保存策略"}</RareButton>
   </div>
  </form>
 </Dialog>;
}
