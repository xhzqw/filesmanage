import {useEffect,useRef,useState,type FormEvent} from "react";
import {RareButton,RareInput,RareSelect,RareTextarea} from "../../shared/ui/rare";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {toast} from "../../shared/ui/feedback";
import {errorCopy} from "../../shared/errors";
import {observeWorkspaceChange} from "../../shared/resourceSync";
import {fileApi,type FileReviewComment,type ReviewAssignee,type ReviewAction} from "./api";
import type {FileVersion} from "../../entities/file/model";
import "./fileReviewPanel.css";

type Filter="all"|"mine"|"approval"|"done";
type ActionEditor={id:number;action:"assign"|"submit-resolution"|"update-resolution"|"reject"}|null;
const finished=(c:FileReviewComment)=>c.status==="approved"||c.status==="completed_self";
function shortDate(value:string){return new Date(value).toLocaleString("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"});}
function statusLabel(c:FileReviewComment){
 switch(c.status){
  case "assigned":return "● 待 "+(c.assigneeName||"处理人")+" 处理";
  case "pending_approval":return "◷ 待发起人验收";
  case "rejected":return "↺ 退回重办";
  case "approved":return "✓ 已验收通过";
  case "completed_self":return "✓ 已完成 (自办)";
  default:return "● 待处理";
 }
}
export function FileReviewPanel({fileId,versions,currentUser,currentPage=1,onJumpToPage}:{
 fileId:string;versions:FileVersion[];currentUser:{id:string;isAdmin:boolean};currentPage?:number;
 onJumpToPage?:(page:number)=>void;
}){
 const latest=versions.reduce((max,v)=>Math.max(max,v.versionSeq),0);
 const[seq,setSeq]=useState(latest);
 const[items,setItems]=useState<FileReviewComment[]>([]);
 const[next,setNext]=useState("");
 const[state,setState]=useState<"loading"|"ready"|"failed">("loading");
 const[error,setError]=useState("");
 const[filter,setFilter]=useState<Filter>("all");
 const[composing,setComposing]=useState(false);
 const[body,setBody]=useState("");
 const[page,setPage]=useState("");
 const[line,setLine]=useState("");
 const[mode,setMode]=useState<"self"|"assign">("self");
 const[assignee,setAssignee]=useState("");
 const[assignees,setAssignees]=useState<ReviewAssignee[]>([]);
 const[peopleSearch,setPeopleSearch]=useState("");
 const[actionEditor,setActionEditor]=useState<ActionEditor>(null);
 const[actionNote,setActionNote]=useState("");
 const[actionVersion,setActionVersion]=useState("");
 const[busy,setBusy]=useState(false);
 const[moreBusy,setMoreBusy]=useState(false);
 const[refresh,setRefresh]=useState(0);
 const generation=useRef(0);
 useEffect(()=>{setSeq(latest);setFilter("all");setComposing(false);setActionEditor(null);},[fileId,latest]);
 useEffect(()=>observeWorkspaceChange(()=>setRefresh(value=>value+1),["review"]),[fileId]);
 useEffect(()=>{if(composing&&page==="")setPage(String(currentPage));},[composing,currentPage,page]);
 useEffect(()=>{
  let live=true;setAssignees([]);
  fileApi.reviewAssignees(fileId).then(users=>{if(live)setAssignees(users);})
   .catch(()=>{if(live)setAssignees([]);});
  return()=>{live=false};
 },[fileId]);
 useEffect(()=>{
  if(!seq)return;
  const gen=++generation.current;let live=true;
  setState(old=>old==="ready"?"ready":"loading");setError("");
  fileApi.reviewComments(fileId,seq).then(result=>{
   if(live&&gen===generation.current){setItems(result.items);setNext(result.nextCursor);setState("ready");}
  }).catch(e=>{if(live&&gen===generation.current){setState("failed");setError(errorCopy(e,"加载批注失败"));}});
  return()=>{live=false;generation.current++;};
 },[fileId,seq,refresh]);
 async function saveNew(e:FormEvent<HTMLFormElement>){
  e.preventDefault();if(!body.trim()||busy||(mode==="assign"&&!assignee))return;
  const pageNumber=page.trim()?Number(page):undefined;
  const lineNumber=line.trim()?Number(line):undefined;
  if(pageNumber!==undefined&&(!Number.isInteger(pageNumber)||pageNumber<1||pageNumber>100000)||
    lineNumber!==undefined&&(!Number.isInteger(lineNumber)||lineNumber<1||lineNumber>1000000)){setError("页码或行号必须为有效正整数");return;}
  setBusy(true);setError("");
  try{
   await toast.track(()=>fileApi.addReviewComment(fileId,{versionSeq:seq,pageNumber,lineNumber,body:body.trim(),assigneeId:mode==="assign"?assignee:undefined}),{
    loading:mode==="assign"?"正在派发批注…":"正在添加批注…",success:mode==="assign"?"批注已派发":"批注已添加",error:e=>errorCopy(e,"创建批注失败")
   });
   setBody("");setPage("");setLine("");setAssignee("");setMode("self");setComposing(false);setRefresh(i=>i+1);
  }catch(e){setError(errorCopy(e,"创建批注失败"))}
  finally{setBusy(false)}
 }
 function startAction(c:FileReviewComment,action:NonNullable<ActionEditor>["action"]){
  setActionEditor({id:c.id,action});setActionNote("");setActionVersion("");setAssignee(c.assigneeId||"");setError("");
 }
 async function act(c:FileReviewComment,action:ReviewAction,data:Record<string,unknown>={}){
  if(busy)return;
  setBusy(true);setError("");
  try{
   await toast.track(()=>fileApi.transitionReview(fileId,c.id,action,data),{
    loading:"正在更新批注…",
    success:action==="resolve-self"?"已标记自行完成":action==="submit-resolution"?"处理结果已返还发起人":
     action==="approve"?"验收已通过":action==="reject"?"已退回重办":action==="assign"?"已派发处理人":"状态已更新",
    error:e=>errorCopy(e,"操作失败，可能已被他人更新")
   });
   setActionEditor(null);setActionNote("");setActionVersion("");setRefresh(i=>i+1);
  }catch(e){setError(errorCopy(e,"操作失败，请刷新后重试"))}
  finally{setBusy(false)}
 }
 function sendAction(e:FormEvent<HTMLFormElement>,c:FileReviewComment){
  e.preventDefault();if(!actionEditor||actionEditor.id!==c.id)return;
  if(actionEditor.action==="assign"){if(!assignee)return;void act(c,"assign",{assigneeId:assignee});return}
  const resolvedVersionSeq=actionVersion?Number(actionVersion):undefined;
  if(resolvedVersionSeq!==undefined&&!versions.some(v=>v.versionSeq===resolvedVersionSeq)){
   setError("关联版本不存在，请选择文档已保存的版本");return;
  }
  void act(c,actionEditor.action,{
   ...(actionEditor.action==="reject"?{approvalNote:actionNote.trim()}:{resolutionNote:actionNote.trim(),resolvedVersionSeq})
  });
 }
 async function loadMore(){
  if(!next||moreBusy)return;
  const gen=generation.current;setMoreBusy(true);
  try{
   const result=await fileApi.reviewComments(fileId,seq,next);
   if(gen!==generation.current)return;
   setItems(old=>[...old,...result.items.filter(item=>!old.some(c=>c.id===item.id))]);setNext(result.nextCursor);
  }catch(e){if(gen===generation.current)setError(errorCopy(e,"加载更多失败"))}
  finally{if(gen===generation.current)setMoreBusy(false)}
 }
 const mine=(c:FileReviewComment)=>c.assigneeId===currentUser.id&&(c.status==="assigned"||c.status==="rejected");
 const approval=(c:FileReviewComment)=>c.creatorId===currentUser.id&&c.status==="pending_approval";
 const counts={all:items.length,mine:items.filter(mine).length,approval:items.filter(approval).length,done:items.filter(finished).length};
 const filtered=items.filter(c=>filter==="all"||filter==="mine"&&mine(c)||filter==="approval"&&approval(c)||filter==="done"&&finished(c));
 const people=assignees.filter(person=>person.displayName.toLowerCase().includes(peopleSearch.trim().toLowerCase())||person.departmentName?.toLowerCase().includes(peopleSearch.trim().toLowerCase())||person.role.toLowerCase().includes(peopleSearch.trim().toLowerCase()));
 function personPicker(){
  return <div className="file-review-people">
   <RareInput aria-label="搜索处理人" placeholder="搜索姓名或部门" value={peopleSearch} onChange={e=>setPeopleSearch(e.target.value)}/>
   <div className="file-review-people-list" role="radiogroup" aria-label="指派处理人">
    {people.map(person=><RareButton key={person.id} type="button" tone="ghost"
     className={"file-review-person"+(assignee===person.id?" is-selected":"")}
     aria-pressed={assignee===person.id} onClick={()=>setAssignee(person.id)}>
     <strong>{person.displayName}</strong><small>{[person.departmentName,person.role].filter(Boolean).join(" · ")}</small>
     {assignee===person.id&&<span aria-hidden="true">✓</span>}
    </RareButton>)}
    {people.length===0&&<p className="hint">没有可指派且拥有文档查看权限的成员</p>}
   </div>
  </div>;
 }
 return <section className="file-review" aria-label="审查批注与派发">
  <header className="file-review-header">
   <div className="file-review-heading"><strong>审查批注</strong>
    <RareSelect aria-label="审查版本" value={seq} onChange={e=>setSeq(Number(e.target.value))}>
     {versions.slice().sort((a,b)=>b.versionSeq-a.versionSeq).map(v=><option key={v.versionSeq} value={v.versionSeq}>v{v.versionSeq}</option>)}
    </RareSelect>
   </div>
   <div className="file-review-header-actions">
    <RareButton type="button" tone="ghost" aria-label="刷新批注" title="刷新" onClick={()=>setRefresh(x=>x+1)}>
     <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M20 11a8 8 0 1 0-2 6M20 5v6h-6"/></svg>
    </RareButton>
    <RareButton type="button" className="primary file-review-new" aria-expanded={composing}
     onClick={()=>setComposing(v=>!v)}>{composing?"取消新建":"＋ 新建批注"}</RareButton>
   </div>
  </header>
  <nav className="file-review-filters" aria-label="批注状态筛选">
   {([["all","全部"],["mine","待我处理"],["approval","待我验收"],["done","已完结"]] as const).map(([key,label])=>
    <RareButton type="button" key={key} aria-pressed={filter===key} onClick={()=>setFilter(key)}>{label}<small>{counts[key]}</small></RareButton>)}
  </nav>
  {composing&&<form className="file-review-form" onSubmit={saveNew}>
   <RareTextarea aria-label="审查意见" value={body} onChange={e=>setBody(e.target.value)}
    placeholder="输入审查意见或修改要求..." rows={4} maxLength={2000} required disabled={busy}/>
   <div className="file-review-anchor">
    <label>关联页码<RareInput type="number" min={1} value={page} placeholder="第 1 页" onChange={e=>setPage(e.target.value)}/></label>
    <label>行号 / 段落（可选）<RareInput type="number" min={1} value={line} placeholder="选填" onChange={e=>setLine(e.target.value)}/></label>
   </div>
   <div className="file-review-mode" role="group" aria-label="处理方式">
    <RareButton type="button" aria-pressed={mode==="self"} onClick={()=>setMode("self")}>自己处理 / 仅记录</RareButton>
    <RareButton type="button" aria-pressed={mode==="assign"} onClick={()=>setMode("assign")}>➔ 派发他人</RareButton>
   </div>
   {mode==="assign"&&personPicker()}
   <RareButton type="submit" className="primary file-review-submit" loading={busy}
    disabled={!body.trim()||mode==="assign"&&!assignee}>{mode==="assign"?"立即派发批注":"添加批注"}</RareButton>
  </form>}
  {error&&<p role="alert" className="notice error file-review-error">{error}</p>}
  {state==="loading"&&<p role="status" className="hint"><BrandLoadingLabel>正在加载审查记录…</BrandLoadingLabel></p>}
  {state==="failed"&&<RareButton type="button" onClick={()=>setRefresh(x=>x+1)}>重试加载</RareButton>}
  {state==="ready"&&<div className="file-review-list">
   {filtered.length===0&&<p className="file-review-empty">{filter==="all"?"当前版本暂无批注":"该筛选下暂无批注"}</p>}
   {filtered.map(c=>{
    const isCreator=c.creatorId===currentUser.id||currentUser.isAdmin;
    const isAssignee=c.assigneeId===currentUser.id||currentUser.isAdmin;
    const edit=actionEditor?.id===c.id?actionEditor:null;
    return <article className="file-review-item" key={c.id}>
     <header className="file-review-item-head">
      <div className="file-review-item-meta">
       <strong>{c.creatorName||c.authorName||"发起人"}</strong>
       <time>{shortDate(c.createdAt)}</time>
       {c.pageNumber&&<RareButton type="button" tone="ghost" className="file-review-page"
        title="跳转到文档位置" onClick={()=>onJumpToPage?.(c.pageNumber!)}>第 {c.pageNumber} 页</RareButton>}
      </div>
      <span className={"file-review-status is-"+c.status}>{statusLabel(c)}</span>
     </header>
     {c.assigneeId&&<div className="file-review-route"><span>{c.creatorName||c.authorName}</span><span aria-hidden="true">→</span><span>{c.assigneeName||c.assigneeId}</span></div>}
     <p className="file-review-body">{c.body}</p>
     {(c.resolvedAt||c.approvalNote)&&<div className="file-review-history">
      {c.resolvedAt&&<div><strong>处理回执 · {c.assigneeName||c.creatorName||c.authorName}</strong>
       <p>{c.resolutionNote||"处理已提交"}{c.resolvedVersionSeq?"（关联 v"+c.resolvedVersionSeq+"）":""}</p></div>}
      {c.approvalNote&&<div className="file-review-opinion"><strong>验收意见 · {c.creatorName||c.authorName}</strong><p>{c.approvalNote}</p></div>}
     </div>}
     {!edit&&<div className="file-review-card-actions">
      {c.status==="open"&&isCreator&&<>
       <RareButton type="button" className="primary" disabled={busy} onClick={()=>void act(c,"resolve-self")}>✓ 自己处理完成</RareButton>
       <RareButton type="button" disabled={busy} onClick={()=>startAction(c,"assign")}>➔ 派发给他人</RareButton>
      </>}
      {(c.status==="assigned"||c.status==="rejected")&&<>
       {isAssignee&&<RareButton type="button" className="primary" disabled={busy} onClick={()=>startAction(c,"submit-resolution")}>提交处理结果</RareButton>}
       {isCreator&&<RareButton type="button" disabled={busy} onClick={()=>void act(c,"resolve-self")}>我已自行处理</RareButton>}
       {isCreator&&<RareButton type="button" disabled={busy} onClick={()=>startAction(c,"assign")}>转派他人</RareButton>}
      </>}
      {c.status==="pending_approval"&&<>
       {isCreator&&<RareButton type="button" className="file-review-approve" disabled={busy} onClick={()=>void act(c,"approve")}>✓ 验收通过</RareButton>}
       {isCreator&&<RareButton type="button" className="file-review-reject" disabled={busy} onClick={()=>startAction(c,"reject")}>↺ 退回重办</RareButton>}
       {isAssignee&&!isCreator&&<><span className="file-review-await">已提交发起人验收</span>
        <RareButton type="button" disabled={busy} onClick={()=>startAction(c,"update-resolution")}>更新回执</RareButton></>}
      </>}
      {finished(c)&&isCreator&&<RareButton type="button" tone="ghost" disabled={busy} onClick={()=>void act(c,"reopen")}>↺ 重新打开</RareButton>}
     </div>}
     {edit&&<form className="file-review-inline-form" onSubmit={e=>sendAction(e,c)}>
      <strong>{edit.action==="assign"?"选择处理人":edit.action==="reject"?"退回原因":edit.action==="update-resolution"?"更新处理回执":"提交处理结果"}</strong>
      {edit.action==="assign"?personPicker():<>
       <RareTextarea aria-label={edit.action==="reject"?"退回原因":"处理说明"} rows={3} maxLength={3000}
        placeholder={edit.action==="reject"?"填写退回原因（选填）":"说明已修改的内容与结果..."}
        required={edit.action!=="reject"} value={actionNote} onChange={e=>setActionNote(e.target.value)}/>
       {edit.action!=="reject"&&<label>处理后版本（可选）
        <RareSelect value={actionVersion} onChange={e=>setActionVersion(e.target.value)}>
         <option value="">不关联版本</option>
         {versions.map(v=><option key={v.versionSeq} value={v.versionSeq}>v{v.versionSeq}</option>)}
        </RareSelect></label>}
      </>}
      <div className="file-review-inline-actions">
       <RareButton type="button" onClick={()=>setActionEditor(null)}>取消</RareButton>
       <RareButton type="submit" className="primary" loading={busy}
        disabled={busy||edit.action==="assign"&&!assignee||edit.action!=="assign"&&edit.action!=="reject"&&!actionNote.trim()}>
        {edit.action==="assign"?"确认派发":edit.action==="reject"?"确认退回":"提交给发起人"}
       </RareButton>
      </div>
     </form>}
    </article>;
   })}
   {next&&<RareButton type="button" disabled={moreBusy} loading={moreBusy} onClick={()=>void loadMore()}>加载更多</RareButton>}
  </div>}
 </section>;
}
