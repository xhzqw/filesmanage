import {useEffect,useState} from "react";
import {RareButton,RareSelect} from "../../shared/ui/rare";
import {errorCopy} from "../../shared/errors";
import {fileApi,type VersionComparison} from "./api";
import type {FileVersion} from "../../entities/file/model";

export function VersionComparePanel({fileId,versions}:{fileId:string;versions:FileVersion[]}){
 const ordered=versions.map(v=>v.versionSeq).sort((a,b)=>a-b);
 const latest=ordered.at(-1)??0;
 const previous=ordered.at(-2)??0;
 const[left,setLeft]=useState(previous);
 const[right,setRight]=useState(latest);
 const[result,setResult]=useState<VersionComparison|null>(null);
 const[state,setState]=useState<"loading"|"ready"|"failed">("loading");
 const[error,setError]=useState("");
 const[retry,setRetry]=useState(0);
 useEffect(()=>{setLeft(previous);setRight(latest);},[fileId,previous,latest]);
 useEffect(()=>{
  if(!left||!right||left===right){setResult(null);setState("ready");return;}
  let live=true;setState("loading");setError("");setResult(null);
  fileApi.compareVersions(fileId,left,right).then(value=>{if(live){setResult(value);setState("ready");}})
   .catch(err=>{if(live){setError(errorCopy(err,"对比失败"));setState("failed");}});
  return()=>{live=false;};
 },[fileId,left,right,retry]);
 if(ordered.length<2)return <div className="empty">至少需要两个版本才能对比。</div>;
 return <div className="file-compare">
  <div className="file-compare-controls">
   <label>基准版本<RareSelect value={left} onChange={e=>setLeft(Number(e.target.value))}>
    {ordered.map(v=><option key={v} value={v}>v{v}</option>)}
   </RareSelect></label>
   <span className="file-compare-arrow" aria-hidden="true">→</span>
   <label>对比版本<RareSelect value={right} onChange={e=>setRight(Number(e.target.value))}>
    {ordered.map(v=><option key={v} value={v}>v{v}</option>)}
   </RareSelect></label>
   <RareButton type="button" onClick={()=>setRetry(x=>x+1)} disabled={left===right||state==="loading"}>刷新</RareButton>
  </div>
  {left===right&&<p className="hint">请选择两个不同的版本。</p>}
  {state==="loading"&&<p role="status" className="hint">正在比较…</p>}
  {state==="failed"&&<p role="alert" className="notice error">{error}</p>}
  {result&&<div className="file-compare-result">
   <div className="file-compare-stats">
    <span>v{result.left.seq} · {result.left.sizeBytes.toLocaleString()} B</span>
    <span>v{result.right.seq} · {result.right.sizeBytes.toLocaleString()} B</span>
    {result.mode==="text"&&<strong>+{result.added} / −{result.removed} 行</strong>}
   </div>
   {result.mode==="identical"?<p className="empty">内容完全一致（SHA-256 相同）。</p>
    :result.mode==="metadata"?<p className="empty">此格式不支持文本差异，两个版本的内容哈希不同。</p>
    :result.mode==="large"?<p className="empty">内容存在差异，但文本超过对比上限（256 KB 或 350 行），不展示不完整的差异。</p>
    :<div className="file-compare-lines" role="table" aria-label="版本文本差异">
     {result.lines.map((line,index)=><div key={index} role="row" className={"file-diff-line "+line.kind}>
      <span className="file-diff-number">{line.left??""}</span>
      <span className="file-diff-number">{line.right??""}</span>
      <span className="file-diff-sign">{line.kind==="added"?"+":line.kind==="removed"?"−":" "}</span>
      <span className="file-diff-text">{line.text||" "}</span>
     </div>)}
    </div>}
  </div>}
 </div>;
}
