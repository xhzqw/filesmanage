import {RareInput,RareSelect} from "../../shared/ui/rare";

type Kind="user"|"group";
type Choice={id:string;name:string};
type Common={className?:string;disabled?:boolean};

/** Shared controlled grant fields. The hosting workflow owns safety review,
 * dirty state, and all server mutations; these views own only input geometry.
 */
export function PermissionGrantSubjectFields({kind,onKindChange,subject,onSubjectChange,
 candidates,subjectDisabled=false,disabled=false,className="perm-form-row"}:Common&{
 kind:Kind;onKindChange:(value:Kind)=>void;
 subject:string;onSubjectChange:(value:string)=>void;
 candidates:readonly Choice[];subjectDisabled?:boolean;
}){
 return <div className={className}>
  <label>主体类型<RareSelect value={kind} disabled={disabled} onChange={event=>onKindChange(event.target.value as Kind)}>
   <option value="group">工作组</option><option value="user">用户</option>
  </RareSelect></label>
  <label>授权对象<RareSelect searchable aria-label="选择授权对象" value={subject} required
   disabled={disabled||subjectDisabled} onChange={event=>onSubjectChange(event.target.value)}>
   <option value="">选择{kind==="user"?"用户":"工作组"}</option>
   {candidates.map(option=><option key={option.id} value={option.id}>{option.name}</option>)}
  </RareSelect></label>
 </div>;
}

export function PermissionGrantScopeFields({scopeOnly,onScopeChange,expiresAt,onExpiryChange,
 disabled=false,className="perm-form-row"}:Common&{
 scopeOnly:boolean;onScopeChange:(value:boolean)=>void;
 expiresAt:string;onExpiryChange:(value:string)=>void;
}){
 return <div className={className}>
  <label>作用范围<RareSelect value={scopeOnly?"only":"subtree"} disabled={disabled}
   onChange={event=>onScopeChange(event.target.value==="only")}>
   <option value="only">仅当前目录</option><option value="subtree">包含子目录</option>
  </RareSelect></label>
  <label>到期时间（可选）<RareInput type="datetime-local" value={expiresAt} disabled={disabled}
   onChange={event=>onExpiryChange(event.target.value)}/></label>
 </div>;
}
