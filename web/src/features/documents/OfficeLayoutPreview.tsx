import {useEffect,useState} from "react";
import {RareButton} from "../../shared/ui/rare";
import {BrandLoader} from "../../shared/ui/BrandLoader";
import {fileApi} from "./api";
import type {StructuredPreview} from "../../entities/file/model";
import {StructuredFilePreview} from "./StructuredFilePreview";
import "./officeLayoutPreview.css";

// Office is converted to PDF on the server and rasterized there into PNG
// pages. Native PDF iframes may trigger downloads in Edge (PDF viewer off);
// previews must never invoke the browser's download handler or /bytes.
export function OfficeLayoutPreview({fileId,sha,structured}:{
 fileId:string;sha:string;structured:StructuredPreview;
}){
 const[mode,setMode]=useState<"pages"|"content">("pages");
 const[status,setStatus]=useState<"loading"|"ready"|"failed">("loading");
 const[pages,setPages]=useState(0);
 const[page,setPage]=useState(1);
 const[retry,setRetry]=useState(0);
 const[pageRetry,setPageRetry]=useState(0);
 const[pageLoaded,setPageLoaded]=useState(false);
 const[pageFailed,setPageFailed]=useState(false);
 const[zoom,setZoom]=useState(1);
 useEffect(()=>{
  let active=true;
  setStatus("loading");setMode("pages");setPages(0);setPage(1);
  setPageLoaded(false);setPageFailed(false);setZoom(1);
  void fileApi.officePages(fileId,sha).then(result=>{
   if(!active)return;
   if(!Number.isInteger(result.pageCount)||result.pageCount<1){
    setStatus("failed");return;
   }
   setPages(result.pageCount);setStatus("ready");
  }).catch(()=>{if(active)setStatus("failed");});
  return()=>{active=false;};
 },[fileId,sha,retry]);
 const imageURL=fileApi.officePageUrl(fileId,sha,page)+(pageRetry?"&retry="+pageRetry:"");
 function changePage(next:number){
  if(next<1||next>pages||next===page)return;
  setPage(next);setPageLoaded(false);setPageFailed(false);
 }
 function retryPage(){setPageRetry(n=>n+1);setPageLoaded(false);setPageFailed(false);}
 return <div className="office-layout-preview">
  <div className="office-layout-tools preview-reader-dock" role="group" aria-label="Office 阅读工具">
   <div className="office-layout-switch" aria-label="预览模式">
    <RareButton type="button" aria-pressed={mode==="pages"} onClick={()=>setMode("pages")}>页面布局</RareButton>
    <RareButton type="button" aria-pressed={mode==="content"} onClick={()=>setMode("content")}>内容摘要</RareButton>
   </div>
   {mode==="pages"&&status==="ready"&&<div className="office-layout-page-controls">
    <RareButton type="button" disabled={page<=1} onClick={()=>changePage(page-1)}>上一页</RareButton>
    <span aria-live="polite">{page} / {pages}</span>
    <RareButton type="button" disabled={page>=pages} onClick={()=>changePage(page+1)}>下一页</RareButton>
    <RareButton type="button" aria-label="缩小页面" disabled={zoom<=0.5} onClick={()=>setZoom(v=>Math.max(.5,Math.round(v/1.25*100)/100))}>−</RareButton>
    <span>{Math.round(zoom*100)}%</span>
    <RareButton type="button" aria-label="放大页面" disabled={zoom>=2.5} onClick={()=>setZoom(v=>Math.min(2.5,Math.round(v*1.25*100)/100))}>＋</RareButton>
   </div>}
  </div>
  {mode==="content"?<div className="office-layout-outline" aria-label="只读内容摘要">
   <StructuredFilePreview value={structured}/>
  </div>:status==="ready"?<div className="office-layout-pdf" aria-label="Office 页面预览">
   {!pageLoaded&&!pageFailed&&<div className="office-layout-page-loading" role="status"><BrandLoader size="lg" decorative/><span>正在渲染第 {page} 页…</span></div>}
   {pageFailed?<div className="office-layout-page-loading" role="alert">
    <span>页面渲染失败</span><RareButton type="button" onClick={retryPage}>重试此页</RareButton>
   </div>:<img key={imageURL} src={imageURL} alt={"第 "+page+" 页"} aria-hidden={!pageLoaded}
    style={{width:(zoom*100)+"%",visibility:pageLoaded?"visible":"hidden"}}
    onLoad={()=>setPageLoaded(true)} onError={()=>setPageFailed(true)}/>}
  </div>:<div className="office-layout-state" role="status" aria-live="polite">
   {status==="loading"?<>
    <BrandLoader size="lg" decorative/><span>正在生成页面布局…</span>
   </>:<>
    <strong>页面布局暂时不可用</strong>
    <RareButton type="button" className="primary" onClick={()=>setRetry(n=>n+1)}>重试页面预览</RareButton>
   </>}
  </div>}
 </div>;
}
