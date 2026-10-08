import {useEffect,useState,type FormEvent} from "react";
import type {Folder} from "../../entities/folder/model";
import {folderApi} from "./api";
import {errorCopy} from "../../shared/errors";

const ACTION_LABELS:Record<string,string>={
 list:"查看列表",
 preview:"预览",
 upload:"上传/新建",
 download:"下载",
 modify:"修改",
 delete:"删除",
 rename:"重命名",
 move:"移动",
 print:"打印",
};

const ACTION_KEYS=Object.keys(ACTION_LABELS);

type Grant={id:string;subjectKind:"user"|"group";subjectId:string;actions:string[];scopeOnly:boolean;grantedByName:string};

type Subject={id:string;displayName:string;login?:string};

// The subject picker reuses the admin-only listing endpoints; non-admins see
// the grant list but cannot create or revoke.
export function GrantDialog({folder,onClose,subjects}:{folder:Folder;onClose:()=>void;subjects:Subject[]}){
 const[grants,setGrants]=useState<Grant[]>([]);
 const[subjectKind,setSubjectKind]=useState<"user"|"group">("user");
 const[subjectId,setSubjectId]=useState("");
 const[actions,setActions]=useState<string[]>(["list"]);
 const[scopeOnly,setScopeOnly]=useState(false);
 const[message,setMessage]=useState("");

 useEffect(()=>{
  let valid=true;
  folderApi.grants(folder.id)
   .then(data=>{if(valid)setGrants(data as Grant[]);})
   .catch(()=>{if(valid)setMessage("读取授权列表失败");});
  return()=>{valid=false;};
 },[folder.id]);

 async function submit(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(subjectId===""||actions.length===0)return;
  setMessage("");
  try{
   await folderApi.createGrant(folder.id,subjectKind,subjectId,actions,scopeOnly);
   const refreshed=await folderApi.grants(folder.id);
   setGrants(refreshed as Grant[]);
   setSubjectId("");
  }catch(error){
   setMessage(errorCopy(error,"授权失败"));
  }
 }

 async function revoke(grantId:string){
  setMessage("");
  try{
   await folderApi.revokeGrant(grantId);
   setGrants(prev=>prev.filter(g=>g.id!==grantId));
  }catch(error){
   setMessage(errorCopy(error,"撤销失败"));
  }
 }

 return <dialog open className="dialog grant-dialog">
  <form onSubmit={submit}>
   <h3>目录授权 — {folder.name}</h3>
   <div className="grant-existing">
    {grants.length===0&&<p className="hint">当前没有显式授权（管理员不受限）。</p>}
    {grants.map(g=><div key={g.id} className="grant-row">
     <span>{g.subjectKind==="user"?"用户":"工作组"} {g.subjectId}</span>
     <span>{g.actions.map(a=>ACTION_LABELS[a]??a).join("、")}{g.scopeOnly?"（仅本目录）":""}</span>
     <button type="button" className="danger" onClick={()=>revoke(g.id)}>撤销</button>
    </div>)}
   </div>
   <div className="grant-form">
    <label htmlFor="subject-kind">主体类型</label>
    <select id="subject-kind" value={subjectKind} onChange={e=>{setSubjectKind(e.target.value as "user"|"group");setSubjectId("");}}>
     <option value="user">用户</option>
     <option value="group">工作组</option>
    </select>
    <label htmlFor="subject-id">主体</label>
    <select id="subject-id" value={subjectId} onChange={e=>setSubjectId(e.target.value)} required>
     <option value="">请选择</option>
     {subjects.map(s=><option key={s.id} value={s.id}>{s.displayName}{s.login?`（${s.login}）`:""}</option>)}
    </select>
    <fieldset>
     <legend>动作</legend>
     {ACTION_KEYS.map(key=><label key={key} className="checkbox-label">
      <input type="checkbox" checked={actions.includes(key)}
       onChange={e=>setActions(prev=>e.target.checked?[...prev,key]:prev.filter(a=>a!==key))}/>
      {ACTION_LABELS[key]}
     </label>)}
    </fieldset>
    <label className="checkbox-label">
     <input type="checkbox" checked={scopeOnly} onChange={e=>setScopeOnly(e.target.checked)}/>
     仅本目录（不向子目录继承）
    </label>
   </div>
   {message&&<p role="alert" className="notice error">{message}</p>}
   <div className="dialog-actions">
    <button type="button" className="secondary-action" onClick={onClose}>关闭</button>
    <button type="submit" className="primary" disabled={subjectId===""||actions.length===0}>添加授权</button>
   </div>
  </form>
 </dialog>;
}
