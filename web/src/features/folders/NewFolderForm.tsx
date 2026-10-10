import {RareButton,RareInput} from "../../shared/ui/rare";
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
   await folderApi.create(parentId,name.trim());
   onCreated(name.trim());
   setName("");
   setOpen(false);
  }catch(error){
   setMessage(errorCode(error)==="E_FORBIDDEN"?"当前目录没有新建权限":"新建失败：名称冲突或输入非法");
  }finally{setBusy(false);}
 }

 return <div className="new-folder-wrapper">
  <RareButton type="button" className="action-btn-secondary" onClick={()=>setOpen(true)}>+ 新建文件夹</RareButton>
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
