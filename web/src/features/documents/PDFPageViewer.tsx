import {useEffect,useState} from "react";
import {RareButton} from "../../shared/ui/rare";
import {errorCopy} from "../../shared/errors";
import {fileApi} from "./api";
import "./pdfPageViewer.css";

// PDF rasterization is server-side and checked against current preview ACL.
// Do not embed the Chrome PDF extension in a sandboxed iframe.
export function PDFPageViewer({fileId,sha,name,onSign}:{
 fileId:string;sha:string;name:string;onSign:()=>void;
}){
 const[pages,setPages]=useState(0);
 const[page,setPage]=useState(1);
 const[loading,setLoading]=useState(true);
 const[imageReady,setImageReady]=useState(false);
 const[error,setError]=useState("");
 const[retry,setRetry]=useState(0);
 useEffect(()=>{
  let live=true;setPages(0);setPage(1);setLoading(true);setImageReady(false);setError("");
  fileApi.pdfPages(fileId,sha).then(data=>{
   if(live){setPages(data.pageCount);setLoading(false);}
  }).catch(cause=>{if(live){setError(errorCopy(cause,"PDF 页面预览失败"));setLoading(false);}});
  return()=>{live=false};
 },[fileId,sha,retry]);
 const url=fileApi.pdfPageUrl(fileId,sha,page);
 return <div className="file-pdf-viewer">
  <div className="file-pdf-toolbar">
   <strong>PDF 预览</strong>
   <div className="file-pdf-tools">
    <RareButton type="button" disabled={!pages||page===1} onClick={()=>{setPage(i=>i-1);setImageReady(false)}}>上一页</RareButton>
    <span aria-live="polite">{pages?"第 "+page+" / "+pages+" 页":"—"}</span>
    <RareButton type="button" disabled={!pages||page>=pages} onClick={()=>{setPage(i=>i+1);setImageReady(false)}}>下一页</RareButton>
    <RareButton type="button" className="primary" onClick={onSign}>签名 / 盖章</RareButton>
   </div>
  </div>
  {loading&&<p className="file-pdf-message" role="status">正在加载 PDF 页面…</p>}
  {error&&<div className="file-pdf-message"><p role="alert">{error}</p><RareButton type="button" onClick={()=>setRetry(i=>i+1)}>重试</RareButton></div>}
  {pages>0&&!error&&<div className="file-pdf-paper">
   {!imageReady&&<p className="file-pdf-message" role="status">正在渲染第 {page} 页…</p>}
   <img key={url} src={url} alt={name+" 第 "+page+" 页"} onLoad={()=>setImageReady(true)} onError={()=>{setImageReady(false);setError("该页渲染失败，请重试或下载原始 PDF。")}}/>
  </div>}
 </div>;
}
