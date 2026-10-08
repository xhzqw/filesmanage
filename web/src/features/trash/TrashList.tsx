import {useEffect,useState} from "react";
import type {TrashEntry} from "../../entities/trash/model";
import {trashApi} from "./api";
import {errorCopy} from "../../shared/errors";

export function TrashList({onRestored}:{onRestored:()=>void}){
 const[entries,setEntries]=useState<TrashEntry[]>([]);
 const[status,setStatus]=useState("loading");
 const[message,setMessage]=useState("");
 const[busy,setBusy]=useState("");

 useEffect(()=>{
  let valid=true;
  trashApi.list()
   .then(data=>{if(valid){setEntries(data);setStatus("ready");}})
   .catch(()=>{if(valid)setStatus("failed");});
  return()=>{valid=false;};
 },[]);

 async function restore(entry:TrashEntry){
  setBusy(entry.id);setMessage("");
  try{
   await trashApi.restore(entry.id,"","");
   setEntries(prev=>prev.filter(e=>e.id!==entry.id));
   onRestored();
  }catch(error){
   setMessage(errorCopy(error,"恢复失败"));
  }finally{setBusy("");}
 }

 return <div className="work-body">
  <div className="toolbar"><span className="toolbar-hint">回收站中的资源仍保留完整版本历史，恢复后 ID 与版本不变。</span></div>
  {message&&<p role="alert" className="notice error">{message}</p>}
  <div className="table">
   <table>
    <thead><tr><th>名称</th><th>类型</th><th>删除人</th><th>删除时间</th><th>操作</th></tr></thead>
    <tbody>
     {status==="loading"&&<tr><td colSpan={5} className="empty">正在加载回收站…</td></tr>}
     {status==="failed"&&<tr><td colSpan={5} className="empty" role="alert">获取回收站失败，请刷新重试</td></tr>}
     {status==="ready"&&entries.length===0&&<tr><td colSpan={5} className="empty">回收站为空。</td></tr>}
     {status==="ready"&&entries.map(entry=><tr key={entry.id}>
      <td>{entry.oldName}</td>
      <td>{entry.folderId?`目录${entry.subtreeCount?"（含 "+entry.subtreeCount+" 个子项）":""}`:"文件"}</td>
      <td>{entry.deletedByName}</td>
      <td>{entry.deletedAt.replace("T"," ").slice(0,16)}</td>
      <td><button type="button" disabled={busy===entry.id}
       onClick={()=>restore(entry)}>{busy===entry.id?"恢复中…":"恢复"}</button></td>
     </tr>)}
    </tbody>
   </table>
  </div>
 </div>;
}
