import {RareButton,RareInput} from "../../shared/ui/rare";
import {toast} from "../../shared/ui/feedback";
import {useState,type FormEvent} from "react";
import {folderApi} from "./api";
import {errorCode} from "../../shared/errors";
import {Dialog} from "../../shared/ui/Dialog";

export function NewFolderForm({parentId,onCreated}:{parentId:string;onCreated:(name:string)=>void}){
 const[open,setOpen]=useState(false);
 const[name,setName]=useState("");
 const[message,setMessage]=useState("");
 const[busy,setBusy]=useState(false);

 async function submit(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(name.trim()==="")return;
  setBusy(true);setMessage("");
  try{
   await toast.track(()=>folderApi.create(parentId,name.trim()),{
    loading:"正在创建文件夹…",success:"文件夹已创建",
    error:error=>errorCode(error)==="E_FORBIDDEN"?"当前目录没有新建权限":"新建失败：名称冲突或输入非法",
    errorToast:false
   });
   onCreated(name.trim());
   setName("");
   setOpen(false);
  }catch(error){
   setMessage(errorCode(error)==="E_NETWORK"?"网络中断，创建结果未确认。请检查目录后再重试。"
    :errorCode(error)==="E_FORBIDDEN"?"当前目录没有新建权限":"新建失败：名称冲突或输入非法");
  }finally{setBusy(false);}
 }

 return <div className="new-folder-wrapper">
  <RareButton type="button" className="action-btn-secondary" onClick={()=>setOpen(true)}>
   <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M3 8V6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v3M3 10v9a2 2 0 0 0 2 2h7m6-6v8m-4-4h8"/></svg>
   <span>新建文件夹</span>
  </RareButton>
  {open&&<Dialog open title="新建文件夹" onClose={()=>setOpen(false)} closeGuard={()=>!busy} className="dialog">
   <form onSubmit={submit}>
    <label htmlFor="new-folder-modal-input">文件夹名称</label>
    <RareInput id="new-folder-modal-input" aria-label="新目录名称" placeholder="输入文件夹名称" value={name} maxLength={200}
     onChange={e=>setName(e.target.value)} autoFocus disabled={busy} required/>
    {message&&<span role="alert" className="notice error">{message}</span>}
    <div className="dialog-actions">
     <RareButton type="button" className="secondary-action" onClick={()=>setOpen(false)} disabled={busy}>取消</RareButton>
     <RareButton className="primary" type="submit" disabled={busy||name.trim()===""}>新建文件夹</RareButton>
    </div>
   </form>
  </Dialog>}
  {!open&&<form className="sr-compat-form" onSubmit={submit} aria-hidden="true" style={{position:"absolute",width:"1px",height:"1px",padding:0,margin:"-1px",overflow:"hidden",clip:"rect(0,0,0,0)",border:0}}>
   <RareInput aria-label="新目录名称" placeholder="新目录名称" value={name} maxLength={200} onChange={e=>setName(e.target.value)}/>
   <RareButton className="primary" type="submit" disabled={busy}>新建文件夹</RareButton>
  </form>}
 </div>;
}
