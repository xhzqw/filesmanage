import {useEffect,useRef,useState} from "react";
import {RareButton,RareSelect} from "../../shared/ui/rare";
import {BrandLoader} from "../../shared/ui/BrandLoader";
import {ReaderPageChevron} from "../../shared/ui/ReaderPageChevron";
import {errorCopy} from "../../shared/errors";
import {ContinuousPageStack,type ContinuousPageHandle} from "./ContinuousPageStack";
import {fileApi,type SealHistory} from "./api";
import "./pdfPageViewer.css";

// PDF page rasterization stays server-side and ACL-checked. Pages are only
// requested around the visible viewport, not in a full-document burst.
export function PDFPageViewer({fileId,sha,name,seq,revision,onRevisionChange,epoch,requestedPage,onPageChange}:{
 fileId:string;sha:string;name:string;seq:number;revision:number|null;epoch:number;onRevisionChange:(value:number|null)=>void;
 requestedPage?:number;onPageChange?:(page:number)=>void;
}){
 const[pages,setPages]=useState(0);
 const[history,setHistory]=useState<SealHistory|null>(null);
 const[page,setPage]=useState(1);
 const[loading,setLoading]=useState(true);
 const[error,setError]=useState("");
 const[retry,setRetry]=useState(0);
 const[zoom,setZoom]=useState(1);
 const[fitMode,setFitMode]=useState<"page"|"width">("page");
 const[panMode,setPanMode]=useState(false);
 const stackRef=useRef<ContinuousPageHandle>(null);
 useEffect(()=>{
  let live=true;setHistory(null);
  fileApi.sealHistory(fileId,seq).then(value=>{if(live)setHistory(value);})
   .catch(cause=>{if(live)setError(errorCopy(cause,"无法加载签章历史"));});
  return()=>{live=false;};
 },[fileId,seq,epoch]);
 useEffect(()=>{onPageChange?.(page);},[page,onPageChange]);
 useEffect(()=>{
  let live=true;setPages(0);setPage(1);setLoading(true);setError("");
  fileApi.pdfPages(fileId,sha).then(data=>{
   if(!live)return;
   if(!Number.isInteger(data.pageCount)||data.pageCount<1)setError("该 PDF 没有可预览的页面");
   else setPages(data.pageCount);
   setLoading(false);
  }).catch(cause=>{if(live){setError(errorCopy(cause,"PDF 页面预览失败"));setLoading(false);}});
  return()=>{live=false;};
 },[fileId,sha,retry]);
 useEffect(()=>{setZoom(1);setFitMode("page");setPanMode(false);},[fileId,sha]);
 useEffect(()=>{
  if(requestedPage&&requestedPage>=1&&requestedPage<=pages)stackRef.current?.goToPage(requestedPage);
 },[requestedPage,pages]);
 const documentKey=fileId+":"+sha+":"+(revision===null?"latest":revision)+":"+epoch;
 const goToPage=(next:number)=>stackRef.current?.goToPage(next);
 return <div className="file-pdf-viewer">
  <div className="file-pdf-toolbar">
   <strong>PDF 预览</strong>
   <div className="file-pdf-tools">
    <div className="file-pdf-view-controls" role="group" aria-label="PDF 视图模式">
     {history&&history.current>0&&<RareSelect aria-label="预览签章版本" value={revision===null?"latest":String(revision)}
      onChange={event=>onRevisionChange(event.target.value==="latest"?null:Number(event.target.value))}>
      <option value="latest">当前签章 · r{history.current}</option>
      {history.revisions.map(item=><option key={item.revision} value={item.revision}>
       {item.revision===0?"原始未签章":("签章 r"+item.revision+" · "+item.markCount+" 枚")}
      </option>)}
     </RareSelect>}
     <span className="preview-dock-divider" aria-hidden="true"/>
     <RareButton type="button" title="切换整页 / 页宽适配" aria-label={"PDF 适配方式："+(fitMode==="page"?"整页":"页宽")+"，点击切换"}
      onClick={()=>{setFitMode(mode=>mode==="page"?"width":"page");setZoom(1);}}>
      {fitMode==="page"?"整页":"页宽"}</RareButton>
     <RareButton type="button" aria-pressed={panMode} onClick={()=>setPanMode(v=>!v)}>{panMode?"结束平移":"平移"}</RareButton>
    </div>
    <span className="preview-dock-divider" aria-hidden="true"/>
    <div className="file-pdf-pagination" role="group" aria-label="PDF 页面位置">
     <RareButton type="button" className="reader-chevron" aria-label="定位到上一页" disabled={!pages||page<=1} onClick={()=>goToPage(page-1)}><ReaderPageChevron direction="previous"/></RareButton>
     <span className="preview-dock-page-count" aria-live="polite" title="滚轮连续阅读">{pages?page+" / "+pages:"—"}</span>
     <RareButton type="button" className="reader-chevron" aria-label="定位到下一页" disabled={!pages||page>=pages} onClick={()=>goToPage(page+1)}><ReaderPageChevron direction="next"/></RareButton>
    </div>
    <span className="preview-dock-divider" aria-hidden="true"/>
    <div className="file-pdf-zoom-controls" role="group" aria-label="PDF 缩放">
     <RareButton type="button" aria-label="缩小 PDF" disabled={zoom<=0.5} onClick={()=>setZoom(v=>Math.max(.5,Math.round(v/1.25*100)/100))}>−</RareButton>
     <span className="preview-dock-zoom-value">{Math.round(zoom*100)}%</span>
     <RareButton type="button" aria-label="放大 PDF" disabled={zoom>=5} onClick={()=>setZoom(v=>Math.min(5,Math.round(v*1.25*100)/100))}>＋</RareButton>
    </div>
   </div>
  </div>
  {loading&&<div className="file-pdf-paper is-pending" aria-busy="true">
   <div className="file-pdf-placeholder" role="status" aria-label="正在加载 PDF 页面"><BrandLoader size="lg" decorative/></div>
  </div>}
  {error&&<div className="file-pdf-message"><p role="alert">{error}</p><RareButton type="button" onClick={()=>setRetry(i=>i+1)}>重试</RareButton></div>}
  {pages>0&&!error&&<ContinuousPageStack key={documentKey} ref={stackRef}
   pages={pages} className="file-pdf-paper" label="PDF 连续滚动页面预览"
   zoom={zoom} fitMode={fitMode} panMode={panMode} onPageChange={setPage}
   imageLabel={number=>name+" 第 "+number+" 页"}
   pageUrl={(number,attempt)=>fileApi.pdfPageUrl(fileId,sha,number,revision)+"&sealEpoch="+epoch+(attempt?"&attempt="+attempt:"")}/>}
 </div>;
}
