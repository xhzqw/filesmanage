import {useEffect,useMemo,useRef,useState} from "react";
import {RareButton,RareSelect} from "../../shared/ui/rare";
import {errorCopy} from "../../shared/errors";
import {fileApi,type VersionComparison} from "./api";
import type {FileVersion} from "../../entities/file/model";
import "./versionCompareEnhancement.css";

type DisplayLine={kind:"line";index:number}|{kind:"fold";start:number;count:number};
export function compactDiff(lines:VersionComparison["lines"],context=3):DisplayLine[]{
 const keep=new Set<number>();
 for(let i=0;i<lines.length;i++){
  if(lines[i]?.kind==="equal")continue;
  for(let at=Math.max(0,i-context);at<=Math.min(lines.length-1,i+context);at++)keep.add(at);
 }
 if(keep.size===0)return lines.map((_,index)=>({kind:"line",index}));
 const out:DisplayLine[]=[];
 for(let i=0;i<lines.length;){
  if(keep.has(i)){out.push({kind:"line",index:i});i++;continue;}
  const start=i;
  while(i<lines.length&&!keep.has(i))i++;
  out.push({kind:"fold",start,count:i-start});
 }
 return out;
}

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
 const[showAll,setShowAll]=useState(false);
 const[activeChange,setActiveChange]=useState<number|null>(null);
 const lineRefs=useRef<Record<number,HTMLDivElement|null>>({});
 const changes=useMemo(()=>result?.mode==="text"?result.lines.map((l,index)=>l.kind!=="equal"?index:-1).filter(i=>i>=0):[],[result]);
 const display=useMemo(()=>result?.mode==="text"?(showAll?result.lines.map((_,index):DisplayLine=>({kind:"line",index})):compactDiff(result.lines)):[],[result,showAll]);
 function focusChange(direction:-1|1){
  if(changes.length===0)return;
  const position=activeChange===null?-1:changes.indexOf(activeChange);
  const next=changes[(position+direction+changes.length)%changes.length]??changes[0]!;
  setActiveChange(next);
  lineRefs.current[next]?.scrollIntoView({behavior:"smooth",block:"center"});
 }
 useEffect(()=>{setLeft(previous);setRight(latest);setShowAll(false);setActiveChange(null);},[fileId,previous,latest]);
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
   {result.detail==="office_parts"&&<p className="hint">Office 部件差异：比较文档内部部件的名称、大小和 CRC32，不能代表段落文字或页面版式完全一致。</p>}
   {result.mode==="text"&&<div className="file-compare-quicknav">
    <span>{changes.length} 处变更</span>
    <RareButton type="button" disabled={changes.length===0} onClick={()=>focusChange(-1)}>上一处</RareButton>
    <RareButton type="button" disabled={changes.length===0} onClick={()=>focusChange(1)}>下一处</RareButton>
    <RareButton type="button" aria-pressed={showAll} onClick={()=>setShowAll(v=>!v)}>{showAll?"折叠未变更行":"显示全部行"}</RareButton>
   </div>}
   {(result.mode==="metadata"||result.mode==="large")&&<div className="file-compare-hashes">
    <span>v{result.left.seq} SHA-256：<code>{result.left.sha256}</code></span>
    <span>v{result.right.seq} SHA-256：<code>{result.right.sha256}</code></span>
   </div>}
   {result.mode==="identical"?<p className="empty">内容完全一致（SHA-256 相同）。</p>
    :result.mode==="metadata"?<p className="empty">此格式不支持文本差异，两个版本的内容哈希不同。</p>
    :result.mode==="large"?<p className="empty">内容存在差异，但文件超过安全对比上限（文本 256 KB；Office 压缩包 8 MiB；最多 350 项），不展示不完整的差异。</p>
    :<div className="file-compare-lines" role="table" aria-label="版本文本差异">
     {display.map(entry=>entry.kind==="fold"
      ?<div key={"fold-"+entry.start} className="file-diff-fold" role="row">省略 {entry.count} 行未变化内容</div>
      :<div key={entry.index} role="row" ref={node=>{lineRefs.current[entry.index]=node;}}
       data-diff-index={entry.index} className={"file-diff-line "+result.lines[entry.index]!.kind+(activeChange===entry.index?" active-change":"")}>
       <span className="file-diff-number">{result.lines[entry.index]!.left??""}</span>
       <span className="file-diff-number">{result.lines[entry.index]!.right??""}</span>
       <span className="file-diff-sign">{result.lines[entry.index]!.kind==="added"?"+":result.lines[entry.index]!.kind==="removed"?"−":" "}</span>
       <span className="file-diff-text">{result.lines[entry.index]!.text||" "}</span>
      </div>)}
    </div>}
  </div>}
 </div>;
}
