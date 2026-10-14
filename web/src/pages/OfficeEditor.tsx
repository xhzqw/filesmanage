import {RareButton} from "../shared/ui/rare";
import {toast} from "../shared/ui/feedback";
import {BrandLoadingLabel} from "../shared/ui/BrandLoader";
import {useEffect,useRef,useState} from "react";
import {useNavigate,useParams} from "react-router-dom";
import {fileApi} from "../features/documents/api";
import {errorCopy} from "../shared/errors";
import {observeResourceChange,observeWorkspaceChange} from "../shared/resourceSync";
import type {OfficeSessionData} from "../features/documents/api";
import type {FileItem} from "../entities/file/model";
import type {User} from "../entities/user/model";
import {FileTypeIcon} from "../shared/ui/FileTypeIcon";
import {newIdempotencyKey} from "../shared/ids";
import "./officeEditor.css";

declare global{
 interface Window{
  DocsAPI?:{DocEditor?:new (id:string,config:Record<string,unknown>)=>{destroyEditor?:()=>void}};
 }
}

type EditorStatus="loading"|"ready"|"failed";
type SaveState="clean"|"dirty"|"saved"|"failed";

// Only the application's callback receipt, followed by a committed file
// version, can make the UI say "saved". The editor's cache sync is not a save.
export function OfficeEditor({}:{user:User;onLogout:()=>void}){
 const{id=""}=useParams();
 const navigate=useNavigate();
 const[status,setStatus]=useState<EditorStatus>("loading");
 const[message,setMessage]=useState("");
 const[file,setFile]=useState<FileItem|null>(null);
 const[sessionId,setSessionId]=useState("");
 const[saveState,setSaveState]=useState<SaveState>("clean");
 const[saveMessage,setSaveMessage]=useState("尚未修改");
 const[confirmedSeq,setConfirmedSeq]=useState<number|null>(null);
 const holder=useRef<HTMLDivElement>(null);
 const editor=useRef<{destroyEditor?:()=>void}|null>(null);
 const dirty=useRef(false);
 const changeNumber=useRef(0);
 const nativeSavedCount=useRef(0);
 const nativeFailedCount=useRef(0);
 const receiptProbe=useRef<(()=>void)|null>(null);
 const[exporting,setExporting]=useState(false);

 useEffect(()=>{
  const beforeUnload=(event:BeforeUnloadEvent)=>{
   if(!dirty.current)return;
   event.preventDefault();
   event.returnValue="";
  };
  window.addEventListener("beforeunload",beforeUnload);
  // React Router navigates without beforeunload; protect links in the shell.
  const beforeLink=(event:MouseEvent)=>{
   const target=event.target;
   if(!(target instanceof Element)||!target.closest("a[href]"))return;
   if(dirty.current&&!window.confirm("修改尚未保存至文档库。确定放弃修改并离开吗？")){
    event.preventDefault();
    event.stopPropagation();
   }
  };
  document.addEventListener("click",beforeLink,true);
  return()=>{window.removeEventListener("beforeunload",beforeUnload);document.removeEventListener("click",beforeLink,true);};
 },[]);

 useEffect(()=>{
  let valid=true;
  fileApi.meta(id)
   .then(data=>{if(valid)setFile(data.file);})
   .catch(()=>{if(valid){setStatus("failed");setMessage("无法读取文件信息");}});
  return()=>{valid=false;};
 },[id]);

 useEffect(()=>{
  if(!file)return;
  let valid=true;
  let ready=false;
  let failed=false;
  let openedSession="";
  let waitForDocument:number|undefined;
  setStatus("loading");
  setMessage("");
  setSaveMessage("● 正在连接 ONLYOFFICE");
  const fail=(reason:string)=>{
   if(!valid||failed)return;
   failed=true;
   window.clearTimeout(waitForDocument);
   editor.current?.destroyEditor?.();editor.current=null;
   const closing=openedSession;
   openedSession="";
   if(closing)void fileApi.cancelOfficeSession(file.id,closing).catch(()=>undefined);
   setSessionId("");
   setStatus("failed");
   setMessage(reason);
   setSaveState("failed");
   setSaveMessage("● ONLYOFFICE 连接失败");
  };
  fileApi.openOfficeSession(file.id)
   .then(async session=>{
    const opened=session as OfficeSessionData;
    if(!valid){
     void fileApi.cancelOfficeSession(file.id,opened.sessionId).catch(()=>undefined);
     return;
    }
    openedSession=opened.sessionId;
    setSessionId(opened.sessionId);
    // Capture the current server receipts before the user can edit.
    const initial=await fileApi.officeNativeSaveStatus(file.id,opened.sessionId).catch(()=>null);
    if(!valid)return;
    nativeSavedCount.current=initial?.savedCount??0;
    nativeFailedCount.current=initial?.failedCount??0;
    await loadEditorScript(editorBrowserUrl(opened.editorUrl)+"/web-apps/apps/api/documents/api.js");
    if(!valid||failed||!holder.current)return;
    const DocEditor=window.DocsAPI?.DocEditor;
    if(!DocEditor)throw new Error("editor api unavailable");
    const events={
     onDocumentReady:()=>{
      if(!valid||failed)return;
      ready=true;
      window.clearTimeout(waitForDocument);
      setStatus("ready");
      setSaveState("clean");
      setSaveMessage("● ONLYOFFICE 已连接");
     },
     onDocumentStateChange:(event:{data?:boolean})=>{
      if(!valid||failed)return;
      if(event.data===true){
       changeNumber.current++;
       dirty.current=true;
       setSaveState("dirty");
       setSaveMessage("有修改未保存至文档库");
      }else if(event.data===false&&dirty.current){
       // This ONLYOFFICE event confirms its own cache, NOT a committed
       // document version. Never mark clean before the server receipt.
       setSaveState("dirty");
       setSaveMessage("编辑器已暂存 · 等待文档库保存确认");
       receiptProbe.current?.();
      }
     },
     onError:(event:{data?:{errorDescription?:string}})=>{
      if(!valid||failed)return;
      if(!ready){
       fail(event.data?.errorDescription||"ONLYOFFICE 无法读取此文档，请检查文档下载接口");
      }else{
       dirty.current=true;
       setSaveState("failed");
       setSaveMessage("编辑器出现错误，请检查文档后重试保存");
      }
     }
    };
    editor.current=new DocEditor("docx-editor-target",{...opened.config,events});
    waitForDocument=window.setTimeout(()=>{
     if(!valid||failed||ready)return;
     fail("ONLYOFFICE 文档加载超时。请检查编辑服务与文档下载接口。");
    },45000);
   })
   .catch(error=>{
    if(!valid||failed)return;
    fail(errorCopy(error,"无法连接 ONLYOFFICE，请检查文档编辑服务后重试"));
   });
  return()=>{valid=false;window.clearTimeout(waitForDocument);editor.current?.destroyEditor?.();editor.current=null;};
 },[file]);

 // The built-in Save button triggers status=6 (forcesavetype=1). Listen for
 // the committed change hint to remove the old 0–1200ms polling delay, but
 // ALWAYS verify the durable receipt before showing success. Polling remains
 // as a fallback if WebSocket messages are delayed or unavailable.
 useEffect(()=>{
  if(!sessionId||!file)return;
  let active=true;
  let inFlight=false;
  let queued=false;
  const check=async()=>{
   if(!dirty.current||!active)return;
   if(inFlight){queued=true;return;}
   inFlight=true;
   const revision=changeNumber.current;
   try{
    const receipt=await fileApi.officeNativeSaveStatus(file.id,sessionId);
    if(!active)return;
    const committed=receipt.savedCount>nativeSavedCount.current;
    const failed=receipt.failedCount>nativeFailedCount.current;
    nativeSavedCount.current=receipt.savedCount;
    nativeFailedCount.current=receipt.failedCount;
    if(committed){
     setConfirmedSeq(receipt.versionSeq);
     if(changeNumber.current===revision){
      dirty.current=false;
      setSaveState("saved");
      setSaveMessage("已保存至文档库 · v"+receipt.versionSeq);
      toast.success("文档已保存至文档库 · v"+receipt.versionSeq);
     }else{
      setSaveState("dirty");
      setSaveMessage("新修改待保存");
     }
    }else if(failed){
     setSaveState("failed");
     setSaveMessage("保存失败，请重试编辑器左上角的保存");
     toast.error("保存失败，请重试编辑器左上角的保存");
    }
   }catch{
    if(active){setSaveState("failed");setSaveMessage("无法确认服务器保存状态，请检查网络");}
   }finally{
    inFlight=false;
    if(queued&&active){queued=false;void check();}
   }
  };
  receiptProbe.current=()=>void check();
  const onChange=({id}: {id?:string})=>{
   if(id&&id!==file.id)return;
   void check();
  };
  const unobserveFile=observeResourceChange("file",onChange);
  const unobserveWorkspace=observeWorkspaceChange(()=>void check(),["file"]);
  // Check immediately on focus return, including when the editor temporarily
  // masks the page or the browser was put to sleep during a save.
  const focus=()=>void check();
  window.addEventListener("focus",focus);
  const timer=window.setInterval(()=>void check(),1200);
  return()=>{
   active=false;
   if(receiptProbe.current)receiptProbe.current=null;
   unobserveFile();unobserveWorkspace();
   window.removeEventListener("focus",focus);
   window.clearInterval(timer);
  };
 },[file,sessionId]);

 async function close(){
  if(dirty.current&&!window.confirm("修改尚未确认保存。确定要放弃修改并退出吗？"))return;
  try{
   if(sessionId)await fileApi.cancelOfficeSession(file?.id??"",sessionId);
  }catch{
   setSaveState("failed");
   setSaveMessage("结束编辑失败，请重试以免会话状态丢失");
   toast.error("结束编辑失败，请重试");
   return;
  }
  navigate("/preview/"+encodeURIComponent(id));
 }

 async function saveNewVersion(){
  if(status!=="ready"||!sessionId||!file)return;
  setSaveMessage("● 正在保存...");
  try{
   const result=await fileApi.requestOfficeSave(file.id,sessionId);
   if(result.status==="unchanged"){setSaveMessage("● 尚未修改");setSaveState("clean");}
   else{setSaveMessage("● 保存请求已发送，正在确认新版本");receiptProbe.current?.();}
  }catch(err){setSaveState("failed");setSaveMessage(errorCopy(err,"保存失败"));}
 }
 async function convertPDF(){
  if(!file||exporting)return;
  if(dirty.current){
   toast.info("请先保存修改，再转换为 PDF");return;
  }
  setExporting(true);
  try{
   const meta=await fileApi.meta(file.id);
   const result=await toast.track(()=>fileApi.convertFormat(file.id,"pdf",meta.file.currentVersionSeq,meta.file.sha256,newIdempotencyKey()),{
    loading:"正在转换 PDF…",success:"PDF 转换完成",error:e=>errorCopy(e,"PDF 转换失败")
   });
   navigate("/preview/"+encodeURIComponent(result.fileId));
  }catch{/* toast.track already provides feedback */}
  finally{setExporting(false);}
 }
 return <div className="office-workbench">
  <header className="office-workbench-toolbar">
   <div className="office-workbench-identity">
    <RareButton type="button" className="office-workbench-back" onClick={()=>void close()}>← 返回预览</RareButton>
    <span className="office-workbench-divider" aria-hidden="true"/>
    <FileTypeIcon name={file?.name??"document.docx"} size={20}/>
    <strong title={file?.name}>{file?.name??"正在获取文档"}</strong>
    <span className="office-workbench-version">v{confirmedSeq??file?.currentVersionSeq??"—"}</span>
    <span role="status" aria-live="polite" className={"office-save-state office-save-"+saveState}>{saveMessage}</span>
   </div>
   <div className="office-workbench-actions">
    <RareButton type="button" disabled={status==="loading"||exporting||!file} loading={exporting} onClick={()=>void convertPDF()}>⇄ 转为 PDF</RareButton>
    <RareButton type="button" className="primary" disabled={status!=="ready"} onClick={()=>void saveNewVersion()}>保存新版本</RareButton>
    <RareButton type="button" tone="ghost" onClick={()=>void close()}>结束编辑</RareButton>
   </div>
  </header>
  <main className="office-workbench-content">
   {file&&<div id="placeholder" ref={holder} className="office-holder">
    <div id="docx-editor-target"/>
    {status==="loading"&&<div className="office-loading-cover" role="status"><BrandLoadingLabel size="sm">正在检测 Office 编辑器…</BrandLoadingLabel></div>}
    {status==="failed"&&<div className="office-loading-cover office-loading-failed" role="alert">
     <strong>无法连接 ONLYOFFICE</strong>
     <span>{message||"文档编辑服务暂不可用，请稍后重试"}</span>
     <RareButton type="button" onClick={()=>window.location.reload()}>重新连接 ONLYOFFICE</RareButton>
    </div>}
   </div>}
   {status==="failed"&&!file&&<div className="office-native-state" role="alert">
    {message||"文档信息暂不可用"}<RareButton type="button" onClick={()=>window.location.reload()}>重试</RareButton>
   </div>}
  </main>
 </div>;
}

// Browser traffic from the new HTTPS frontend must never load HTTP editor
// scripts or iframes. Backend callbacks/downloads continue using the pinned
// internal editor URL, independent of this browser-only URL selection.
function editorBrowserUrl(internalUrl:string):string{
 if(window.location.protocol==="https:"&&window.location.port==="18443"){
  return "https://"+window.location.hostname+":18444";
 }
 if(window.location.protocol==="http:"&&window.location.port==="18091"){
  return "http://"+window.location.hostname+":18080";
 }
 return internalUrl.replace(/\/$/,"");
}

let pendingOfficeScript:Promise<void>|null=null;
let pendingOfficeScriptURL="";
function loadEditorScript(src:string):Promise<void>{
 if(window.DocsAPI?.DocEditor)return Promise.resolve();
 if(pendingOfficeScript&&pendingOfficeScriptURL===src)return pendingOfficeScript;
 pendingOfficeScriptURL=src;
 pendingOfficeScript=new Promise<void>((resolve,reject)=>{
  const existing=document.querySelector(`script[src="${src}"]`) as HTMLScriptElement|null;
  const script=existing??document.createElement("script");
  let settled=false;
  const cleanup=()=>{window.clearTimeout(timeout);script.removeEventListener("load",loaded);script.removeEventListener("error",failed);};
  const finish=(error?:Error)=>{
   if(settled)return;
   settled=true;
   cleanup();
   if(error){script.remove();reject(error);}else resolve();
  };
  const loaded=()=>finish(window.DocsAPI?.DocEditor?undefined:new Error("编辑器脚本未提供 DocsAPI"));
  const failed=()=>finish(new Error("Office 编辑器脚本加载失败"));
  const timeout=window.setTimeout(()=>finish(new Error("ONLYOFFICE 脚本加载超时，请检查编辑服务连接")),15000);
  script.addEventListener("load",loaded);
  script.addEventListener("error",failed);
  if(!existing){script.src=src;document.head.appendChild(script);}
 }).catch(error=>{pendingOfficeScript=null;throw error;});
 return pendingOfficeScript;
}
