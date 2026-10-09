import {useEffect,useRef,useState,type FormEvent} from "react";
import type {Folder} from "../../entities/folder/model";
import {folderApi} from "./api";
import {errorCopy} from "../../shared/errors";
import {Dialog} from "../../shared/ui/Dialog";

export function FolderActions({folder,onChanged,isAdmin,onManageGrants,onManagePolicy}:{folder:Folder;onChanged:()=>void;isAdmin:boolean;onManageGrants:()=>void;onManagePolicy:()=>void}){
 const[message,setMessage]=useState("");
 const[renaming,setRenaming]=useState(false);
 const[renameValue,setRenameValue]=useState(folder.name);
 const[renameBusy,setRenameBusy]=useState(false);
 const[moreOpen,setMoreOpen]=useState(false);
 const moreRef=useRef<HTMLDivElement>(null);

 useEffect(()=>{
  if(!moreOpen)return;
  function onDocClick(e:MouseEvent){
   if(moreRef.current&&!moreRef.current.contains(e.target as Node)){
    setMoreOpen(false);
   }
  }
  document.addEventListener("mousedown",onDocClick);
  return()=>document.removeEventListener("mousedown",onDocClick);
 },[moreOpen]);

 async function submitRename(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(renameBusy)return;
  setMessage("");setRenameBusy(true);
  try{
   await folderApi.rename(folder.id,renameValue.trim());
   setRenaming(false);
   onChanged();
  }catch(error){
   setMessage(errorCopy(error,"重命名失败"));
  }finally{setRenameBusy(false);}
 }

 async function remove(){
  if(!window.confirm(`删除目录将同时收起其全部子目录与文件进入回收站。确定删除「${folder.name}」？`))return;
  setMessage("");
  try{
   await folderApi.remove(folder.id);
   onChanged();
  }catch(error){
   setMessage(errorCopy(error,"删除失败"));
  }
 }

 return <div className="folder-actions">
  {isAdmin&&<button type="button" className="ghost-action-btn" onClick={onManageGrants}>授权管理</button>}
  {isAdmin&&<button type="button" className="ghost-action-btn" onClick={onManagePolicy}>审批策略</button>}
  <div className="folder-more-wrapper" ref={moreRef}>
   <button type="button" className="ghost-more-btn" aria-label="更多目录操作" aria-expanded={moreOpen} onClick={()=>setMoreOpen(v=>!v)}>···</button>
   <div className={"folder-more-menu"+(moreOpen?" open":"")} role="menu">
    <button type="button" role="menuitem" onClick={()=>{setMoreOpen(false);setRenaming(true);setRenameValue(folder.name);}}>重命名目录</button>
    <button type="button" role="menuitem" className="danger" onClick={()=>{setMoreOpen(false);remove();}}>删除目录</button>
   </div>
  </div>
  {message&&<span role="alert" className="notice error">{message}</span>}
  {renaming&&<Dialog open title="重命名目录" onClose={()=>setRenaming(false)} closeGuard={()=>!renameBusy} className="dialog">
   <form onSubmit={submitRename}>
    <label htmlFor="folder-rename-input">新名称</label>
    <input id="folder-rename-input" value={renameValue} maxLength={200}
     onChange={e=>setRenameValue(e.target.value)} required disabled={renameBusy}/>
    <div className="dialog-actions">
     <button type="button" className="secondary-action" onClick={()=>setRenaming(false)} disabled={renameBusy}>取消</button>
     <button type="submit" className="primary" disabled={renameBusy}>{renameBusy?"保存中…":"保存"}</button>
    </div>
   </form>
  </Dialog>}
 </div>;
}
