import {useEffect,useState} from "react";
import {RareButton,RareInput} from "../../shared/ui/rare";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {errorCopy} from "../../shared/errors";
import {sealsApi} from "./api";

type Revision={revision:number;markCount:number;action:string;actorName?:string;createdAt?:string;restoredFrom?:number};
export function SealRevisionControls({fileId,seq,sha,isAdmin,refreshKey,onSelect,onRestored}:{
 fileId:string;seq:number;sha:string;isAdmin:boolean;refreshKey:number;onSelect:(revision:number)=>void;onRestored:()=>void;
}){
 const[history,setHistory]=useState<{current:number;revisions:Revision[]}|null>(null);
 const[target,setTarget]=useState<number|null>(null);
 const[password,setPassword]=useState("");
 const[busy,setBusy]=useState(false);
 const[error,setError]=useState("");
 const[message,setMessage]=useState("");
 useEffect(()=>{
  let mounted=true;setHistory(null);setTarget(null);setPassword("");setError("");
  sealsApi.history(fileId,seq).then(data=>{if(mounted)setHistory(data)})
   .catch(err=>{if(mounted)setError(errorCopy(err,"签章版本读取失败"))});
  return()=>{mounted=false};
 },[fileId,seq,refreshKey]);
 async function restore(){
  if(!isAdmin||!history||target===null||!password||busy||target===history.current)return;
  setBusy(true);setError("");setMessage("");
  try{
   await sealsApi.restore(fileId,{versionSeq:seq,fileSha256:sha,expectedRevision:history.current,targetRevision:target,password});
   setTarget(null);setPassword("");setMessage("签章已回退，历史签署证据仍保留");
   onRestored();
  }catch(err){setError(errorCopy(err,"回退失败，文件或签章版本可能已变化"))}
  finally{setPassword("");setBusy(false)}
 }
 return <section className="seal-revisions" aria-label="签章版本历史">
  <div className="seal-library-heading">签章版本 {history?<span>r{history.current}</span>:null}</div>
  {error&&<p className="notice error" role="alert">{error}</p>}
  {message&&<p className="notice" role="status">{message}</p>}
  {!history?<span className="seal-draft-empty"><BrandLoadingLabel>正在读取签章版本…</BrandLoadingLabel></span>:
   <div className="seal-revision-list">
    {history.revisions.map(item=><div key={item.revision} className="seal-revision-row">
     <div className="seal-revision-meta">
      <strong>{item.revision===0?"原始未签章":"签章 r"+item.revision}{item.revision===history.current?" · 当前":""}</strong>
      <small>{item.markCount} 枚 · {item.action==="restore"?"回退":item.action==="sign"?"签署":item.action==="legacy"?"历史导入":item.action==="revoke"?"删除签章":"原件"}</small>
      {item.actorName&&<small>{item.actorName}{item.createdAt?" · "+new Date(item.createdAt).toLocaleString("zh-CN"):""}</small>}
     </div>
     <div className="seal-revision-actions">
      <RareButton type="button" onClick={()=>onSelect(item.revision)}>查看</RareButton>
      {isAdmin&&item.revision!==history.current&&<RareButton type="button" disabled={busy}
       aria-pressed={target===item.revision} onClick={()=>{setTarget(item.revision);setPassword("");setError("")}}>回退</RareButton>}
     </div>
    </div>)}
   </div>}
  {target!==null&&history&&isAdmin&&<div className="seal-restore-controls">
   <label>回退至 r{target} · 管理员密码
    <RareInput type="password" autoComplete="new-password" value={password}
     placeholder="确认回退前输入" disabled={busy} onChange={e=>setPassword(e.target.value)}/>
   </label>
   <div className="seal-revision-actions">
    <RareButton type="button" disabled={busy} onClick={()=>{setTarget(null);setPassword("")}}>取消</RareButton>
    <RareButton type="button" className="primary" loading={busy} disabled={!password} onClick={()=>void restore()}>
     确认回退
    </RareButton>
   </div>
   <small>生成新签章修订版，不修改原始 PDF，也不删除旧签章记录。</small>
  </div>}
 </section>;
}
