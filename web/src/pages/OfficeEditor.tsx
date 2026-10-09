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
  DocsAPI?:{DocEditor?:new (id:string,config:{token:string})=>unknown};
 }
}

// Loads the external document editor inside the page. This is the real
// ONLYOFFICE editor: the iframe renders and edits the actual DOCX bytes, and
// saves arrive through the server-side callback.
export function OfficeEditor({user,onLogout}:{user:User;onLogout:()=>void}){
 const{id=""}=useParams();
 const[status,setStatus]=useState("loading");
 const[message,setMessage]=useState("");
 const[file,setFile]=useState<FileItem|null>(null);
 const[sessionId,setSessionId]=useState("");
 const holder=useRef<HTMLDivElement>(null);

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
  fileApi.openOfficeSession(file.id)
   .then(async session=>{
    if(!valid)return;
    const opened=session as OfficeSessionData;
    setSessionId(opened.sessionId);
    await loadEditorScript(opened.editorUrl+"/web-apps/apps/api/documents/api.js");
    if(!valid||!holder.current)return;
    // The server returns the full editor config with its signed token; the
    // editor validates the signature server-side.
    const DocEditor=window.DocsAPI?.DocEditor;
    if(!DocEditor)throw new Error("editor api unavailable");
    new DocEditor("docx-editor-target",opened.config as {token:string});
    setStatus("ready");
   })
   .catch(error=>{
    if(!valid)return;
    setStatus("failed");
    setMessage(errorCopy(error,"无法启动编辑器"));
   });
  return()=>{valid=false;};
 },[file]);

 async function close(){
  try{
   if(sessionId)await fileApi.cancelOfficeSession(file?.id??"",sessionId);
  }catch{/* closing is best-effort */}
  window.location.href="/preview/"+id;
 }

 return <AppShell user={user} onLogout={onLogout} product="文档编辑" actions={<button type="button" onClick={close}>结束编辑</button>}>
  <div className="office-stage">
   {file&&<div className="breadcrumb">{file.name} · 当前 v{file.currentVersionSeq}</div>}
   {status==="loading"&&<p className="empty">正在启动文档编辑器…</p>}
   {status==="failed"&&<p role="alert" className="notice error">{message}</p>}
   <div id="placeholder" ref={holder} className="office-holder">
    <div id="docx-editor-target"/>
   </div>
  </div>
 </AppShell>;
}

function loadEditorScript(src:string):Promise<void>{
 const existing=document.querySelector(`script[src="${src}"]`) as HTMLScriptElement|null;
 if(existing){
  if(window.DocsAPI?.DocEditor)return Promise.resolve();
  const{promise,resolve}=Promise.withResolvers<void>();
  existing.addEventListener("load",()=>resolve());
  return promise;
 }
 const{promise,resolve,reject}=Promise.withResolvers<void>();
 const script=document.createElement("script");
 script.src=src;
 script.onload=()=>resolve();
 script.onerror=()=>reject(new Error("editor script failed to load"));
 document.head.appendChild(script);
 return promise;
}
