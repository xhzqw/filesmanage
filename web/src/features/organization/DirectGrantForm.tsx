import {RareButton,RareInput,RareNotice,RareSelect} from "../../shared/ui/rare";
import type {Dispatch,FormEvent,SetStateAction} from "react";
import {PERMISSION_ACTIONS} from "./permissionActions";

type LoadState="loading"|"ready"|"failed";
export type SubmitState="edit"|"review"|"saving";

export function DirectGrantForm({folderName,usersState,groupsState,onRetryUsers,onRetryGroups,
 subjectKind,setSubjectKind,subjectId,setSubjectId,actions,setActions,scopeOnly,setScopeOnly,
 expiresAt,setExpiresAt,submitState,setSubmitState,riskAcknowledged,setRiskAcknowledged,
 subjectSourceState,candidates,names,riskyActions,needsRiskConsent,displayActions,grantLoadState,onSubmit}:{
 folderName:string;
 usersState:LoadState;groupsState:LoadState;
 onRetryUsers:()=>void;onRetryGroups:()=>void;
 subjectKind:"user"|"group";setSubjectKind:Dispatch<SetStateAction<"user"|"group">>;
 subjectId:string;setSubjectId:Dispatch<SetStateAction<string>>;
 actions:string[];setActions:Dispatch<SetStateAction<string[]>>;
 scopeOnly:boolean;setScopeOnly:Dispatch<SetStateAction<boolean>>;
 expiresAt:string;setExpiresAt:Dispatch<SetStateAction<string>>;
 submitState:SubmitState;setSubmitState:Dispatch<SetStateAction<SubmitState>>;
 riskAcknowledged:boolean;setRiskAcknowledged:Dispatch<SetStateAction<boolean>>;
 subjectSourceState:LoadState;candidates:{id:string;name:string}[];
 names:Map<string,string>;riskyActions:string[];needsRiskConsent:boolean;
 displayActions:(actions:string[])=>string;grantLoadState:LoadState;
 onSubmit:(event:FormEvent<HTMLFormElement>)=>void;
}){
 return <>
     <section className="perm-card perm-compose-card" aria-label="新增直接授权">

  <form className="perm-form" onSubmit={onSubmit} onChange={event=>{
   if((event.target as HTMLElement).classList.contains("perm-risk-consent"))return;
   if(submitState==="review"){setSubmitState("edit");setRiskAcknowledged(false);}
  }}>
     {usersState==="failed"&&<RareNotice tone="danger">读取用户列表失败。<RareButton type="button" className="secondary-action" onClick={onRetryUsers}>重试用户列表</RareButton></RareNotice>}
     {groupsState==="failed"&&<RareNotice tone="danger">读取工作组列表失败。<RareButton type="button" className="secondary-action" onClick={onRetryGroups}>重试工作组列表</RareButton></RareNotice>}
     {subjectSourceState==="loading"&&<p role="status" className="hint">正在读取可授权主体…</p>}
     <div className="perm-form-row">
      <label>主体类型<RareSelect value={subjectKind} onChange={e=>{setSubjectKind(e.target.value as "user"|"group");setSubjectId("");setSubmitState("edit");}}>
       <option value="group">工作组</option><option value="user">用户</option></RareSelect></label>
      <label>授权对象<RareSelect searchable aria-label="授权对象，可在下拉列表内搜索" value={subjectId} required disabled={subjectSourceState!=="ready"} onChange={e=>{setSubjectId(e.target.value);setSubmitState("edit");}}>
       <option value="">选择{subjectKind==="user"?"用户":"工作组"}</option>{candidates.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</RareSelect></label>
     </div>
     <fieldset className="perm-action-fieldset"><legend>操作权限</legend><div className="perm-action-grid">
      {PERMISSION_ACTIONS.map(([key,label])=><label key={key}><RareInput type="checkbox" checked={actions.includes(key)}
       onChange={e=>setActions(old=>e.target.checked?[...old,key]:old.filter(x=>x!==key))}/>{label}</label>)}
     </div></fieldset>
     <div className="perm-form-row">
      <label>作用范围<RareSelect value={scopeOnly?"only":"subtree"} onChange={e=>{setScopeOnly(e.target.value==="only");setSubmitState("edit");}}>
       <option value="only">仅当前目录</option><option value="subtree">包含子目录</option></RareSelect></label>
      <label>到期时间<RareInput type="datetime-local" value={expiresAt} onChange={e=>setExpiresAt(e.target.value)}/></label>
     </div>
     {submitState==="review"&&<div className="perm-review" role="status">
      <strong>请核对授权摘要</strong>
       <p><strong>目录：</strong>{folderName}</p>
       <p><strong>对象：</strong>{names.get(subjectKind+":"+subjectId)??subjectId} · <strong>权限：</strong>{displayActions(actions)}</p>
       <p><strong>范围：</strong>{scopeOnly?"当前目录":"包含子目录"} · <strong>到期：</strong>{expiresAt||"不限"}</p>
      {needsRiskConsent&&<>
       <p className="perm-risk-warning" role="alert">高影响权限：{displayActions(riskyActions)}。{scopeOnly
        ?"将允许主体在当前目录执行这些操作。"
        :"还会作用于所有子目录，后续新增的子目录也在授权范围内。"}{expiresAt?"":"此授权没有到期时间。"}</p>
       <label className="perm-risk-confirm"><RareInput className="perm-risk-consent" type="checkbox"
        checked={riskAcknowledged} onChange={e=>setRiskAcknowledged(e.target.checked)}/>
        我已核对资源目录、授权主体、操作范围和期限，确认授予以上高影响权限
       </label>
      </>}
     </div>}
     <div className="perm-form-actions">
      {submitState==="review"&&<RareButton type="button" className="secondary-action" onClick={()=>{setSubmitState("edit");setRiskAcknowledged(false);}}>返回修改</RareButton>}
      <RareButton type="submit" tone="primary" className="primary" loading={submitState==="saving"} disabled={submitState==="saving"||!subjectId||!actions.length||grantLoadState!=="ready"||subjectSourceState!=="ready"||(submitState==="review"&&needsRiskConsent&&!riskAcknowledged)}>
       {submitState==="saving"?"提交中…":submitState==="review"?"确认添加授权":"预览授权"}</RareButton>
     </div>
    </form>
     </section>
 </>;
}
