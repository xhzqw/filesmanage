import {useEffect,useState} from "react";
import {useSearchParams} from "react-router-dom";
import type {User} from "../../entities/user/model";
import {RareBadge,RareButton,RareInput,RareNotice,RareSelect} from "../../shared/ui/rare";
import {ResourceBrowser} from "./ResourceBrowser";
import type {ResourceFolder} from "./permissionsApi";
import {useApprovalPolicyEditor} from "./useApprovalPolicyEditor";
import "./approvalPolicies.css";

type LoadState="loading"|"ready"|"failed";
export function ApprovalPoliciesPanel({users,usersState,onRetryUsers,onDirtyChange,requestNavigation}:{
 users:User[];usersState:LoadState;onRetryUsers:()=>void;
 onDirtyChange:(dirty:boolean)=>void;requestNavigation:(navigate:()=>void)=>void;
}){
 const [params,setParams]=useSearchParams();
 const folderId=params.get("folder")??"";
 const [folderName,setFolderName]=useState<{id:string;name:string}|null>(null);
 const {status,approverIds,enabled,configured,busy,confirmRemove,notice,remoteChanged,
  unknown,protectedDraft,editingReady,setConfirmRemove,
  editIds,editEnabled,discardAndReload,save,remove}=useApprovalPolicyEditor(folderId);
 useEffect(()=>onDirtyChange(protectedDraft),[protectedDraft,onDirtyChange]);
 useEffect(()=>()=>onDirtyChange(false),[onDirtyChange]);
 function selectFolder(folder:ResourceFolder){
  if(folder.id===folderId)return;
  requestNavigation(()=>{
   setFolderName({id:folder.id,name:folder.path||folder.name});
   setParams(old=>{const next=new URLSearchParams(old);next.set("tab","approvals");next.set("folder",folder.id);next.delete("view");return next;});
  });
 }
 const approvers=users.filter(user=>!user.disabled);
 const missing=approverIds.some(id=>id!==""&&!approvers.some(user=>user.id===id));
 const locked=busy||!editingReady||unknown||remoteChanged||usersState!=="ready";
 return <div className="perm-content-root approval-content">
  <div className="perm-workspace approval-workspace">
   <ResourceBrowser selected={folderId} onSelect={selectFolder}/>
   <section className="approval-detail" aria-label="目录审批策略">
    {!folderId?<div className="perm-empty-state"><strong>选择资源目录</strong></div>:<>
     <div className="approval-heading">
      <h2 title={folderName?.id===folderId?folderName.name:folderId}>{folderName?.id===folderId?folderName.name:folderId}</h2>
      {editingReady&&<RareBadge className="approval-state" tone={!configured?"neutral":enabled?"success":"warning"} dot>{!configured?"未配置":enabled?"已启用":"已停用"}</RareBadge>}
     </div>
     <div className="approval-editor">
      {status==="loading"&&<p role="status" className="hint">正在读取审批策略…</p>}
      {notice&&!unknown&&<RareNotice tone={notice.error?"danger":"success"}>{notice.message}</RareNotice>}
      {status==="failed"&&<RareButton type="button" onClick={()=>requestNavigation(discardAndReload)}>重新读取</RareButton>}
      {(unknown||remoteChanged)&&<RareNotice tone="warning">
       {unknown?"写入结果尚未确认，已暂停再次提交。":"远端策略可能已更新，当前草稿未被覆盖。"}
       <RareButton type="button" disabled={busy} onClick={()=>requestNavigation(discardAndReload)}>放弃草稿并重新读取</RareButton>
      </RareNotice>}
      {usersState==="failed"&&<RareNotice tone="danger">用户列表读取失败。<RareButton type="button" onClick={onRetryUsers}>重试</RareButton></RareNotice>}
      <form className="approval-form" onSubmit={event=>void save(event,usersState==="ready"&&!missing)}>
       <div className="approval-chain-fields" aria-label="逐级审批人">
        {approverIds.map((id,index)=><div className="approval-chain-entry" key={index}>
         <label className="approval-field" htmlFor={"approval-approver-"+index}>第 {index+1} 级
          <RareSelect id={"approval-approver-"+index} aria-label={"第 "+(index+1)+" 级审批人"} searchable value={id} required disabled={locked}
           onChange={e=>editIds(approverIds.map((current,i)=>i===index?e.target.value:current))}>
           <option value="">选择审批人</option>
           {id!==""&&!approvers.some(u=>u.id===id)&&<option value={id}>原审批人（已停用或不可用）</option>}
           {approvers.map(user=><option key={user.id} value={user.id}>{user.displayName}{user.login?`（${user.login}）`:""}</option>)}
          </RareSelect>
         </label>
         {approverIds.length>1&&<RareButton type="button" disabled={locked} onClick={()=>editIds(approverIds.filter((_,i)=>i!==index))}>移除</RareButton>}
        </div>)}
        {approverIds.length<5&&<RareButton type="button" disabled={locked} onClick={()=>editIds([...approverIds,""])}>添加一级</RareButton>}
       </div>
       <label className="approval-toggle"><RareInput type="checkbox" checked={enabled} disabled={locked}
         onChange={e=>editEnabled(e.target.checked)}/><span>启用审批</span></label>
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
