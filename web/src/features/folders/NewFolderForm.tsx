import {useState,type FormEvent} from "react";
import {folderApi} from "./api";
import {errorCode} from "../../shared/errors";

export function NewFolderForm({parentId,onCreated}:{parentId:string;onCreated:(name:string)=>void}){
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
  }catch(error){
   setMessage(errorCode(error)==="E_FORBIDDEN"?"当前目录没有新建权限":"新建失败：名称冲突或输入非法");
  }finally{setBusy(false);}
 }
 return <form className="inline-form" onSubmit={submit}>
  <input aria-label="新目录名称" placeholder="新目录名称" value={name} maxLength={200}
   onChange={e=>setName(e.target.value)}/>
  <button className="primary" type="submit" disabled={busy||name.trim()===""}>新建文件夹</button>
  {message&&<span role="alert" className="notice error">{message}</span>}
 </form>;
}
