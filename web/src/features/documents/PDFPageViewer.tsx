import {useEffect,useLayoutEffect,useRef,useState,type PointerEvent} from "react";
import {RareButton,RareSelect} from "../../shared/ui/rare";
import {BrandLoader} from "../../shared/ui/BrandLoader";
import {errorCopy} from "../../shared/errors";
import {fileApi,type SealHistory} from "./api";
import "./pdfPageViewer.css";

// PDF rasterization is server-side and checked against current preview ACL.
// Do not embed the Chrome PDF extension in a sandboxed iframe.
export function PDFPageViewer({fileId,sha,name,seq,revision,onRevisionChange,epoch}:{
 fileId:string;sha:string;name:string;seq:number;revision:number|null;epoch:number;onRevisionChange:(value:number|null)=>void;
}){
 const[pages,setPages]=useState(0);
 const[history,setHistory]=useState<SealHistory|null>(null);
 useEffect(()=>{
  let live=true;setHistory(null);
  fileApi.sealHistory(fileId,seq).then(value=>{if(live)setHistory(value)})
   .catch(cause=>{if(live)setError(errorCopy(cause,"无法加载签章历史"))});
  return()=>{live=false};
 },[fileId,seq,epoch]);

 const[page,setPage]=useState(1);
 const[loading,setLoading]=useState(true);
 const[error,setError]=useState("");
 const[retry,setRetry]=useState(0);
 const[pageError,setPageError]=useState("");
 const[pageRetry,setPageRetry]=useState(0);
 const[displayed,setDisplayed]=useState<{documentKey:string;url:string;page:number}|null>(null);
 useEffect(()=>{
  let live=true;setPages(0);setPage(1);setLoading(true);setDisplayed(null);setError("");setPageError("");setPageRetry(0);
  fileApi.pdfPages(fileId,sha).then(data=>{
   if(live){
    if(!Number.isInteger(data.pageCount)||data.pageCount<1)setError("该 PDF 没有可预览的页面");
    else setPages(data.pageCount);
    setLoading(false);
   }
  }).catch(cause=>{if(live){setError(errorCopy(cause,"PDF 页面预览失败"));setLoading(false);}});
  return()=>{live=false};
 },[fileId,sha,retry]);
 const documentKey=fileId+":"+sha+":"+(revision===null?"latest":revision);
 const url=fileApi.pdfPageUrl(fileId,sha,page,revision)+"&sealEpoch="+epoch+(pageRetry?"&attempt="+pageRetry:"");
 const imageReady=displayed?.documentKey===documentKey&&displayed.url===url;
 const retained=displayed?.documentKey===documentKey&&!imageReady?displayed:null;
 function changePage(next:number){
  if(next<1||next>pages||next===page)return;
  setPage(next);setPageError("");
 }
 const viewportRef=useRef<HTMLDivElement>(null);
 const dragRef=useRef<{x:number;y:number;left:number;top:number}|null>(null);
 const anchorRef=useRef<{zoom:number;x:number;y:number;left:number;top:number}|null>(null);
 const[viewport,setViewport]=useState({width:800,height:740});
 const[pageRatio,setPageRatio]=useState(1.414);
 const[zoom,setZoom]=useState(1);
 const[fitMode,setFitMode]=useState<"page"|"width">("page");
 const[panMode,setPanMode]=useState(false);
 useEffect(()=>{
  const node=viewportRef.current;if(!node)return;
  const measure=()=>setViewport({width:node.clientWidth,height:node.clientHeight});
  measure();
  const observer=new ResizeObserver(measure);observer.observe(node);
  return()=>observer.disconnect();
 },[]);
 useEffect(()=>{setZoom(1);setFitMode("page");setPanMode(false)},[fileId,sha]);
 function setZoomAt(value:number){
  const node=viewportRef.current;
  if(node)anchorRef.current={zoom,x:node.clientWidth/2,y:node.clientHeight/2,left:node.scrollLeft,top:node.scrollTop};
  setZoom(Math.max(.5,Math.min(5,Math.round(value*100)/100)));
 }
 useLayoutEffect(()=>{
  const node=viewportRef.current,anchor=anchorRef.current;
  if(!node||!anchor)return;
  const factor=zoom/anchor.zoom;
  node.scrollLeft=(anchor.left+anchor.x)*factor-anchor.x;
  node.scrollTop=(anchor.top+anchor.y)*factor-anchor.y;
  anchorRef.current=null;
 },[zoom]);
 function panDown(e:PointerEvent<HTMLDivElement>){
  const node=viewportRef.current;
  if(!panMode||e.button!==0||!node)return;
  dragRef.current={x:e.clientX,y:e.clientY,left:node.scrollLeft,top:node.scrollTop};
  node.setPointerCapture(e.pointerId);e.preventDefault();
 }
 function panMove(e:PointerEvent<HTMLDivElement>){
  const node=viewportRef.current,drag=dragRef.current;
  if(!node||!drag)return;
  node.scrollLeft=drag.left-(e.clientX-drag.x);
  node.scrollTop=drag.top-(e.clientY-drag.y);
 }
 function panEnd(e:PointerEvent<HTMLDivElement>){
  dragRef.current=null;
  const node=viewportRef.current;
  if(node?.hasPointerCapture(e.pointerId))node.releasePointerCapture(e.pointerId);
 }
 const availableWidth=Math.max(150,viewport.width-32);
 const pageWidth=fitMode==="width"?availableWidth:Math.min(availableWidth,Math.max(150,(viewport.height-28)/pageRatio));
 const displayWidth=Math.round(pageWidth*zoom);
 return <div className="file-pdf-viewer">
  <div className="file-pdf-toolbar">
   <strong>PDF 预览</strong>
   <div className="file-pdf-tools">
    {history&&history.current>0&&<RareSelect aria-label="预览签章版本" value={revision===null?"latest":String(revision)}
     onChange={event=>{const value=event.target.value;onRevisionChange(value==="latest"?null:Number(value));setPageError("");}}>
     <option value="latest">当前签章 · r{history.current}</option>
     {history.revisions.map(item=><option key={item.revision} value={item.revision}>
      {item.revision===0?"原始未签章":("签章 r"+item.revision+" · "+item.markCount+" 枚")}
     </option>)}
    </RareSelect>}
    <RareButton type="button" aria-label="缩小 PDF" disabled={zoom<=0.5} onClick={()=>setZoomAt(zoom/1.25)}>−</RareButton>
    <span className="file-pdf-zoom-value">{Math.round(zoom*100)}%</span>
    <RareButton type="button" aria-label="放大 PDF" disabled={zoom>=5} onClick={()=>setZoomAt(zoom*1.25)}>＋</RareButton>
    <RareButton type="button" onClick={()=>{setFitMode(mode=>mode==="page"?"width":"page");setZoom(1);}}>{fitMode==="page"?"适应页面":"适应宽度"}</RareButton>
    <RareButton type="button" aria-pressed={panMode} onClick={()=>setPanMode(v=>!v)}>{panMode?"结束平移":"平移"}</RareButton>
    <RareButton type="button" disabled={!pages||page===1} onClick={()=>changePage(page-1)}>上一页</RareButton>
    <span aria-live="polite">{pages?"第 "+page+" / "+pages+" 页":"—"}</span>
    <RareButton type="button" disabled={!pages||page>=pages} onClick={()=>changePage(page+1)}>下一页</RareButton>

   </div>
  </div>
  {loading&&<div className="file-pdf-paper is-pending" aria-busy="true">
   <div className="file-pdf-placeholder" role="status"><BrandLoader size="lg" decorative/><span>正在加载 PDF 页面…</span></div>
  </div>}
  {error&&<div className="file-pdf-message"><p role="alert">{error}</p><RareButton type="button" onClick={()=>setRetry(i=>i+1)}>重试</RareButton></div>}
  {pages>0&&!error&&<div className={"file-pdf-paper"+(!imageReady?" is-pending":"")+(panMode?" is-panning":"")} ref={viewportRef} aria-busy={!imageReady} onPointerDown={panDown} onPointerMove={panMove} onPointerUp={panEnd} onPointerCancel={panEnd} style={{touchAction:panMode?"none":"auto"}}>
   {retained&&!pageError&&<img className="file-pdf-retained" src={retained.url} alt="" aria-hidden="true"/>}
   {!imageReady&&!pageError&&<div className={"file-pdf-placeholder"+(retained?" is-overlaid":"")} role="status">
    <BrandLoader size="lg" decorative/><span>正在渲染第 {page} 页…</span>
   </div>}
   {pageError&&<div className="file-pdf-page-error" role="alert">
    <span>{pageError}</span>
    <RareButton type="button" onClick={()=>{setPageRetry(i=>i+1);setPageError("");}}>重试此页</RareButton>
   </div>}
   <img key={url} className={imageReady?"file-pdf-image":"file-pdf-image is-pending"}
    src={url} alt={name+" 第 "+page+" 页"} aria-hidden={!imageReady} style={{width:displayWidth+"px",maxWidth:"none",maxHeight:"none"}}
    onLoad={event=>{const img=event.currentTarget;if(img.naturalWidth>0)setPageRatio(img.naturalHeight/img.naturalWidth);setDisplayed({documentKey,url,page});setPageError("");}}
    onError={()=>setPageError("该页渲染失败，请重试或下载原始 PDF。")}/>
  </div>}
 </div>;
}
