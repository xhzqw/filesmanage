import {useEffect,useState} from "react";
import {RareButton} from "../../shared/ui/rare";
import {BrandLoader} from "../../shared/ui/BrandLoader";
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
 const[retry,setRetry]=useState(0);
 const[error,setError]=useState("");
 useEffect(()=>{
  let active=true;
  const controller=new AbortController();
  let blobURL="";
  setUrl("");setStatus("loading");setError("");setMode("pages");
  (async()=>{
   try {
    const res=await fetch("/api/files/"+encodeURIComponent(fileId)+"/preview/office-pdf?v="+encodeURIComponent(sha),{
     credentials:"same-origin",signal:controller.signal,
    });
    if(!res.ok)throw new Error("HTTP "+res.status);
    if(!res.headers.get("Content-Type")?.toLowerCase().startsWith("application/pdf"))
     throw new Error("响应不是 PDF");
    const declared=Number(res.headers.get("Content-Length")??"0");
    if(declared>32*1024*1024)throw new Error("converted preview too large");
    const bytes=await res.arrayBuffer();
    if(bytes.byteLength>32*1024*1024)throw new Error("转换后的文件过大");
    if(bytes.byteLength<8||new TextDecoder().decode(bytes.slice(0,5))!=="%PDF-")
     throw new Error("无效的 PDF 页面");
    if(!active || controller.signal.aborted)return;
    blobURL=URL.createObjectURL(new Blob([bytes],{type:"application/pdf"}));
    setUrl(blobURL);setStatus("ready");
   }catch(cause){
    // Do not silently replace a paged document with a flattened outline.
    // Only the user can explicitly choose the limited content summary.
    if(active && !controller.signal.aborted){
     setStatus("failed");
     setError(cause instanceof Error&&/^HTTP \d{3}$/.test(cause.message)?cause.message:"页面转换失败");
    }
   }
  })();
  return()=>{active=false;controller.abort();if(blobURL)URL.revokeObjectURL(blobURL);};
 },[fileId,sha,retry]);
 return <div className="office-layout-preview">
  <div className="office-layout-tools preview-reader-dock" role="group" aria-label="Office 阅读工具">
   <div className="office-layout-switch" aria-label="预览模式">
    <RareButton type="button" aria-pressed={mode==="pages"} onClick={()=>setMode("pages")}>页面布局</RareButton>
    <RareButton type="button" aria-pressed={mode==="content"} onClick={()=>setMode("content")}>内容摘要</RareButton>
   </div>
  </div>
  {mode==="content"?<div className="office-layout-outline" aria-label="只读内容摘要">
   <StructuredFilePreview value={structured}/>
  </div>:status==="ready"&&url?
   <div className="office-layout-pdf"><iframe title="Office 页面预览" src={url+"#view=Fit"} referrerPolicy="no-referrer"/></div>:
   <div className="office-layout-state" role="status" aria-live="polite">
    {status==="loading"?<>
     <BrandLoader size="lg" decorative/>
     <span>正在生成页面布局…</span>
    </>:<>
     <strong>页面布局暂时不可用</strong>
     <span>{error==="HTTP 503"?"转换服务暂时繁忙":error==="HTTP 413"?"文件超过转换限制":error.startsWith("HTTP")?"页面生成请求失败":error}</span>
     <RareButton type="button" className="primary" onClick={()=>setRetry(n=>n+1)}>重试页面预览</RareButton>
    </>}
   </div>}
 </div>;
}
