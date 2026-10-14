import {RareButton,RareTextarea} from "../../shared/ui/rare";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {toast} from "../../shared/ui/feedback";
import {useEffect,useState,type FormEvent}from "react";
import {fileApi,formatSize}from "./api";
import {assessEditable,encodeEditedText,type EditAssessment}from "./safeEdit";
import {errorCode,errorCopy}from "../../shared/errors";
import {newIdempotencyKey}from "../../shared/ids";
import type{FileItem}from"../../entities/file/model";
import {Dialog}from"../../shared/ui/Dialog";
import "./fileEditor.css";

// Lock-aware plain-text editor. The dialog acquires the server-side edit lock
// before the user types, saves with the live token, and releases on close.
// Folders under an approval policy submit instead of committing directly.
//
// Safe Text Editor gate (COMPLEX-WORKFLOWS-v1 §1): the editor only opens when
// the preview provides the exact bytes (rawBase64) and they round-trip without
// re-encoding or newline normalisation. Truncated, non-textual, binary,
// non-UTF-8 and mixed-EOL files are blocked with an actionable reason instead
// of risking a lossy save. A submitted transaction can never be cancelled
// away: closing is blocked while busy and unsaved edits ask first.
export function FileEditor({file,requiresApproval,onClose,onSaved,inline=false}:{file:FileItem;requiresApproval:boolean;onClose:()=>void;onSaved:()=>void;inline?:boolean}){
 const[status,setStatus]=useState<"loading"|"ready"|"blocked"|"failed">("loading");
 const[assessment,setAssessment]=useState<EditAssessment|null>(null);
 const[content,setContent]=useState("");
 const[loaded,setLoaded]=useState("");
 const[message,setMessage]=useState("");
 const[messageTone,setMessageTone]=useState<"success"|"warning"|"danger">("danger");
 const[busy,setBusy]=useState(false);
 const[lockToken,setLockToken]=useState("");
 const[baseSeq,setBaseSeq]=useState(file.currentVersionSeq);
 const[pending,setPending]=useState<null|"close"|"reload">(null);
 const[reloadToken,setReloadToken]=useState(0);

 useEffect(()=>{
  let valid=true;
  setStatus("loading");setMessage("");setLockToken("");setPending(null);
  fileApi.preview(file.id)
   .then(preview=>{
    if(!valid)return;
    const result=assessEditable(preview);
    setAssessment(result);
    if(!result.editable){setStatus("blocked");return;}
    setContent(result.value.text);
    setLoaded(result.value.text);
    setStatus("ready");
   })
   .catch(error=>{if(valid){setStatus("failed");setMessage(errorCopy(error,"无法读取文件内容。"));}});
  return()=>{valid=false;};
 },[file.id,reloadToken]);

 useEffect(()=>{
  if(status!=="ready"||requiresApproval)return;
  let valid=true;
  fileApi.acquireLock(file.id,baseSeq)
   .then(result=>{if(valid)setLockToken(result.lockToken);})
   .catch(error=>{if(valid)setMessage(errorCopy(error,"无法获取编辑锁：文件可能被其他人锁定或已被修改。"));});
  return()=>{valid=false;};
 },[status,requiresApproval,file.id,baseSeq,reloadToken]);

 useEffect(()=>{
  // Release the lock when the editor unmounts without saving; a save already
  // released it server-side, so a 404 here is expected and ignored.
  return()=>{
   if(lockToken){
    void fileApi.releaseLock(file.id,lockToken).catch(()=>undefined);
   }
  };
 },[file.id,lockToken]);

 const editable=status==="ready"&&assessment?.editable?assessment.value:null;
 const dirty=editable!==null&&content!==loaded;
 const lockPending=editable!==null&&!requiresApproval&&lockToken==="";

 // Escape and the close button only ever unwind one layer: an in-flight
 // submit is not cancellable, and unsaved edits ask before they are dropped.
 function requestClose(){
  if(busy||pending!==null)return;
  if(dirty){setPending("close");return;}
  onClose();
 }

 function requestReload(){
  if(busy||pending!==null)return;
  if(dirty){setPending("reload");return;}
  setReloadToken(token=>token+1);
 }

 async function submit(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(editable===null)return;
  setBusy(true);setMessage("");
  try{
   const data=encodeEditedText(content,editable.eol,editable.hasBom);
   if(requiresApproval){
    await fileApi.submitForApproval(file.id,baseSeq,data);
    setLoaded(content);
    toast.success("修改已提交审批，当前生效版本未变");
    onSaved();
    return;
   }
   if(!lockToken){
    setMessageTone("danger");
    setMessage("编辑锁未就绪，请重新打开编辑器");
    return;
   }
   const result=await fileApi.save(file.id,baseSeq,lockToken,data,newIdempotencyKey());
   setLockToken("");
   setBaseSeq(result.versionSeq);
   setLoaded(content);
   toast.success(`文件已保存为 v${result.versionSeq}`);
   onSaved();
  }catch(error){
   const code=errorCode(error);
   const unknown=code==="E_NETWORK";
   const detail=unknown?"网络中断，保存结果未确认；请先检查最新版本，切勿直接重复提交"
    :code==="E_VERSION_CONFLICT"?"文件已被其他人修改，请刷新后重试"
    :code==="E_LOCKED"?"编辑锁已失效，请重新打开编辑器":errorCopy(error,"保存失败");
   setMessageTone(unknown?"warning":"danger");
   // The editor remains open with an actionable live announcement.
   setMessage(detail);
  }finally{setBusy(false);}
 }

 const body=<form onSubmit={submit}>
   {inline&&<header className="inline-file-editor-head"><strong>在线编辑 · {file.name}</strong><span>⌘ / Ctrl + S 保存</span></header>}
   <p className="hint">{requiresApproval?"该目录的修改需要审批：提交后由审批人通过才生成新版本。":"保存将创建新的不可变版本；当前为 v"+baseSeq+"。"}</p>
   {status==="loading"&&<p className="empty"><BrandLoadingLabel size="sm">正在加载内容…</BrandLoadingLabel></p>}
   {status==="failed"&&<p role="alert" className="notice error">{message||"无法读取文件内容。"}</p>}
   {status==="blocked"&&assessment&&!assessment.editable&&<>
    <p role="alert" className="notice error">{assessment.reason}</p>
    <p className="hint">文件大小 {formatSize(file.sizeBytes)} · 校验值 {file.sha256.slice(0,12)}…</p>
   </>}
   {editable&&<>
    <p className="hint">字节保真：UTF-8 · {editable.eol==="crlf"?"CRLF":"LF"} 换行 · {editable.hasBom?"含 BOM":"无 BOM"}，保存时按原始字节特征写回。</p>
    <label htmlFor="editor-content">内容</label>
    <div className="file-editor-code-card">
     <pre className="file-editor-line-numbers" aria-hidden="true">{Array.from({length:Math.min(5000,content.split("\n").length)},(_,i)=>i+1).join("\n")}</pre>
     <RareTextarea id="editor-content" value={content} rows={16} onChange={e=>setContent(e.target.value)}
      onKeyDown={event=>{
       if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="s"){
        event.preventDefault();
        if(!busy&&!lockPending)event.currentTarget.form?.requestSubmit();
       }
      }}/>
    </div>
   </>}
   {message&&status!=="failed"&&<p role={messageTone==="warning"?"status":"alert"} className={"notice"+(messageTone==="danger"?" error":"")}>{message}</p>}
   {pending&&<p role="alert" className="notice error">有未保存的修改，放弃后将丢失本次编辑。</p>}
   <div className="dialog-actions">
    {pending===null&&<>
     <RareButton type="button" className="secondary-action" onClick={requestClose} disabled={busy}>关闭</RareButton>
     {lockPending&&<RareButton type="button" className="secondary-action" onClick={requestReload} disabled={busy}>重新加载</RareButton>}
     {editable&&<RareButton type="submit" className="primary" loading={busy} disabled={!requiresApproval&&lockToken===""}>
      {requiresApproval?"提交审批":"保存新版本"}
     </RareButton>}
    </>}
    {pending!==null&&<>
     <RareButton type="button" className="danger" onClick={()=>{if(pending==="close")onClose();else setReloadToken(token=>token+1);}}>放弃修改</RareButton>
     <RareButton type="button" className="secondary-action" onClick={()=>setPending(null)}>继续编辑</RareButton>
    </>}
   </div>
  </form>;
 if(inline)return <section className="inline-file-editor" aria-label={"在线编辑 "+file.name}>{body}</section>;
 return <Dialog open title={`编辑 ${file.name}`} onClose={requestClose} closeGuard={()=>!busy} className="dialog editor-dialog">{body}</Dialog>;
}
