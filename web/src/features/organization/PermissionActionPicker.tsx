import {RareButton,RareInput} from "../../shared/ui/rare";
import "./permissionActionPicker.css";

type Props={
 options:readonly (readonly [string,string])[];
 value:string[];
 onChange:(next:string[])=>void;
 preset:"basic"|"all";
 disabled?:boolean;
 label?:string;
 className?:string;
 toolbarClassName?:string;
 optionsClassName?:string;
};

/** The sole ACL action editor for direct grants, quick grants and delegation.
 * Nothing here submits or mutates a permission; review/authorization stays
 * with the calling workflow. Identical actions must never have three UIs.
 */
export function PermissionActionPicker({options,value,onChange,preset,disabled=false,
 label="操作权限",className="",toolbarClassName="",optionsClassName=""}:Props){
 const allKeys=options.map(([key])=>key);
 const presetKeys=preset==="basic"?["list","preview"].filter(key=>allKeys.includes(key)):allKeys;
 return <fieldset className={"permission-action-picker "+className} disabled={disabled}>
  <legend>{label}</legend>
  <div className={"permission-action-tools "+toolbarClassName} role="group" aria-label="快捷选择权限动作">
   <span role="status">已选 {value.length} / {options.length}</span>
   <RareButton type="button" tone="ghost" disabled={disabled||presetKeys.length===0}
    onClick={()=>onChange(presetKeys)}>{preset==="basic"?"基础浏览":"全部选择"}</RareButton>
   <RareButton type="button" tone="ghost" disabled={disabled||value.length===0}
    onClick={()=>onChange([])}>清空</RareButton>
  </div>
  <div className={"perm-action-grid permission-action-options "+optionsClassName}>
   {options.map(([key,name])=><label key={key} className={value.includes(key)?"is-selected":undefined}>
    <RareInput type="checkbox" checked={value.includes(key)} disabled={disabled}
     onChange={event=>onChange(event.target.checked?[...value,key]:value.filter(action=>action!==key))}/>
    <span>{name}</span>
   </label>)}
  </div>
 </fieldset>;
}
