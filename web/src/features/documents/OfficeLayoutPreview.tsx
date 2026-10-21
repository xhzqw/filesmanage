import {useEffect,useRef,useState} from "react";
import {RareButton} from "../../shared/ui/rare";
import {BrandLoader} from "../../shared/ui/BrandLoader";
import {ReaderPageChevron} from "../../shared/ui/ReaderPageChevron";
import {ContinuousPageStack,type ContinuousPageHandle} from "./ContinuousPageStack";
import {fileApi} from "./api";
import type {StructuredPreview} from "../../entities/file/model";
import {StructuredFilePreview} from "./StructuredFilePreview";
import "./officeLayoutPreview.css";

// Server-generated page images are mounted only for the visible reading window.
export function OfficeLayoutPreview({fileId,sha,structured}:{
 fileId:string;sha:string;structured:StructuredPreview;
}){
 const[mode,setMode]=useState<"pages"|"content">("pages");
 const[status,setStatus]=useState<"loading"|"ready"|"failed">("loading");
 const[pages,setPages]=useState(0);
 const[page,setPage]=useState(1);
 const[retry,setRetry]=useState(0);
 const[zoom,setZoom]=useState(1);
 const stackRef=useRef<ContinuousPageHandle>(null);
 useEffect(()=>{
  let active=true;
  setStatus("loading");setMode("pages");setPages(0);setPage(1);setZoom(1);
  void fileApi.officePages(fileId,sha).then(result=>{
   if(!active)return;
   if(!Number.isInteger(result.pageCount)||result.pageCount<1){setStatus("failed");return;}
   setPages(result.pageCount);setStatus("ready");
  }).catch(()=>{if(active)setStatus("failed");});
  return()=>{active=false;};
 },[fileId,sha,retry]);
 function goToPage(next:number){stackRef.current?.goToPage(next);}
 return <div className="office-layout-preview">
  <div className="office-layout-tools preview-reader-dock" role="group" aria-label="Office 阅读工具">
   <div className="office-layout-switch" aria-label="预览模式">
    <RareButton type="button" aria-pressed={mode==="pages"} onClick={()=>setMode("pages")}>页面布局</RareButton>
    <RareButton type="button" aria-pressed={mode==="content"} onClick={()=>setMode("content")}>内容摘要</RareButton>
   </div>
   {mode==="pages"&&status==="ready"&&<div className="office-layout-page-controls">
    <span className="preview-dock-divider" aria-hidden="true"/>
    <RareButton type="button" className="reader-chevron" aria-label="定位到上一页" title="定位到上一页" disabled={page<=1} onClick={()=>goToPage(page-1)}><ReaderPageChevron direction="previous"/></RareButton>
    <span className="preview-dock-page-count" aria-live="polite" title="滚轮连续阅读">{page} / {pages}</span>
    <RareButton type="button" className="reader-chevron" aria-label="定位到下一页" title="定位到下一页" disabled={page>=pages} onClick={()=>goToPage(page+1)}><ReaderPageChevron direction="next"/></RareButton>
    <span className="preview-dock-divider" aria-hidden="true"/>
    <div className="office-layout-zoom-controls" role="group" aria-label="页面缩放">
     <RareButton type="button" aria-label="缩小页面" disabled={zoom<=0.5} onClick={()=>setZoom(v=>Math.max(.5,Math.round(v/1.25*100)/100))}>−</RareButton>
     <span className="preview-dock-zoom-value">{Math.round(zoom*100)}%</span>
     <RareButton type="button" aria-label="放大页面" disabled={zoom>=2.5} onClick={()=>setZoom(v=>Math.min(2.5,Math.round(v*1.25*100)/100))}>＋</RareButton>
    </div>
   </div>}
  </div>
  {mode==="content"?<div className="office-layout-outline" aria-label="只读内容摘要">
   <StructuredFilePreview value={structured}/>
  </div>:status==="ready"?<ContinuousPageStack key={fileId+":"+sha} ref={stackRef}
   className="office-layout-pdf" label="Office 连续滚动页面预览" pages={pages}
   zoom={zoom} onPageChange={setPage} imageLabel={number=>"第 "+number+" 页"}
   pageUrl={(number,attempt)=>fileApi.officePageUrl(fileId,sha,number)+(attempt?"&retry="+attempt:"")}/>
  :<div className="office-layout-state" role="status" aria-live="polite">
   {status==="loading"?<><BrandLoader size="lg" decorative/><span>正在生成页面布局…</span></>:<>
    <strong>页面布局暂时不可用</strong>
    <RareButton type="button" className="primary" onClick={()=>setRetry(n=>n+1)}>重试页面预览</RareButton>
   </>}
  </div>}
 </div>;
}
