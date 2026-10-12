import {useEffect,useRef,useState,type FormEvent} from "react";
import {RareBadge,RareButton,RareDataTable,RareInput,RareNotice} from "../../shared/ui/rare";
import {errorCopy} from "../../shared/errors";
import {permissionsApi,type PermissionAuditPage} from "./permissionsApi";

// Admin/global auditor activity page, separate from direct ACL editing.
const eventNames:Record<string,string>={
 "file.upload":"上传","file.save":"保存新版本","file.rollback":"版本回滚",
 "file.delete":"删除","file.rename":"重命名","file.move":"移动",
 "file.metadata_update":"更新分类","trash.restore":"从回收站恢复",
 "trash.purge":"永久删除","approval.approve":"审批通过","approval.reject":"审批拒绝",
 "approval.request":"申请审批","office.save_commit":"在线编辑保存",
};
const empty:PermissionAuditPage={items:[],nextCursor:""};
type Filters={fileId:string;actorId:string;event:string};
export function DocumentActivityPanel(){
 const[fileId,setFileId]=useState("");
 const[actorId,setActorId]=useState("");
 const[event,setEvent]=useState("");
 const[filters,setFilters]=useState<Filters>({fileId:"",actorId:"",event:""});
 const[page,setPage]=useState<PermissionAuditPage>(empty);
 const[state,setState]=useState<"loading"|"ready"|"failed">("loading");
 const[more,setMore]=useState(false);
 const[error,setError]=useState("");
 const[revision,setRevision]=useState(0);
 const epoch=useRef(0),busy=useRef(false);
 useEffect(()=>{
  const gen=++epoch.current;let live=true;busy.current=false;setState("loading");setError("");setPage(empty);
  permissionsApi.documentAudit({...filters}).then(data=>{if(live&&gen===epoch.current){setPage(data);setState("ready");}})
   .catch(err=>{if(live&&gen===epoch.current){setError(errorCopy(err,"读取审计记录失败"));setState("failed");}});
  return()=>{live=false;epoch.current++;};
 },[filters,revision]);
 function search(e:FormEvent){e.preventDefault();setFilters({fileId:fileId.trim(),actorId:actorId.trim(),event:event.trim()});}
 async function loadMore(){
  if(!page.nextCursor||busy.current)return;
  const gen=epoch.current,cursor=page.nextCursor;busy.current=true;setMore(true);
  try{
   const next=await permissionsApi.documentAudit({...filters,cursor});
   if(gen!==epoch.current)return;
   setPage(old=>({items:[...old.items,...next.items.filter(item=>!old.items.some(x=>x.id===item.id))],nextCursor:next.nextCursor}));
   setError("");
  }catch(err){if(gen===epoch.current)setError(errorCopy(err,"后续记录读取失败"));}
  finally{if(gen===epoch.current){setMore(false);busy.current=false;}}
 }
 return <section className="perm-audit document-activity" aria-label="文档活动审计">
  <form className="document-audit-filter" onSubmit={search}>
   <label>文件 ID<RareInput value={fileId} onChange={e=>setFileId(e.target.value)} placeholder="全部文件"/></label>
   <label>操作人 ID<RareInput value={actorId} onChange={e=>setActorId(e.target.value)} placeholder="全部人员"/></label>
   <label>事件前缀<RareInput value={event} onChange={e=>setEvent(e.target.value)} placeholder="如 file."/></label>
   <RareButton type="submit" className="primary">筛选</RareButton>
   <RareButton type="button" onClick={()=>setRevision(i=>i+1)}>刷新</RareButton>
  </form>
  {state==="loading"&&<p role="status" className="hint">正在读取文档活动…</p>}
  {error&&<RareNotice tone="danger">{error}</RareNotice>}
  {state==="failed"&&<RareButton onClick={()=>setRevision(i=>i+1)}>重试</RareButton>}
  {state==="ready"&&<div className="perm-audit-scroll">
   <RareDataTable className="perm-table">
    <thead><tr><th>时间</th><th>事件</th><th>操作人</th><th>资源</th><th>结果</th><th>请求追踪</th></tr></thead>
    <tbody>{page.items.map(item=><tr key={item.id}>
     <td>{item.createdAt?new Date(item.createdAt).toLocaleString("zh-CN"):"—"}</td>
     <td>{eventNames[item.eventType]??item.eventType}</td>
     <td>{item.actorId}</td>
     <td>{item.targetKind} · {item.targetId}</td>
     <td><RareBadge tone={item.outcome==="success"?"success":"danger"}>{item.outcome==="success"?"成功":"失败"}</RareBadge></td>
     <td><code title={item.requestId}>{item.requestId||"—"}</code></td>
    </tr>)}</tbody>
   </RareDataTable>
   {page.items.length===0&&<p className="empty">没有符合条件的文档活动。</p>}
   {page.nextCursor&&<RareButton className="perm-more" type="button" disabled={more} onClick={()=>void loadMore()}>{more?"加载中…":"加载更多"}</RareButton>}
  </div>}
 </section>;
}
