import {useState,type FormEvent} from "react";
import type {FileItem} from "../../entities/file/model";
import {errorCopy} from "../../shared/errors";
import {toast} from "../../shared/ui/feedback";
import {Dialog} from "../../shared/ui/Dialog";
import {RareButton,RareInput} from "../../shared/ui/rare";
import {fileApi} from "./api";
import {displayExtension,extensionChange,type ExtensionChange} from "./fileExtensionChange";
import "./fileRename.css";

export function ExtensionChangeNotice({change}:{change:ExtensionChange}){
 return <>
  <div className="file-rename-extension-change" role="status">
   <span>{displayExtension(change.from)}</span>
   <span aria-hidden="true">→</span>
   <strong>{displayExtension(change.to)}</strong>
  </div>
  <p className="hint file-rename-extension-hint">更改后缀不会转换文件格式，可能导致文件无法正常打开。</p>
 </>;
}

export function FileRenameDialog({file,onClose,onRenamed}:{file:FileItem;onClose:()=>void;onRenamed:(updated:FileItem)=>void}){
 const[name,setName]=useState(file.name);
 const[confirmName,setConfirmName]=useState<string|null>(null);
 const[busy,setBusy]=useState(false);
 const change=confirmName===null?null:extensionChange(file.name,confirmName);

 async function save(nextName:string){
  if(busy)return;
  setBusy(true);
  try{
   const updated=await fileApi.rename(file.id,nextName);
   toast.success("文件已重命名");
   onRenamed(updated);
  }catch(error){
   toast.error(errorCopy(error,"重命名失败"));
  }finally{setBusy(false);}
 }

 function submit(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(busy)return;
  const nextName=name.trim();
  if(!nextName)return;
  if(nextName===file.name){onClose();return;}
  if(extensionChange(file.name,nextName)){
   setConfirmName(nextName);
   return;
  }
  void save(nextName);
 }

 return <Dialog open title={confirmName===null?"重命名文件":"确认更改文件后缀"} onClose={onClose}
  closeGuard={()=>!busy} initialFocus={confirmName===null?"#file-rename-input":".file-rename-confirm"}>
  {confirmName===null?
   <form onSubmit={submit}>
    <label htmlFor="file-rename-input">新文件名</label>
    <RareInput id="file-rename-input" value={name} maxLength={200} onChange={event=>setName(event.target.value)} required disabled={busy}/>
    <div className="dialog-actions">
     <RareButton type="button" className="secondary-action" disabled={busy} onClick={onClose}>取消</RareButton>
     <RareButton type="submit" className="primary" loading={busy} disabled={!name.trim()}>保存</RareButton>
    </div>
   </form>:
   <>
    {change&&<ExtensionChangeNotice change={change}/>}
    <div className="dialog-actions">
     <RareButton type="button" disabled={busy} onClick={()=>setConfirmName(null)}>返回修改</RareButton>
     <RareButton type="button" tone="primary" className="primary file-rename-confirm" loading={busy} onClick={()=>void save(confirmName)}>确认更改</RareButton>
    </div>
   </>}
 </Dialog>;
}
