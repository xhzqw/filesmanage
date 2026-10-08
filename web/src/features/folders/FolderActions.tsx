import {useState,type FormEvent} from "react";
import type {Folder} from "../../entities/folder/model";
import {folderApi} from "./api";
import {errorCopy} from "../../shared/errors";

export function FolderActions({folder,onChanged,isAdmin,onManageGrants,onManagePolicy}:{folder:Folder;onChanged:()=>void;isAdmin:boolean;onManageGrants:()=>void;onManagePolicy:()=>void}){
 const[message,setMessage]=useState("");
 const[renaming,setRenaming]=useState(false);
 const[renameValue,setRenameValue]=useState(folder.name);

 async function submitRename(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  setMessage("");
  try{
   await folderApi.rename(folder.id,renameValue.trim());
   setRenaming(false);
   onChanged();
  }catch(error){
   setMessage(errorCopy(error,"重命名失败"));
  }
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
  <button type="button" onClick={()=>{setRenaming(true);setRenameValue(folder.name);}}>重命名目录</button>
  {isAdmin&&<button type="button" onClick={onManageGrants}>授权管理</button>}
  {isAdmin&&<button type="button" onClick={onManagePolicy}>审批策略</button>}
  <button type="button" className="danger" onClick={remove}>删除目录</button>
  {message&&<span role="alert" className="notice error">{message}</span>}
  {renaming&&<dialog open className="dialog">
   <form onSubmit={submitRename}>
    <h3>重命名目录</h3>
    <label htmlFor="folder-rename-input">新名称</label>
    <input id="folder-rename-input" value={renameValue} maxLength={200}
     onChange={e=>setRenameValue(e.target.value)} required/>
    <div className="dialog-actions">
     <button type="button" className="secondary-action" onClick={()=>setRenaming(false)}>取消</button>
     <button type="submit" className="primary">保存</button>
    </div>
   </form>
  </dialog>}
 </div>;
}
