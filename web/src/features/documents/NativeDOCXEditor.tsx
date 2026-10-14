import {forwardRef,useEffect,useImperativeHandle,useRef,useState} from "react";
import {fileApi,type NativeDocument} from "./api";
import {newIdempotencyKey} from "../../shared/ids";
import {errorCopy} from "../../shared/errors";
import {toast} from "../../shared/ui/feedback";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {RareButton} from "../../shared/ui/rare";

export type NativeEditorHandle={save:()=>Promise<void>;isDirty:()=>boolean;format:(command:string)=>void};

// This fallback edits the actual DOCX paragraph text while retaining the
// original OOXML package, paragraph styles, table cells and relationships.
// Saving always uses the existing server-side file lock and CAS version flow.
export const NativeDOCXEditor=forwardRef<NativeEditorHandle,{
 fileId:string;
 onState:(state:"clean"|"dirty"|"saved"|"failed",message:string)=>void;
 onSaved:(version:number)=>void;
}>(function NativeDOCXEditor({fileId,onState,onSaved},ref){
 const[data,setData]=useState<NativeDocument|null>(null);
 const[loading,setLoading]=useState(true);
 const[busy,setBusy]=useState(false);
 const[error,setError]=useState("");
 const[editable,setEditable]=useState(false);
 const[retry,setRetry]=useState(0);
 const currentSeq=useRef(0);
 const lock=useRef("");
 const texts=useRef<string[]>([]);
 const savedTexts=useRef<string[]>([]);
 const dirty=useRef(false);
 const onStateRef=useRef(onState);
 const onSavedRef=useRef(onSaved);
 onStateRef.current=onState;
 onSavedRef.current=onSaved;
 useEffect(()=>{
  let live=true;
  setData(null);setLoading(true);setError("");setEditable(false);
  void fileApi.nativeDOCXContent(fileId).then(async result=>{
   if(!live)return;
   currentSeq.current=result.versionSeq;
   texts.current=result.paragraphs.map(p=>p.text);
   savedTexts.current=[...texts.current];
   dirty.current=false;
   setData(result);
   const acquired=await fileApi.acquireLock(fileId,result.versionSeq);
   if(!live){void fileApi.releaseLock(fileId,acquired.lockToken).catch(()=>undefined);return;}
   lock.current=acquired.lockToken;
   setEditable(true);
   onStateRef.current("clean","● 尚未修改");
  }).catch(err=>{
   if(live){
    setError(errorCopy(err,"内置编辑器无法读取或锁定文档"));
    onStateRef.current("failed","● 无法取得编辑锁");
   }
  }).finally(()=>{if(live)setLoading(false);});
  return()=>{
   live=false;
   const token=lock.current;lock.current="";
   if(token)void fileApi.releaseLock(fileId,token).catch(()=>undefined);
  };
 },[fileId,retry]);
 async function save(){
  if(busy||!editable||!data||!dirty.current)return;
  const token=lock.current;
  if(!token){setError("编辑锁已失效，请重新加载文档");return;}
  setBusy(true);setError("");onStateRef.current("dirty","● 正在保存...");
  try{
   const result=await fileApi.saveNativeDOCX(fileId,currentSeq.current,token,newIdempotencyKey(),texts.current);
   lock.current="";dirty.current=false;
   savedTexts.current=[...texts.current];
   if(result.status==="pending"){
    onStateRef.current("saved","● 已提交审批");
    toast.info("已提交审批，当前文件版本保持不变");
    setEditable(false);
   }else{
    currentSeq.current=result.versionSeq;
    onStateRef.current("saved","● 已保存为新版本 · v"+result.versionSeq);
    onSavedRef.current(result.versionSeq);
    toast.success("已保存为 v"+result.versionSeq);
    try{
     const acquired=await fileApi.acquireLock(fileId,result.versionSeq);
     lock.current=acquired.lockToken;
    }catch{
     // A durable save has already succeeded. Do not report it as failed if
     // subsequent edit-lock reacquisition races another collaborator.
     setEditable(false);
     toast.info("文档已保存；重新进入编辑器可继续修改");
    }
   }
  }catch(err){
   onStateRef.current("failed","● 保存失败");
   setError(errorCopy(err,"无法保存新版本，请检查锁与版本"));
  }finally{setBusy(false);}
 }
 useImperativeHandle(ref,()=>({
  save,isDirty:()=>dirty.current,
  format:(command:string)=>{
   const focused=document.activeElement;
   if(!(focused instanceof HTMLElement)||!focused.isContentEditable)return;
   if(command==="insert-table-row"){
    toast.info("内置模式只能修改已有表格单元格；新增行请使用 ONLYOFFICE");
    return;
   }
   if(command==="h1"||command==="h2"||command==="body"){
    toast.info("内置模式保留原有段落格式；调整标题样式请使用 ONLYOFFICE");
    return;
   }
   // Text-only native persistence deliberately cannot claim to preserve
   // newly applied inline bold/italic markup. Existing styles are retained.
   if(command==="bold"||command==="italic"||command==="justifyLeft"||command==="justifyCenter"||command==="insertUnorderedList"){
    toast.info("内置模式支持文字编辑并保留原格式；高级排版请使用 ONLYOFFICE");
    return;
   }
   if(command==="undo"||command==="redo")document.execCommand(command,false);
  }
 }));
 return <div className="native-docx-stage">
  {loading&&<div className="office-native-state" role="status"><BrandLoadingLabel>正在加载内置 Word 编辑器…</BrandLoadingLabel></div>}
  {error&&<div className="office-native-error" role="alert">{error}<RareButton type="button" disabled={busy} onClick={()=>setRetry(n=>n+1)}>重新加载</RareButton></div>}
  {data&&<article className="native-docx-paper" aria-label="可编辑 Word 文档">
   {data.paragraphs.map((block,index)=><div
    key={index} className={"native-docx-paragraph"+(block.tableCell?" is-cell":"")+(block.kind==="heading1"?" is-heading1":block.kind==="heading2"?" is-heading2":"")}
    contentEditable={editable&&!busy} suppressContentEditableWarning
    role="textbox" aria-label={block.tableCell?"表格单元格 "+(index+1):"段落 "+(index+1)}
    aria-multiline="true"
    onInput={event=>{
     texts.current[index]=event.currentTarget.innerText;
     dirty.current=texts.current.some((text,i)=>text!==savedTexts.current[i]);
     onStateRef.current(dirty.current?"dirty":"clean",dirty.current?"● 有修改待保存":"● 尚未修改");
    }}>{block.text}</div>)}
  </article>}
 </div>;
});
