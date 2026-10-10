import {useEffect,useRef,useState,type FormEvent} from "react";
import {RareButton,RareInput,RareSelect,RareTextarea} from "../../shared/ui/rare";
import {errorCopy} from "../../shared/errors";
import {fileApi,type FileReviewComment} from "./api";
import type {FileVersion} from "../../entities/file/model";

export function FileReviewPanel({fileId,versions}:{fileId:string;versions:FileVersion[]}){
 const latest=versions.reduce((max,v)=>Math.max(max,v.versionSeq),0);
 const[seq,setSeq]=useState(latest);
 const[items,setItems]=useState<FileReviewComment[]>([]);
 const[next,setNext]=useState("");
 const[state,setState]=useState<"loading"|"ready"|"failed">("loading");
 const[error,setError]=useState("");
 const[body,setBody]=useState("");
 const[line,setLine]=useState("");
 const[busy,setBusy]=useState(false);
 const[moreBusy,setMoreBusy]=useState(false);
 const[refresh,setRefresh]=useState(0);
 const generation=useRef(0);
 useEffect(()=>setSeq(latest),[fileId,latest]);
 useEffect(()=>{
  if(!seq)return;
  const gen=++generation.current;let live=true;
  setState("loading");setError("");setItems([]);setNext("");
  fileApi.reviewComments(fileId,seq).then(page=>{
   if(live&&gen===generation.current){setItems(page.items);setNext(page.nextCursor);setState("ready");}
  }).catch(e=>{if(live&&gen===generation.current){setState("failed");setError(errorCopy(e,"加载批注失败"));}});
  return()=>{live=false;generation.current++;};
 },[fileId,seq,refresh]);
 async function submit(e:FormEvent<HTMLFormElement>){
  e.preventDefault();if(!body.trim()||busy)return;
  const lineNumber=line.trim()?Number(line.trim()):undefined;
  if(lineNumber!==undefined&&(!Number.isInteger(lineNumber)||lineNumber<1||lineNumber>1000000)){setError("行号必须是 1～1000000 的整数");return;}
  setBusy(true);setError("");
  try{
   await fileApi.addReviewComment(fileId,{version:seq,lineNumber,body:body.trim()});
   setBody("");setLine("");setRefresh(i=>i+1);
  }catch(err){setError(errorCopy(err,"新增批注失败"));}
  finally{setBusy(false);}
 }
 async function resolve(comment:FileReviewComment){
  if(busy)return;setBusy(true);setError("");
  try{await fileApi.resolveReviewComment(fileId,comment.id);setRefresh(i=>i+1);}
  catch(e){setError(errorCopy(e,"无法标记已解决（需作者或修改权限）"));}
  finally{setBusy(false);}
 }
 async function loadMore(){
  if(!next||moreBusy)return;
  const gen=generation.current;setMoreBusy(true);
  try{
   const page=await fileApi.reviewComments(fileId,seq,next);
   if(gen!==generation.current)return;
   setItems(old=>[...old,...page.items.filter(item=>!old.some(c=>c.id===item.id))]);setNext(page.nextCursor);
  }catch(err){if(gen===generation.current)setError(errorCopy(err,"加载更多失败"));}
  finally{if(gen===generation.current)setMoreBusy(false);}
 }
 return <div className="file-review">
  <header className="file-review-header">
   <label>审查版本<RareSelect value={seq} onChange={e=>setSeq(Number(e.target.value))}>
    {versions.slice().sort((a,b)=>b.versionSeq-a.versionSeq).map(v=><option key={v.versionSeq} value={v.versionSeq}>v{v.versionSeq}</option>)}
   </RareSelect></label>
   <RareButton type="button" onClick={()=>setRefresh(x=>x+1)}>刷新</RareButton>
  </header>
  <form className="file-review-form" onSubmit={submit}>
   <RareTextarea aria-label="批注内容" value={body} onChange={e=>setBody(e.target.value)} placeholder="填写审查意见…" rows={3} maxLength={2000} required disabled={busy}/>
   <div className="file-review-actions">
    <RareInput aria-label="关联行号（可选）" value={line} onChange={e=>setLine(e.target.value)} placeholder="行号（可选）" inputMode="numeric" disabled={busy}/>
    <RareButton type="submit" className="primary" disabled={busy||!body.trim()}>{busy?"提交中…":"添加批注"}</RareButton>
   </div>
  </form>
  {error&&<p role="alert" className="notice error">{error}</p>}
  {state==="loading"&&<p role="status" className="hint">正在加载审查记录…</p>}
  {state==="failed"&&<RareButton type="button" onClick={()=>setRefresh(x=>x+1)}>重试</RareButton>}
  {state==="ready"&&<div className="file-review-list">
   {items.length===0&&<p className="empty">当前版本暂无批注。</p>}
   {items.map(item=><article className="file-review-item" key={item.id}>
    <header>
     <strong>{item.authorName||item.authorId}</strong>
     <span>{new Date(item.createdAt).toLocaleString("zh-CN")}</span>
     {item.lineNumber&&<span>第 {item.lineNumber} 行</span>}
     <span className={item.resolvedAt?"file-review-resolved":"file-review-open"}>{item.resolvedAt?"已解决":"待处理"}</span>
    </header>
    <p>{item.body}</p>
    {!item.resolvedAt&&<RareButton type="button" disabled={busy} onClick={()=>void resolve(item)}>标记已解决</RareButton>}
   </article>)}
   {next&&<RareButton type="button" disabled={moreBusy} onClick={()=>void loadMore()}>{moreBusy?"加载中…":"加载更多"}</RareButton>}
  </div>}
 </div>;
}
