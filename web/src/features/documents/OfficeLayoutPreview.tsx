import {useEffect,useState} from "react";
import {RareButton} from "../../shared/ui/rare";
import type {StructuredPreview} from "../../entities/file/model";
import {StructuredFilePreview} from "./StructuredFilePreview";
import "./officeLayoutPreview.css";

// The PDF is a derived preview with the *preview* ACL. Never fetch /bytes:
// read-only recipients should not need original-download permission.
export function OfficeLayoutPreview({fileId,sha,structured}:{
 fileId:string;sha:string;structured:StructuredPreview;
}){
 const[mode,setMode]=useState<"pages"|"content">("pages");
 const[status,setStatus]=useState<"loading"|"ready"|"failed">("loading");
 const[url,setUrl]=useState("");
 useEffect(()=>{
  let active=true;
  const controller=new AbortController();
  let blobURL="";
  setUrl("");setStatus("loading");setMode("pages");
  (async()=>{
   try {
    const res=await fetch("/api/files/"+encodeURIComponent(fileId)+"/preview/office-pdf?v="+encodeURIComponent(sha),{
     credentials:"same-origin",signal:controller.signal,
    });
    if(!res.ok || !res.headers.get("Content-Type")?.startsWith("application/pdf")) throw new Error("conversion unavailable");
    const declared=Number(res.headers.get("Content-Length")??"0");
    if(declared>32*1024*1024)throw new Error("converted preview too large");
    const bytes=await res.arrayBuffer();
    if(bytes.byteLength>32*1024*1024)throw new Error("converted preview too large");
    if(!active || controller.signal.aborted)return;
    blobURL=URL.createObjectURL(new Blob([bytes],{type:"application/pdf"}));
    setUrl(blobURL);setStatus("ready");
   }catch(error){
    if(active && !controller.signal.aborted){setStatus("failed");setMode("content");}
   }
  })();
  return()=>{active=false;controller.abort();if(blobURL)URL.revokeObjectURL(blobURL);};
 },[fileId,sha]);
 return <div className="office-layout-preview">
  <div className="office-layout-tools preview-reader-dock" role="group" aria-label="Office 阅读工具">
   <div className="office-layout-switch" aria-label="预览模式">
    <RareButton type="button" aria-pressed={mode==="pages"} disabled={status!=="ready"} onClick={()=>setMode("pages")}>页面布局</RareButton>
    <RareButton type="button" aria-pressed={mode==="content"} onClick={()=>setMode("content")}>内容摘要</RareButton>
   </div>
  </div>
  {status==="loading"&&<p className="office-layout-notice" role="status">正在安全转换为页面预览，可先查看内容摘要。</p>}
  {status==="failed"&&<p className="office-layout-notice" role="status">当前文件无法生成页面预览，已回退到只读内容摘要。原始文件未被修改。</p>}
  {status==="ready"&&mode==="pages"&&url?
   <div className="office-layout-pdf"><iframe title="Office 页面预览" src={url} referrerPolicy="no-referrer"/></div>:
   <StructuredFilePreview value={structured}/>}
 </div>;
}
