import {useEffect,useMemo,useRef,useState} from "react";
import {BrandLoadingLabel} from "./BrandLoader";
import {request} from "../http";
export type FileHistoryEvent={id:number;actorId:string;actorName?:string;requestId:string;eventType:string;targetKind:string;targetId:string;outcome:string;details:Record<string,unknown>;createdAt:string};
export type FileHistoryPage={items:FileHistoryEvent[];nextCursor:string};
const history=(id:string,cursor:string,signal?:AbortSignal)=>request<FileHistoryPage>("/files/"+encodeURIComponent(id)+"/history?"+new URLSearchParams({cursor,limit:"30"}),{signal});
import {RareButton} from "./rare";
import {errorCopy} from "../errors";
import "./fileHistory.css";

const eventLabels:Record<string,string>={
 "file.upload":"文件上传","file.save":"内容修改","file.rollback":"版本回滚",
 "file.replace":"替换文件内容","file.download_prepare":"请求下载文件",
 "file.download_zip_prepare":"加入批量下载",
 "seal.restore":"签章修订回退","approval.cancel":"撤销审批",
 "file.print.prepare":"准备打印","file.print.render":"生成打印内容",
 "file.rename":"文件重命名","file.move":"文件移动","file.delete":"移入回收站",
 "folder.rename":"所在文件夹重命名","folder.move":"所在文件夹移动","folder.delete":"所在文件夹被删除",
 "file.metadata_update":"属性修改","trash.restore":"从回收站恢复","trash.purge":"永久删除",
 "office.save_commit":"Office 内容保存","office.session_open":"开始在线编辑",
 "office.session_close":"结束在线编辑","approval.request":"提交审批",
 "approval.approve":"审批通过","approval.reject":"审批拒绝",
 "approval.step_approved":"审批流转","seal.apply":"签名 / 盖章",
 "file.lifecycle.publish":"文件发布","file.lifecycle.archive":"文件归档",
 "file.review_comment":"新增批注","file.review_resolve":"批注处理",
};
const detailText=(value:unknown)=>typeof value==="string"?value:typeof value==="number"?String(value):"";
function describe(item:FileHistoryEvent){
 const d=item.details;
 if(item.eventType==="file.rename")return d.oldName?detailText(d.oldName)+" → "+(detailText(d.newName)||detailText(d.name)):"新名称："+(detailText(d.newName)||detailText(d.name))+" · 旧名称未留存";
 if(item.eventType==="folder.rename")return detailText(d.oldName)&&detailText(d.newName)?detailText(d.oldName)+" → "+detailText(d.newName):"文件所在路径受到影响";
 if(item.eventType==="folder.move"||item.eventType==="folder.delete")return "此操作影响了文件所在目录";
 if(item.eventType==="file.move")return d.pathRestricted?"位置变更 · 旧路径受权限保护":d.fromPath&&d.toPath?detailText(d.fromPath)+" → "+detailText(d.toPath):"位置变更 · 旧记录无路径快照";
 if(item.eventType==="trash.restore")return "恢复文件"+(d.newName?" · "+detailText(d.newName):"");
 if(item.eventType==="file.save"||item.eventType==="office.save_commit")return "保存为 v"+detailText(d.versionSeq)+(d.baseSeq?" · 原版本 v"+detailText(d.baseSeq):"");
 if(item.eventType==="file.replace")return "v"+detailText(d.baseSeq)+" → v"+detailText(d.versionSeq)+" · 旧内容保留";
 if(item.eventType==="file.rollback")return "从 v"+detailText(d.fromSeq)+" 回滚至 v"+detailText(d.targetSeq)+"，生成 v"+detailText(d.versionSeq);
 if(item.eventType==="file.upload")return detailText(d.name)||"初始文件版本";
 if(item.eventType==="file.delete")return detailText(d.name)||"已移入回收站";
 if(item.eventType==="file.metadata_update")return "文件分类、描述或标签发生变化";
 if(item.eventType==="seal.apply")return "作用于 v"+detailText(d.versionSeq);
 return d.versionSeq?"关联版本 v"+detailText(d.versionSeq):"";
}

// Read-only timeline. The single "历史" workspace reuses the existing
// content-version actions rather than creating a second rollback flow.
export function FileHistoryPanel({fileId,revision}:{fileId:string;revision:number}){
 const[filter,setFilter]=useState<"all"|"content"|"location"|"workflow">("all");
 const[page,setPage]=useState<FileHistoryPage>({items:[],nextCursor:""});
 const[loading,setLoading]=useState(true);
 const[more,setMore]=useState(false);
 const[error,setError]=useState("");
 const[retry,setRetry]=useState(0);
 const requestEpoch=useRef(0);
 const scroller=useRef<HTMLDivElement>(null);
 const[activeMonth,setActiveMonth]=useState("");
 useEffect(()=>{
  let live=true;
  const epoch=++requestEpoch.current;
  const controller=new AbortController();
  setLoading(true);setPage({items:[],nextCursor:""});setError("");
  void history(fileId,"",controller.signal).then(value=>{
   if(live&&epoch===requestEpoch.current)setPage(value);
  }).catch(err=>{
   if(live&&epoch===requestEpoch.current)setError(errorCopy(err,"读取文件历史失败"));
  }).finally(()=>{if(live&&epoch===requestEpoch.current)setLoading(false);});
  return()=>{live=false;controller.abort();};
 },[fileId,revision,retry]);
 async function nextPage(){
  if(more||!page.nextCursor)return;
  const epoch=requestEpoch.current;
  setMore(true);
  try{
   const next=await history(fileId,page.nextCursor);
   if(epoch!==requestEpoch.current)return;
   setPage(current=>({
    items:[...current.items,...next.items.filter(x=>!current.items.some(old=>old.id===x.id))],
    nextCursor:next.nextCursor,
   }));
   setError("");
  }catch(err){if(epoch===requestEpoch.current)setError(errorCopy(err,"加载后续历史失败"));}
  finally{if(epoch===requestEpoch.current)setMore(false);}
 }
 const category=(type:string)=>/^(file\.(upload|save|rollback|replace)|office\.save_commit)/.test(type)?"content":/^(approval\.|seal\.|file\.review)/.test(type)?"workflow":"location";
 const shown=filter==="all"?page.items:page.items.filter(item=>category(item.eventType)===filter);
 const grouped=useMemo(()=>{
  const months:{id:string;items:FileHistoryEvent[]}[]=[];
  for(const event of shown){
   const id=/^\d{4}-\d{2}/.test(event.createdAt)?event.createdAt.slice(0,7):"未知日期";
   if(months.at(-1)?.id!==id)months.push({id,items:[]});
   months.at(-1)!.items.push(event);
  }
  return months;
 },[shown]);
 useEffect(()=>{setActiveMonth(grouped[0]?.id??"");},[fileId,filter,grouped[0]?.id]);
 function monthLabel(id:string){return id==="未知日期"?id:id.replace("-"," 年 ")+" 月";}
 function jumpToMonth(id:string){
  const target=Array.from(scroller.current?.querySelectorAll<HTMLElement>("[data-history-month]")??[])
   .find(item=>item.dataset.historyMonth===id);
  if(target&&scroller.current){
   scroller.current.scrollTo({top:target.offsetTop-scroller.current.offsetTop,behavior:"smooth"});
   setActiveMonth(id);
  }
 }
 function updateActiveMonth(){
  if(!scroller.current)return;
  let id=grouped[0]?.id??"";
  for(const section of scroller.current.querySelectorAll<HTMLElement>("[data-history-month]"))
   if(section.offsetTop-scroller.current.offsetTop<=scroller.current.scrollTop+70)id=section.dataset.historyMonth??id;
  setActiveMonth(current=>current===id?current:id);
 }
 return <div className="file-history" aria-label="文件操作时间线">
  <div className="file-history-filters" role="group" aria-label="操作类型">
   {([["all","全部"],["content","内容"],["location","文件操作"],["workflow","审批签章"]] as const).map(([key,label])=>
    <RareButton key={key} type="button" aria-pressed={filter===key} onClick={()=>setFilter(key)}>{label}</RareButton>)}
  </div>
  {loading&&<p role="status" className="hint"><BrandLoadingLabel>正在读取历史…</BrandLoadingLabel></p>}
  {error&&<div className="file-history-error" role="alert">{error}<RareButton type="button" onClick={()=>setRetry(n=>n+1)}>重试</RareButton></div>}
  {!loading&&shown.length===0&&!error&&<p className="empty">暂无匹配记录</p>}
  <div className="file-history-rail-layout">
   <nav className="file-history-month-rail" aria-label="按月份跳转">
    {grouped.map(group=><RareButton key={group.id} type="button" aria-current={activeMonth===group.id?"location":undefined}
     onClick={()=>jumpToMonth(group.id)}>{monthLabel(group.id)}</RareButton>)}
   </nav>
   <div className="file-history-scroll" ref={scroller} tabIndex={0} aria-label="文件操作记录" onScroll={updateActiveMonth}>
  {grouped.map(group=><section key={group.id} className="file-history-month-group" data-history-month={group.id}>
   <h2>{monthLabel(group.id)}</h2>
  <ol className="file-history-timeline">
   {group.items.map(item=><li key={item.id} className="file-history-item">
    <span className="file-history-point" aria-hidden="true"/>
    <div className="file-history-entry">
     <div className="file-history-row">
      <strong>{eventLabels[item.eventType]??item.eventType}</strong>
      <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString("zh-CN")}</time>
     </div>
     <span className="file-history-actor">{item.actorName||item.actorId||"系统"}{item.outcome!=="success"?" · "+item.outcome:""}</span>
     {describe(item)&&<p className="file-history-detail">{describe(item)}</p>}
    </div>
   </li>)}
  </ol>
  </section>)}
  {page.nextCursor&&<div className="file-history-footer"><RareButton type="button" disabled={more} loading={more} onClick={()=>void nextPage()}>加载更早记录</RareButton></div>}
   </div>
  </div>
 </div>;
}
