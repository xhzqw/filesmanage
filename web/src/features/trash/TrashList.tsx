import {RareButton,RareNotice} from "../../shared/ui/rare";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {toast} from "../../shared/ui/feedback";
import {useEffect,useState} from "react";
import type {TrashEntry} from "../../entities/trash/model";
import {trashApi} from "./api";
import {RestoreDialog} from "./RestoreDialog";
import {request} from "../../shared/http";
import {errorCode,errorCopy} from "../../shared/errors";
import {Dialog} from "../../shared/ui/Dialog";
import {MicroHoldToDelete} from "../../shared/ui/rare";

export function TrashList({onRestored}:{onRestored:()=>void}){
 const[entries,setEntries]=useState<TrashEntry[]>([]);
 const[status,setStatus]=useState("loading");
 const[restoring,setRestoring]=useState<TrashEntry|null>(null);
 const[reloadToken,setReloadToken]=useState(0);
 const[purgeTarget,setPurgeTarget]=useState<TrashEntry|null>(null);
 const[purgeStage,setPurgeStage]=useState<"impact"|"final">("impact");
 const[purgeBusy,setPurgeBusy]=useState(false);
 const[purgeMessage,setPurgeMessage]=useState("");
 const[purgeUnknown,setPurgeUnknown]=useState(false);
 const[isAdmin,setIsAdmin]=useState(false);

 useEffect(()=>{
  let valid=true;
  setStatus("loading");
  trashApi.list()
   .then(data=>{if(valid){setEntries(data);setStatus("ready");}})
   .catch(()=>{if(valid)setStatus("failed");});
  return()=>{valid=false;};
 },[reloadToken]);

 // Purge is admin-only on the server (application.PurgeTrashEntry), and a
 // capability the caller does not hold must not be offered at all. The trash
 // page threads no user down and the layer gate forbids features -> app, so the
 // flag comes from the same /me endpoint the shell reads; a failed read hides
 // the button instead of implying a right that was never confirmed.
 useEffect(()=>{
  let valid=true;
  request<{isAdmin:boolean}>("/me")
   .then(user=>{if(valid)setIsAdmin(user.isAdmin);})
   .catch(()=>{if(valid)setIsAdmin(false);});
  return()=>{valid=false;};
 },[]);


 // Purge destroys the entry and its version history for good; the two dialog
 // stages are the required second confirmation, and the server re-checks the
 // admin right and the entry state on every submit.
 function askPurge(entry:TrashEntry){
  setPurgeMessage("");setPurgeUnknown(false);setPurgeStage("impact");setPurgeTarget(entry);
 }

 async function confirmPurge(){
  const entry=purgeTarget;
  if(!entry||purgeBusy)return;
  setPurgeBusy(true);setPurgeMessage("");setPurgeUnknown(false);
  try{
   await trashApi.purge(entry.id);
  }catch(error){
   if(errorCode(error)==="E_NETWORK"){
    // The request outcome is unknown: never claim the entry was destroyed.
    setPurgeUnknown(true);
    setPurgeMessage("网络中断，无法确认是否已永久删除，请刷新回收站查看状态。");
   }else{
    setPurgeMessage(errorCopy(error,"永久删除失败"));
   }
   setPurgeBusy(false);
   return;
  }
  setPurgeTarget(null);
  toast.success("已永久删除");
  setReloadToken(token=>token+1);
  setPurgeBusy(false);
 }

 return <div className="work-body">
  <div className="toolbar"><span className="toolbar-hint">回收站中的资源仍保留完整版本历史，恢复后 ID 与版本不变。</span></div>
  <div className="table">
   <table>
    <thead><tr><th scope="col">名称</th><th scope="col">类型</th><th scope="col">删除人</th><th scope="col">删除时间</th><th scope="col">操作</th></tr></thead>
    <tbody>
     {status==="loading"&&<tr><td colSpan={5} className="empty"><BrandLoadingLabel size="sm">正在加载回收站…</BrandLoadingLabel></td></tr>}
     {status==="failed"&&<tr><td colSpan={5} className="empty" role="alert">获取回收站失败，请刷新重试</td></tr>}
     {status==="ready"&&entries.length===0&&<tr><td colSpan={5} className="empty">回收站为空。</td></tr>}
     {status==="ready"&&entries.map(entry=><tr key={entry.id}>
      <td>{entry.oldName}</td>
      <td>{entry.folderId?`目录${entry.subtreeCount?"（含 "+entry.subtreeCount+" 个子项）":""}`:"文件"}</td>
      <td>{entry.deletedByName}</td>
      <td>{entry.deletedAt.replace("T"," ").slice(0,16)}</td>
      <td className="row-actions">
       <RareButton type="button" disabled={restoring!==null||purgeTarget!==null}
        onClick={()=>setRestoring(entry)}>恢复</RareButton>
       {isAdmin&&<RareButton type="button" tone="danger" className="danger" disabled={restoring!==null||purgeTarget!==null}
        onClick={()=>askPurge(entry)}>永久删除</RareButton>}
      </td>
     </tr>)}
    </tbody>
   </table>
  </div>
  {restoring&&<RestoreDialog entry={restoring}
   onClose={()=>setRestoring(null)}
   onReload={()=>setReloadToken(token=>token+1)}
   onRestored={()=>{setRestoring(null);setReloadToken(token=>token+1);onRestored();}}/>}
  {purgeTarget&&<Dialog open title="永久删除确认" onClose={()=>setPurgeTarget(null)} closeGuard={()=>!purgeBusy}
   initialFocus={purgeStage==="final"?"#purge-back":"#purge-cancel"} className="dialog">
   <RareNotice tone="danger">永久删除不可逆：资源及其全部版本历史将被永久移除，无法恢复，也不会保留在回收站中。</RareNotice>
   <p>名称：{purgeTarget.oldName}</p>
   <p>类型：{purgeTarget.folderId?`目录${purgeTarget.subtreeCount?`（含 ${purgeTarget.subtreeCount} 个子项）`:""}`:"文件"}</p>
   <p>删除人：{purgeTarget.deletedByName}；删除时间：{purgeTarget.deletedAt.replace("T"," ").slice(0,16)}</p>
   {purgeStage==="impact"&&<p className="hint">继续后仍会要求再次确认才会执行；如需保留可恢复的途径，请取消并让该资源继续留在回收站。</p>}
   {purgeStage==="final"&&<RareNotice tone="danger">再次确认：将永久移除「{purgeTarget.oldName}」及其版本历史，此操作无法撤销。</RareNotice>}
   {purgeMessage&&<RareNotice tone="danger">{purgeMessage}</RareNotice>}
   <div className="dialog-actions">
    {purgeUnknown&&<RareButton type="button" className="secondary-action" disabled={purgeBusy}
     onClick={()=>{setReloadToken(token=>token+1);setPurgeTarget(null);}}>刷新回收站</RareButton>}
    <RareButton type="button" id="purge-cancel" className="secondary-action" onClick={()=>setPurgeTarget(null)} disabled={purgeBusy}>取消</RareButton>
    {purgeStage==="impact"
     ?<RareButton type="button" tone="primary" className="primary" disabled={purgeBusy} onClick={()=>setPurgeStage("final")}>继续（下一步）</RareButton>
     :<>
      <RareButton type="button" id="purge-back" className="secondary-action" disabled={purgeBusy} onClick={()=>setPurgeStage("impact")}>返回</RareButton>
      {/* 长按确认取代第三次点击：误触不会立刻销毁版本历史（spec §6.3） */}
      <MicroHoldToDelete label="确认永久删除" tone="danger" disabled={purgeBusy} onConfirm={confirmPurge}/>
     </>}
   </div>
  </Dialog>}
 </div>;
}
