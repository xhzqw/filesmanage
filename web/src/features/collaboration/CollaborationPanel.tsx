import {useEffect,useState} from "react";
import {Link} from "react-router-dom";
import {collaborationApi,formatBytes} from "./api";
import type {User} from "../../entities/user/model";

// Sharing workbench: received shares, sent shares and per-user favorites.
export function CollaborationPanel(){
 const[tab,setTab]=useState<"received"|"sent"|"favorites">("received");
 const[shares,setShares]=useState<Awaited<ReturnType<typeof collaborationApi.shares>>>([]);
 const[favorites,setFavorites]=useState<Awaited<ReturnType<typeof collaborationApi.favorites>>>([]);
 const[status,setStatus]=useState("loading");
 const[message,setMessage]=useState("");

 useEffect(()=>{
  let valid=true;
  setStatus("loading");
  if(tab==="favorites"){
   collaborationApi.favorites()
    .then(data=>{if(valid){setFavorites(data);setStatus("ready");}})
    .catch(()=>{if(valid)setStatus("failed");});
  }else{
   collaborationApi.shares(tab)
    .then(data=>{if(valid){setShares(data);setStatus("ready");}})
    .catch(()=>{if(valid)setStatus("failed");});
  }
  return()=>{valid=false;};
 },[tab,message]);

 async function unfavorite(id:string,kind:string){
  setMessage("");
  try{
   await collaborationApi.setFavorite(kind,id,false);
   setMessage("已取消关注");
  }catch{setMessage("操作失败");}
 }

 async function revoke(id:string){
  setMessage("");
  try{
   await collaborationApi.revokeShare(id);
   setMessage("已撤销分享");
  }catch{setMessage("撤销失败");}
 }

 return <div className="work-body">
  <div className="toolbar">
   <button type="button" className={tab==="received"?"on":""} onClick={()=>setTab("received")}>与我共享</button>
   <button type="button" className={tab==="sent"?"on":""} onClick={()=>setTab("sent")}>我共享的</button>
   <button type="button" className={tab==="favorites"?"on":""} onClick={()=>setTab("favorites")}>我的关注</button>
   <span className="toolbar-hint">分享仅传递 查看/预览/下载，不含写操作</span>
  </div>
  {message&&<p role="status" className="notice">{message}</p>}
  <div className="table">
   {tab==="favorites"?<table>
    <thead><tr><th>资源</th><th>类型</th><th>状态</th><th>关注时间</th><th>操作</th></tr></thead>
    <tbody>
     {status==="loading"&&<tr><td colSpan={5} className="empty">正在加载…</td></tr>}
     {status==="ready"&&favorites.length===0&&<tr><td colSpan={5} className="empty">没有关注内容。</td></tr>}
     {status==="ready"&&favorites.map(f=><tr key={f.id}>
      <td>{f.kind==="file"?<Link to={"/preview/"+f.fileId}>{f.resourceName}</Link>:<Link to={"/doc?folder="+f.folderId}>{f.resourceName}</Link>}</td>
      <td>{f.kind==="file"?"文件":"目录"}</td>
      <td>{f.unavailable?"已删除或不可访问":"正常"}</td>
      <td>{f.createdAt.replace("T"," ").slice(0,16)}</td>
      <td><button type="button" onClick={()=>unfavorite(f.kind==="file"?f.fileId??"":f.folderId??"",f.kind)}>取消关注</button></td>
     </tr>)}
    </tbody>
   </table>:<table>
    <thead><tr><th>资源</th><th>类型</th><th>接收方/来源</th><th>权限</th><th>继承子目录</th><th>截止</th><th>操作</th></tr></thead>
    <tbody>
     {status==="loading"&&<tr><td colSpan={7} className="empty">正在加载…</td></tr>}
     {status==="ready"&&shares.length===0&&<tr><td colSpan={7} className="empty">没有{tab==="received"?"收到的":"发出的"}分享。</td></tr>}
     {status==="ready"&&shares.map(s=><tr key={s.id}>
      <td>{s.resourceKind==="file"?<Link to={"/preview/"+s.resourceId}>{s.resourceName}</Link>:<Link to={"/doc?folder="+s.resourceId}>{s.resourceName}</Link>}</td>
      <td>{s.resourceKind==="file"?"文件":"目录"}</td>
      <td>{tab==="received"?s.recipientName:(s.recipientName||"—")}</td>
      <td>{s.actions.join("、")}</td>
      <td>{s.includeDescendants?"是":"否"}</td>
      <td>{s.expiresAt?s.expiresAt.slice(0,10):"长期"}</td>
      <td>{tab==="sent"&&!s.revoked&&<button type="button" className="danger" onClick={()=>revoke(s.id)}>撤销</button>}</td>
     </tr>)}
    </tbody>
   </table>}
  </div>
  <p className="hint">{formatBytes(0)==="0 B"?"":" "}统计与导出请前往「统计」页。</p>
 </div>;
}
