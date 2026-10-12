import {RareButton} from "../shared/ui/rare";
import {useEffect,useRef,useState} from "react";
import {useParams} from "react-router-dom";
import {fileApi} from "../features/documents/api";
import {errorCopy} from "../shared/errors";
import type {OfficeSessionData} from "../features/documents/api";
import type {FileItem} from "../entities/file/model";
import type {User} from "../entities/user/model";
import {AppShell} from "../shared/ui/AppShell";

declare global{
 interface Window{
  DocsAPI?:{DocEditor?:new (id:string,config:Record<string,unknown>)=>{destroyEditor?:()=>void}};
 }
}

type EditorStatus="loading"|"ready"|"failed";
type SaveState="clean"|"dirty"|"saved"|"failed";

// Only the application's callback receipt, followed by a committed file
// version, can make the UI say "saved". The editor's cache sync is not a save.
export function OfficeEditor({user,onLogout}:{user:User;onLogout:()=>void}){
 const{id=""}=useParams();
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
  let waitForDocument:number|undefined;
  setStatus("loading");
  fileApi.openOfficeSession(file.id)
   .then(async session=>{
    if(!valid)return;
    const opened=session as OfficeSessionData;
    setSessionId(opened.sessionId);
    // Capture the current server receipts before the user can edit.
    const initial=await fileApi.officeNativeSaveStatus(file.id,opened.sessionId);
    if(!valid)return;
    nativeSavedCount.current=initial.savedCount;
    nativeFailedCount.current=initial.failedCount;
    await loadEditorScript(editorBrowserUrl(opened.editorUrl)+"/web-apps/apps/api/documents/api.js");
    if(!valid||!holder.current)return;
    const DocEditor=window.DocsAPI?.DocEditor;
    if(!DocEditor)throw new Error("editor api unavailable");
    const events={
     onDocumentReady:()=>{
      if(!valid)return;
      ready=true;
      window.clearTimeout(waitForDocument);
      setStatus("ready");
     },
     onDocumentStateChange:(event:{data?:boolean})=>{
      if(!valid||event.data!==true)return;
      changeNumber.current++;
      dirty.current=true;
      setSaveState("dirty");
      setSaveMessage("有修改未保存至文档库");
     },
     onError:(event:{data?:{errorDescription?:string}})=>{
      if(!valid)return;
      if(!ready){
       window.clearTimeout(waitForDocument);
       setStatus("failed");
       setMessage(event.data?.errorDescription||"文档打开失败，请检查编辑服务");
      }else{
       dirty.current=true;
       setSaveState("failed");
       setSaveMessage("编辑器出现错误，请检查文档后重试保存");
      }
     }
    };
    editor.current=new DocEditor("docx-editor-target",{...opened.config,events});
    waitForDocument=window.setTimeout(()=>{
     if(!valid||ready)return;
     setStatus("failed");
     setMessage("文档加载超时。请检查 ONLYOFFICE 服务和文档源地址，然后重试。");
    },45000);
   })
   .catch(error=>{
    if(!valid)return;
    window.clearTimeout(waitForDocument);
    setStatus("failed");
    setMessage(errorCopy(error,"无法启动编辑器"));
   });
  return()=>{valid=false;window.clearTimeout(waitForDocument);editor.current?.destroyEditor?.();editor.current=null;};
 },[file]);

 // The native floppy-disk Save button triggers status=6 (forcesavetype=1).
 // The app checks its persisted receipt. No second command and no blocking
 // 45-second save overlay are needed.
 useEffect(()=>{
  if(!sessionId||!file)return;
  let active=true;
  let inFlight=false;
  const check=async()=>{
   if(!dirty.current||inFlight)return;
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
     }else{
      setSaveState("dirty");
      setSaveMessage("新修改待保存");
     }
    }else if(failed){
     setSaveState("failed");
     setSaveMessage("保存失败，请重试编辑器左上角的保存");
    }
   }catch{
    if(active){setSaveState("failed");setSaveMessage("无法确认服务器保存状态，请检查网络");}
   }finally{inFlight=false;}
  };
  const timer=window.setInterval(()=>void check(),1200);
  return()=>{active=false;window.clearInterval(timer);};
 },[file,sessionId]);

 async function close(){
  if(dirty.current&&!window.confirm("修改尚未确认保存。确定要放弃修改并退出吗？"))return;
  try{
   if(sessionId)await fileApi.cancelOfficeSession(file?.id??"",sessionId);
  }catch{
   setSaveState("failed");
   setSaveMessage("结束编辑失败，请重试以免会话状态丢失");
   return;
  }
  window.location.href="/preview/"+id;
 }

 const guardedLogout=()=>{
  if(dirty.current&&!window.confirm("修改未保存。确定退出登录并放弃修改吗？"))return;
  onLogout();
 };
 return <AppShell user={user} onLogout={guardedLogout} product="文档编辑" actions={<>
  <RareButton type="button" tone="neutral" onClick={()=>void close()}>结束编辑</RareButton>
 </>}>
  <div className="office-stage">
   <div className="office-edit-strip">
    <span className="office-edit-name">{file?.name??"正在获取文档"} · v{confirmedSeq??file?.currentVersionSeq??"—"}</span>
    <span role="status" aria-live="polite" className={"office-save-state office-save-"+saveState}>{saveMessage}</span>
   </div>
   <div id="placeholder" ref={holder} className="office-holder">
    <div id="docx-editor-target"/>
    {status!=="ready"&&<div className="office-loading-cover" role={status==="failed"?"alert":"status"}>
     {status==="failed"?<><strong>无法打开文档</strong><span>{message}</span><RareButton type="button" onClick={()=>window.location.reload()}>重试</RareButton></>:<span>正在加载 Office 文档…</span>}
    </div>}
   </div>
  </div>
 </AppShell>;
}

// Browser traffic from the new HTTPS frontend must never load HTTP editor
// scripts or iframes. Backend callbacks/downloads continue using the pinned
// internal editor URL, independent of this browser-only URL selection.
function editorBrowserUrl(internalUrl:string):string{
 if(window.location.protocol==="https:"&&window.location.port==="18443"){
  const host=window.location.hostname;
  if(host==="192.168.1.22"||host==="10.144.144.1"||host==="openclaw77"){
   return "https://"+host+":18444";
  }
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
  const timeout=window.setTimeout(()=>finish(new Error("Office 编辑器脚本加载超时")),18000);
  script.addEventListener("load",loaded);
  script.addEventListener("error",failed);
  if(!existing){script.src=src;document.head.appendChild(script);}
 }).catch(error=>{pendingOfficeScript=null;throw error;});
 return pendingOfficeScript;
}
