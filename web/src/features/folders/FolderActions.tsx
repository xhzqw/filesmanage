import {RareButton,RareInput} from "../../shared/ui/rare";
import {toast} from "../../shared/ui/feedback";
import {useEffect,useRef,useState,type FormEvent} from "react";
import type {Folder} from "../../entities/folder/model";
import {folderApi} from "./api";
import {errorCode,errorCopy} from "../../shared/errors";
import {Dialog} from "../../shared/ui/Dialog";
import {Menu,type MenuItem} from "../../shared/ui/Menu";

export function FolderActions({folder,actionRequest,onActionHandled,onActionComplete,onChanged,onMove,isAdmin,onManageGrants}:{folder:Folder;actionRequest?:{folderId:string;action:"rename"|"delete";id:number}|null;onActionHandled?:()=>void;onActionComplete?:()=>void;onChanged:(action:"rename"|"delete",folder:Folder)=>void;onMove?:()=>void;isAdmin:boolean;onManageGrants:()=>void}){
 const[message,setMessage]=useState("");
 const[renaming,setRenaming]=useState(false);
 const[renameValue,setRenameValue]=useState(folder.name);
 const[renameBusy,setRenameBusy]=useState(false);
 const[moreOpen,setMoreOpen]=useState(false);
 const moreRef=useRef<HTMLButtonElement>(null);
 const[deleting,setDeleting]=useState(false);
 const[removeBusy,setRemoveBusy]=useState(false);
 const handledActionId=useRef(0);
 function finishRename(){setRenaming(false);setMessage("");onActionComplete?.();}
 function finishDelete(){setDeleting(false);setMessage("");onActionComplete?.();}
 useEffect(()=>{
  if(!actionRequest||actionRequest.folderId!==folder.id||handledActionId.current===actionRequest.id)return;
  handledActionId.current=actionRequest.id;
  onActionHandled?.();
  if(actionRequest.action==="rename"){
   setRenameValue(folder.name);
   setRenaming(true);
  }else setDeleting(true);
 },[actionRequest,folder.id,folder.name]);

 async function submitRename(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(renameBusy)return;
  setMessage("");setRenameBusy(true);
  try{
   await toast.track(()=>folderApi.rename(folder.id,renameValue.trim()),{
    loading:"正在重命名文件夹…",success:"文件夹已重命名",error:e=>errorCopy(e,"重命名失败"),errorToast:false
   });
   finishRename();
   onChanged("rename",folder);
  }catch(error){
   setMessage(errorCode(error)==="E_NETWORK"?"网络中断，重命名结果未确认；请刷新目录后核对":errorCopy(error,"重命名失败"));
  }finally{setRenameBusy(false);}
 }

 async function remove(){
  setMessage("");setRemoveBusy(true);
  try{
   await toast.track(()=>folderApi.remove(folder.id),{
    loading:"正在移动文件夹至回收站…",success:"文件夹已移入回收站",error:e=>errorCopy(e,"删除失败"),errorToast:false
   });
   finishDelete();onChanged("delete",folder);
  }
  catch(error){setMessage(errorCode(error)==="E_NETWORK"?"网络中断，删除结果未确认；请刷新回收站核对":errorCopy(error,"删除失败"));}
  finally{setRemoveBusy(false);}
 }
 const menuItems:MenuItem[]=[
  {id:"rename",label:"重命名目录",onSelect:()=>{setRenaming(true);setRenameValue(folder.name);}},
  ...(onMove?[{id:"move",label:"移动目录",onSelect:onMove}]:[]),
  {id:"delete",label:"删除目录",danger:true,onSelect:()=>setDeleting(true)}
 ];
 return <div className="folder-actions">
  {isAdmin&&<RareButton type="button" className="ghost-action-btn" onClick={onManageGrants}>授权管理</RareButton>}
  <div className="folder-more-wrapper">
   <RareButton ref={moreRef} type="button" className="ghost-more-btn" aria-label="更多目录操作"
    aria-haspopup="menu" aria-expanded={moreOpen} onClick={()=>setMoreOpen(v=>!v)}>···</RareButton>
   <Menu open={moreOpen} label={"目录操作："+folder.name} items={menuItems}
    anchor={moreRef.current} onClose={()=>setMoreOpen(false)}/>
  </div>
  {message&&<span role="alert" className="notice error">{message}</span>}
  {deleting&&<Dialog open title="删除目录确认" className="dialog"
   onClose={()=>{if(!removeBusy)finishDelete();}} closeGuard={()=>!removeBusy}>
   <p className="hint">目录「{folder.name}」及其子目录、文件将进入回收站，可按权限恢复。</p>
   <div className="dialog-actions">
    <RareButton type="button" className="secondary-action" disabled={removeBusy} onClick={finishDelete}>取消</RareButton>
    <RareButton type="button" tone="danger" className="danger" disabled={removeBusy} onClick={()=>void remove()}>{removeBusy?"删除中…":"确认删除"}</RareButton>
   </div>
  </Dialog>}
  {renaming&&<Dialog open title="重命名目录" onClose={()=>{if(!renameBusy)finishRename();}} closeGuard={()=>!renameBusy} className="dialog">
   <form onSubmit={submitRename}>
    <label htmlFor="folder-rename-input">新名称</label>
    <RareInput id="folder-rename-input" value={renameValue} maxLength={200}
     onChange={e=>setRenameValue(e.target.value)} required disabled={renameBusy}/>
    <div className="dialog-actions">
     <RareButton type="button" className="secondary-action" onClick={finishRename} disabled={renameBusy}>取消</RareButton>
     <RareButton type="submit" tone="primary" className="primary" disabled={renameBusy}>{renameBusy?"保存中…":"保存"}</RareButton>
    </div>
   </form>
  </Dialog>}
 </div>;
}
