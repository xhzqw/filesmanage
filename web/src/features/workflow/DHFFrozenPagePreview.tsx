import {useEffect,useState} from "react";
import {request} from "../../shared/http";
import {RareButton} from "../../shared/ui/rare";
import {BrandLoader} from "../../shared/ui/BrandLoader";
import {errorCopy} from "../../shared/errors";
import "./dhfPilotInbox.css";

// The *task+requirement* identity, not file_id/current_seq, is the only
// locator. Every page request repeats reviewer/file-ACL/pinned SHA checks.
// Rendering uses the server's existing isolated Office→PDF→PNG pipeline.
export function DHFFrozenPagePreview({taskId,requirementId,fileName,versionSeq}:{
 taskId:string;requirementId:string;fileName:string;versionSeq:number;
}){
 const[pages,setPages]=useState(0);
 const[page,setPage]=useState(1);
 const[ready,setReady]=useState(false);
 const[error,setError]=useState("");
 const[retries,setRetries]=useState(0);
 const[pageFailed,setPageFailed]=useState(false);
 const[pageLoaded,setPageLoaded]=useState(false);
 const base="/api/workbench/dhf/tasks/"+encodeURIComponent(taskId)+"/evidence/"+
  encodeURIComponent(requirementId);
 useEffect(()=>{
  let active=true;
  setReady(false);setPages(0);setPage(1);setError("");setPageLoaded(false);setPageFailed(false);
  void request<{pageCount:number;immutable:boolean}>(base.slice(4)+"/pages")
   .then(result=>{
    if(!active)return;
    if(!result.immutable||result.pageCount<1||result.pageCount>1000)throw new Error("固定文件页面验证失败");
    setPages(result.pageCount);setReady(true);
   })
   .catch(cause=>{if(active)setError(errorCopy(cause,"固定版本页面暂时不可用"));});
  return()=>{active=false};
 },[base,retries]);
 const imageUrl=base+"/page?"+new URLSearchParams({page:String(page),retry:String(retries)});
 const changePage=(delta:number)=>{
  const next=Math.max(1,Math.min(pages,page+delta));
  if(next===page)return;
  setPage(next);setPageFailed(false);setPageLoaded(false);
 };
 return <div className="dhf-frozen-layout">
  <div className="dhf-frozen-layout-toolbar">
   <strong>{fileName} · 冻结 v{versionSeq}</strong>
   {ready&&<div className="dhf-frozen-layout-controls">
    <RareButton type="button" disabled={page<=1} onClick={()=>changePage(-1)}>上一页</RareButton>
    <span aria-live="polite">{page} / {pages}</span>
    <RareButton type="button" disabled={page>=pages} onClick={()=>changePage(1)}>下一页</RareButton>
   </div>}
  </div>
  {error?<div className="dhf-pilot-empty" role="alert">
   {error}<RareButton type="button" onClick={()=>setRetries(v=>v+1)}>重试</RareButton>
  </div>:!ready?<div className="dhf-pilot-empty" role="status">
   <BrandLoader size="md" decorative/>正在核验并渲染固定版本…
  </div>:<div className="dhf-frozen-layout-canvas">
   {!pageLoaded&&!pageFailed&&<div className="dhf-frozen-loading"><BrandLoader size="md" decorative/>正在显示第 {page} 页…</div>}
   {pageFailed?<div className="dhf-pilot-empty" role="alert">
    页图加载失败；原证据可能已失效或当前用户权限已变更。
    <RareButton type="button" onClick={()=>{setPageFailed(false);setRetries(v=>v+1)}}>重新核验</RareButton>
   </div>:<img key={imageUrl} src={imageUrl} alt={"受控冻结 v"+versionSeq+" · 第 "+page+" 页"}
    style={{visibility:pageLoaded?"visible":"hidden"}} onLoad={()=>setPageLoaded(true)}
    onError={()=>setPageFailed(true)}/>}
  </div>}
  <p className="dhf-pilot-disclaimer">页面由冻结原文件经服务端核验生成，不使用 Finder 最新版本，也不代表正式电子签署。</p>
 </div>
}
