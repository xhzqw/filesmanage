import {useEffect,useRef,useState,type FormEvent} from "react";
import {useSearchParams} from "react-router-dom";
import type {User} from "../../entities/user/model";
import {approvalPolicyApi} from "../../entities/approval/api";
import {RareButton,RareInput,RareNotice,RareSelect} from "../../shared/ui/rare";
import {errorCode,errorCopy} from "../../shared/errors";
import {ResourceBrowser} from "./PermissionsPanel";
import type {ResourceFolder} from "./permissionsApi";
import "./approvalPolicies.css";

type LoadState="loading"|"ready"|"failed";
export function ApprovalPoliciesPanel({users,usersState,onRetryUsers}:{users:User[];usersState:LoadState;onRetryUsers:()=>void}){
 const [params,setParams]=useSearchParams();
 const folderId=params.get("folder")??"";
 const currentFolder=useRef(folderId);currentFolder.current=folderId;
 const [folderName,setFolderName]=useState<{id:string;name:string}|null>(null);
 const [status,setStatus]=useState<LoadState>("ready");
 const [refresh,setRefresh]=useState(0);
 const [approverId,setApproverId]=useState("");
 const [enabled,setEnabled]=useState(false);
 const [configured,setConfigured]=useState(false);
 const [busy,setBusy]=useState(false);
 const [confirmRemove,setConfirmRemove]=useState(false);
 const [notice,setNotice]=useState<{message:string;error:boolean}|null>(null);
 useEffect(()=>{
  setNotice(null);setConfirmRemove(false);setApproverId("");setEnabled(false);setConfigured(false);setBusy(false);
  if(!folderId){setStatus("ready");return;}
  let live=true;setStatus("loading");
  approvalPolicyApi.get(folderId).then(policy=>{
   if(!live)return;
   setConfigured(policy.configured);setApproverId(policy.approverId??"");
   setEnabled(policy.configured&&policy.enabled===true);setStatus("ready");
  }).catch(error=>{if(live){setStatus("failed");setNotice({message:errorCopy(error,"读取审批策略失败"),error:true});}});
  return()=>{live=false;};
 },[folderId,refresh]);
 function selectFolder(folder:ResourceFolder){
  setFolderName({id:folder.id,name:folder.path||folder.name});
  setParams(old=>{const next=new URLSearchParams(old);next.set("tab","approvals");next.set("folder",folder.id);next.delete("view");return next;});
 }
 async function save(event:FormEvent<HTMLFormElement>){
  event.preventDefault();if(!folderId||!approverId||busy||status!=="ready"||usersState!=="ready")return;
  setBusy(true);setNotice(null);setConfirmRemove(false);
  try{
   await approvalPolicyApi.set(folderId,approverId,enabled);
   if(currentFolder.current!==folderId)return;
   setConfigured(true);setNotice({message:"审批策略已保存",error:false});
  }catch(error){
   if(currentFolder.current===folderId)setNotice({message:errorCode(error)==="E_NETWORK"?"网络中断，请刷新确认策略是否生效":errorCopy(error,"保存失败"),error:true});
  }finally{if(currentFolder.current===folderId)setBusy(false);}
 }
 async function remove(){
  if(!folderId||busy||!configured||status!=="ready")return;
  setBusy(true);setNotice(null);
  try{
   await approvalPolicyApi.clear(folderId);
   if(currentFolder.current!==folderId)return;
   setConfigured(false);setEnabled(false);setApproverId("");setConfirmRemove(false);
   setNotice({message:"审批策略已移除",error:false});
  }catch(error){
   if(currentFolder.current===folderId)setNotice({message:errorCode(error)==="E_NETWORK"?"网络中断，请刷新确认策略是否仍存在":errorCopy(error,"移除失败"),error:true});
  }finally{if(currentFolder.current===folderId)setBusy(false);}
 }
 const approvers=users.filter(user=>!user.disabled);
 const missing=approverId!==""&&!approvers.some(user=>user.id===approverId);
 const locked=busy||status!=="ready"||usersState!=="ready";
 return <div className="perm-content-root approval-content">
  <div className="perm-workspace approval-workspace">
   <ResourceBrowser selected={folderId} onSelect={selectFolder}/>
   <section className="approval-detail" aria-label="目录审批策略">
    {!folderId?<div className="perm-empty-state"><strong>选择资源目录</strong></div>:<>
     <div className="approval-heading">
      <h2 title={folderName?.id===folderId?folderName.name:folderId}>{folderName?.id===folderId?folderName.name:folderId}</h2>
      {status==="ready"&&<span className="approval-state">{!configured?"未配置":enabled?"已启用":"已停用"}</span>}
     </div>
     <div className="approval-editor">
      {status==="loading"&&<p role="status" className="hint">正在读取审批策略…</p>}
      {notice&&<RareNotice tone={notice.error?"danger":"success"}>{notice.message}</RareNotice>}
      {status==="failed"&&<RareButton type="button" onClick={()=>setRefresh(n=>n+1)}>重新读取</RareButton>}
      {usersState==="failed"&&<RareNotice tone="danger">用户列表读取失败。<RareButton type="button" onClick={onRetryUsers}>重试</RareButton></RareNotice>}
      <form className="approval-form" onSubmit={save}>
       <label className="approval-field" htmlFor="approval-approver">审批人
        <RareSelect id="approval-approver" aria-label="审批人" searchable value={approverId} required disabled={locked}
         onChange={e=>{setApproverId(e.target.value);setNotice(null);setConfirmRemove(false);}}>
         <option value="">选择审批人</option>
         {missing&&<option value={approverId}>原审批人（已停用或不可用）</option>}
         {approvers.map(user=><option key={user.id} value={user.id}>{user.displayName}{user.login?`（${user.login}）`:""}</option>)}
        </RareSelect>
       </label>
       <label className="approval-toggle"><RareInput type="checkbox" checked={enabled} disabled={locked}
         onChange={e=>{setEnabled(e.target.checked);setNotice(null);setConfirmRemove(false);}}/><span>启用审批</span></label>
       <div className="approval-actions">
        {configured&&(!confirmRemove
         ?<RareButton type="button" className="secondary-action" disabled={locked} onClick={()=>setConfirmRemove(true)}>移除策略</RareButton>
         :<>
          <span className="approval-confirm-text">确认移除当前目录策略？</span>
          <RareButton type="button" onClick={()=>setConfirmRemove(false)} disabled={locked}>取消</RareButton>
          <RareButton type="button" className="danger" disabled={locked} onClick={()=>void remove()}>确定移除</RareButton>
         </>)}
        <RareButton type="submit" className="primary" disabled={locked||!approverId||missing}>{busy?"保存中…":"保存策略"}</RareButton>
       </div>
      </form>
     </div>
    </>}
   </section>
  </div>
 </div>;
}
