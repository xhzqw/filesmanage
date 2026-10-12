import {useEffect,useRef,useState,type FormEvent} from "react";
import {observeWorkspaceChange} from "../../shared/resourceSync";
import {useSearchParams} from "react-router-dom";
import type {User} from "../../entities/user/model";
import {approvalPolicyApi} from "../../entities/approval/api";
import {RareButton,RareInput,RareNotice,RareSelect} from "../../shared/ui/rare";
import {errorCode,errorCopy} from "../../shared/errors";
import {ResourceBrowser} from "./PermissionsPanel";
import type {ResourceFolder} from "./permissionsApi";
import "./approvalPolicies.css";

type LoadState="loading"|"ready"|"failed";
export function ApprovalPoliciesPanel({users,usersState,onRetryUsers,onDirtyChange,requestNavigation}:{
 users:User[];usersState:LoadState;onRetryUsers:()=>void;
 onDirtyChange:(dirty:boolean)=>void;requestNavigation:(navigate:()=>void)=>void;
}){
 const [params,setParams]=useSearchParams();
 const folderId=params.get("folder")??"";
 const currentFolder=useRef(folderId);currentFolder.current=folderId;
 const [folderName,setFolderName]=useState<{id:string;name:string}|null>(null);
 const [status,setStatus]=useState<LoadState>("ready");
 const [refresh,setRefresh]=useState(0);
 const [approverIds,setApproverIds]=useState<string[]>([""]);
 const [enabled,setEnabled]=useState(false);
 const [configured,setConfigured]=useState(false);
 const [busy,setBusy]=useState(false);
 const [confirmRemove,setConfirmRemove]=useState(false);
 const [notice,setNotice]=useState<{message:string;error:boolean}|null>(null);
 const [saved,setSaved]=useState<{ids:string[];enabled:boolean}|null>(null);
 const dirty=!!folderId&&status==="ready"&&saved!==null&&
  (saved.enabled!==enabled||saved.ids.join("|")!==approverIds.join("|"));
 const dirtyRef=useRef(false);dirtyRef.current=dirty||busy;
 useEffect(()=>onDirtyChange(dirty),[dirty,onDirtyChange]);
 useEffect(()=>()=>onDirtyChange(false),[onDirtyChange]);
 useEffect(()=>observeWorkspaceChange(()=>{
  if(dirtyRef.current){
   setNotice({message:"检测到远端策略更新；请先保存或放弃当前修改，再重新读取。",error:true});
  }else setRefresh(n=>n+1);
 },["approval-policy","permissions"]),[]);
 useEffect(()=>{
  setNotice(null);setConfirmRemove(false);setApproverIds([""]);setEnabled(false);setConfigured(false);setSaved(null);setBusy(false);
  if(!folderId){setStatus("ready");return;}
  let live=true;setStatus("loading");
  approvalPolicyApi.get(folderId).then(policy=>{
   if(!live)return;
   const ids=policy.approverIds?.length?policy.approverIds:[policy.approverId??""];
   const currentEnabled=policy.configured&&policy.enabled===true;
   setConfigured(policy.configured);setApproverIds(ids);
   setEnabled(currentEnabled);setSaved({ids:[...ids],enabled:currentEnabled});setStatus("ready");
  }).catch(error=>{if(live){setStatus("failed");setNotice({message:errorCopy(error,"读取审批策略失败"),error:true});}});
  return()=>{live=false;};
 },[folderId,refresh]);
 function selectFolder(folder:ResourceFolder){
  if(folder.id===folderId)return;
  requestNavigation(()=>{
   setFolderName({id:folder.id,name:folder.path||folder.name});
   setParams(old=>{const next=new URLSearchParams(old);next.set("tab","approvals");next.set("folder",folder.id);next.delete("view");return next;});
  });
 }
 async function save(event:FormEvent<HTMLFormElement>){
  event.preventDefault();if(!folderId||approverIds.some(id=>!id)||new Set(approverIds).size!==approverIds.length||busy||status!=="ready"||usersState!=="ready")return;
  setBusy(true);setNotice(null);setConfirmRemove(false);
  try{
   await approvalPolicyApi.set(folderId,approverIds,enabled);
   if(currentFolder.current!==folderId)return;
   setConfigured(true);setSaved({ids:[...approverIds],enabled});setNotice({message:"审批策略已保存",error:false});
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
   setConfigured(false);setEnabled(false);setApproverIds([""]);setSaved({ids:[""],enabled:false});setConfirmRemove(false);
   setNotice({message:"审批策略已移除",error:false});
  }catch(error){
   if(currentFolder.current===folderId)setNotice({message:errorCode(error)==="E_NETWORK"?"网络中断，请刷新确认策略是否仍存在":errorCopy(error,"移除失败"),error:true});
  }finally{if(currentFolder.current===folderId)setBusy(false);}
 }
 const approvers=users.filter(user=>!user.disabled);
 const missing=approverIds.some(id=>id!==""&&!approvers.some(user=>user.id===id));
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
       <div className="approval-chain-fields" aria-label="逐级审批人">
        {approverIds.map((id,index)=><div className="approval-chain-entry" key={index}>
         <label className="approval-field" htmlFor={"approval-approver-"+index}>第 {index+1} 级
          <RareSelect id={"approval-approver-"+index} aria-label={"第 "+(index+1)+" 级审批人"} searchable value={id} required disabled={locked}
           onChange={e=>{setApproverIds(list=>list.map((current,i)=>i===index?e.target.value:current));setNotice(null);}}>
           <option value="">选择审批人</option>
           {id!==""&&!approvers.some(u=>u.id===id)&&<option value={id}>原审批人（已停用或不可用）</option>}
           {approvers.map(user=><option key={user.id} value={user.id}>{user.displayName}{user.login?`（${user.login}）`:""}</option>)}
          </RareSelect>
         </label>
         {approverIds.length>1&&<RareButton type="button" disabled={locked} onClick={()=>setApproverIds(list=>list.filter((_,i)=>i!==index))}>移除</RareButton>}
        </div>)}
        {approverIds.length<5&&<RareButton type="button" disabled={locked} onClick={()=>setApproverIds(list=>[...list,""])}>添加一级</RareButton>}
       </div>
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
        <RareButton type="submit" className="primary" disabled={locked||approverIds.some(id=>!id)||new Set(approverIds).size!==approverIds.length||missing}>{busy?"保存中…":"保存策略"}</RareButton>
       </div>
      </form>
     </div>
    </>}
   </section>
  </div>
 </div>;
}
