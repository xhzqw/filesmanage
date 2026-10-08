import {useEffect,useState,type FormEvent} from "react";
import {fileApi} from "./api";
import {errorCode,errorCopy} from "../../shared/errors";
import {newIdempotencyKey} from "../../shared/ids";
import type {FileItem} from "../../entities/file/model";

// Lock-aware plain-text editor. The dialog acquires the server-side edit lock
// before the user types, saves with the live token, and releases on close.
// Folders under an approval policy submit instead of committing directly.
export function FileEditor({file,requiresApproval,onClose,onSaved}:{file:FileItem;requiresApproval:boolean;onClose:()=>void;onSaved:()=>void}){
 const[content,setContent]=useState("");
 const[status,setStatus]=useState("loading");
 const[message,setMessage]=useState("");
 const[busy,setBusy]=useState(false);
 const[lockToken,setLockToken]=useState("");
 const[baseSeq,setBaseSeq]=useState(file.currentVersionSeq);

 useEffect(()=>{
  let valid=true;
  fileApi.preview(file.id)
   .then(preview=>{
    if(!valid)return;
    setContent(preview.content);
    setStatus("ready");
   })
   .catch(()=>{if(valid){setStatus("failed");}});
  return()=>{valid=false;};
 },[file.id]);

 useEffect(()=>{
  if(status!=="ready"||requiresApproval)return;
  let valid=true;
  fileApi.acquireLock(file.id,baseSeq)
   .then(result=>{if(valid)setLockToken(result.lockToken);})
   .catch(()=>{if(valid)setMessage("无法获取编辑锁，可能文件被其他人锁定");});
  return()=>{valid=false;};
 },[status,requiresApproval,file.id,baseSeq]);

 useEffect(()=>{
  // Release the lock when the editor unmounts without saving; a save already
  // released it server-side, so a 404 here is expected and ignored.
  return()=>{
   if(lockToken){
    void fileApi.releaseLock(file.id,lockToken).catch(()=>undefined);
   }
  };
 },[file.id,lockToken]);

 async function submit(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  setBusy(true);setMessage("");
  try{
   const data=btoa(unescape(encodeURIComponent(content)));
   if(requiresApproval){
    await fileApi.submitForApproval(file.id,baseSeq,data);
    setMessage("已提交审批，通过后生成新版本");
    onSaved();
    return;
   }
   if(!lockToken){
    setMessage("编辑锁未就绪，请重新打开编辑器");
    return;
   }
   const result=await fileApi.save(file.id,baseSeq,lockToken,data,newIdempotencyKey());
   setLockToken("");
   setBaseSeq(result.versionSeq);
   setMessage(`已保存为 v${result.versionSeq}`);
   onSaved();
  }catch(error){
   const code=errorCode(error);
   setMessage(code==="E_VERSION_CONFLICT"?"文件已被其他人修改，请刷新后重试":code==="E_LOCKED"?"编辑锁已失效，请重新打开编辑器":errorCopy(error,"保存失败"));
  }finally{setBusy(false);}
 }

 return <dialog open className="dialog editor-dialog">
  <form onSubmit={submit}>
   <h3>编辑 {file.name}</h3>
   <p className="hint">{requiresApproval?"该目录的修改需要审批：提交后由审批人通过才生成新版本。":"保存将创建新的不可变版本；当前为 v"+baseSeq+"。"}</p>
   {status==="loading"&&<p className="empty">正在加载内容…</p>}
   {status==="failed"&&<p role="alert" className="notice error">无法读取文件内容。</p>}
   {status==="ready"&&<>
    <label htmlFor="editor-content">内容</label>
    <textarea id="editor-content" value={content} rows={16} onChange={e=>setContent(e.target.value)}/>
   </>}
   {message&&<p role="alert" className="notice error">{message}</p>}
   <div className="dialog-actions">
    <button type="button" className="secondary-action" onClick={onClose}>关闭</button>
    <button type="submit" className="primary" disabled={busy||status!=="ready"||(!requiresApproval&&lockToken==="")}>
     {busy?"保存中…":requiresApproval?"提交审批":"保存新版本"}
    </button>
   </div>
  </form>
 </dialog>;
}
