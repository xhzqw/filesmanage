import {useEffect,useState} from "react";
import {RareButton,RareSelect} from "../../shared/ui/rare";
import {BrandLoader} from "../../shared/ui/BrandLoader";
import {errorCopy} from "../../shared/errors";
import {fileApi,type SealHistory} from "./api";
import "./pdfPageViewer.css";

// PDF rasterization is server-side and checked against current preview ACL.
// Do not embed the Chrome PDF extension in a sandboxed iframe.
export function PDFPageViewer({fileId,sha,name,onSign,seq,revision,onRevisionChange,epoch}:{
 fileId:string;sha:string;name:string;seq:number;revision:number|null;epoch:number;onRevisionChange:(value:number|null)=>void;onSign:()=>void;
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
    <RareButton type="button" disabled={!pages||page===1} onClick={()=>changePage(page-1)}>上一页</RareButton>
    <span aria-live="polite">{pages?"第 "+page+" / "+pages+" 页":"—"}</span>
    <RareButton type="button" disabled={!pages||page>=pages} onClick={()=>changePage(page+1)}>下一页</RareButton>
    <RareButton type="button" className="primary" onClick={onSign}>签名 / 盖章</RareButton>
   </div>
  </div>
  {loading&&<div className="file-pdf-paper is-pending" aria-busy="true">
   <div className="file-pdf-placeholder" role="status"><BrandLoader size="lg" decorative/><span>正在加载 PDF 页面…</span></div>
  </div>}
  {error&&<div className="file-pdf-message"><p role="alert">{error}</p><RareButton type="button" onClick={()=>setRetry(i=>i+1)}>重试</RareButton></div>}
  {pages>0&&!error&&<div className={"file-pdf-paper"+(!imageReady?" is-pending":"")} aria-busy={!imageReady}>
   {retained&&!pageError&&<img className="file-pdf-retained" src={retained.url} alt="" aria-hidden="true"/>}
   {!imageReady&&!pageError&&<div className={"file-pdf-placeholder"+(retained?" is-overlaid":"")} role="status">
    <BrandLoader size="lg" decorative/><span>正在渲染第 {page} 页…</span>
   </div>}
   {pageError&&<div className="file-pdf-page-error" role="alert">
    <span>{pageError}</span>
    <RareButton type="button" onClick={()=>{setPageRetry(i=>i+1);setPageError("");}}>重试此页</RareButton>
   </div>}
   <img key={url} className={imageReady?"file-pdf-image":"file-pdf-image is-pending"}
    src={url} alt={name+" 第 "+page+" 页"} aria-hidden={!imageReady}
    onLoad={()=>{setDisplayed({documentKey,url,page});setPageError("");}}
    onError={()=>setPageError("该页渲染失败，请重试或下载原始 PDF。")}/>
  </div>}
 </div>;
}
