import {useEffect,useRef,useState} from "react";
import {useParams,Link} from "react-router-dom";
import {fileApi} from "../features/documents/api";
import {errorCopy} from "../shared/errors";
import type {OfficeSessionData} from "../features/documents/api";
import type {FileItem} from "../entities/file/model";

declare global{
 interface Window{
  DocsAPI?:{DocEditor?:new (id:string,config:{token:string})=>unknown};
 }
}

// Loads the external document editor inside the page. This is the real
// ONLYOFFICE editor: the iframe renders and edits the actual DOCX bytes, and
// saves arrive through the server-side callback.
export function OfficeEditor(){
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
    new DocEditor("placeholder",opened.config as {token:string});
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

 return <div className="shell">
  <header className="header">
   <div className="brand"><span className="logo-placeholder" aria-label="官方 Logo 尚未导入">标志待入库</span>中晟生物科技 <span className="product">文档编辑</span></div>
   <nav aria-label="主导航"><Link to={"/preview/"+id}>返回预览</Link><Link to="/doc">文档管理</Link></nav>
   <span className="account">{file?.name??""}</span>
   <button onClick={close}>结束编辑</button>
  </header>
  <div className="office-stage">
   {status==="loading"&&<p className="empty">正在启动文档编辑器…</p>}
   {status==="failed"&&<p role="alert" className="notice error">{message}</p>}
   <div id="placeholder" ref={holder} className="office-holder"/>
  </div>
 </div>;
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
