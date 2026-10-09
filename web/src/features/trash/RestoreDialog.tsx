import {useEffect,useMemo,useState}from"react";
import {request}from"../../shared/http";
import type {Folder}from"../../entities/folder/model";
import type {TrashEntry}from"../../entities/trash/model";
import {trashApi}from"./api";
import {errorCode,errorCopy}from"../../shared/errors";
import {Dialog}from"../../shared/ui/Dialog";

// Trash restore (COMPLEX-WORKFLOWS-v1 §8, WF-17..WF-20). The row click is the
// chooseSource step (the entry fixes the source); the dialog then defaults to
// the entry's original parent folder and only routes to the target picker
// (resolveParent) when that parent is gone, instead of silently retrying with
// an empty destination. A same-name conflict moves to resolveConflict with a
// custom new name; the server stays the authority, so only a user-changed name
// is sent and every rejection keeps the user on a step where the target or
// name can be changed and retried.
export function RestoreDialog({entry,onClose,onRestored,onReload}:{
 entry:TrashEntry;
 onClose:()=>void;
 onRestored:()=>void;
 onReload:()=>void;
}){
 const[folders,setFolders]=useState<Folder[]>([]);
 const[treeState,setTreeState]=useState<"loading"|"ready"|"failed">("loading");
 const[stage,setStage]=useState<"loading"|"pick"|"confirm"|"rename">("loading");
 const[targetId,setTargetId]=useState("");
 const[newName,setNewName]=useState(entry.oldName);
 const[busy,setBusy]=useState(false);
 const[message,setMessage]=useState("");
 const[unknown,setUnknown]=useState(false);
 const[reloadToken,setReloadToken]=useState(0);

 useEffect(()=>{
  let valid=true;
  setTreeState("loading");
  // The visible tree is read through the shared JSON client so the trash
  // feature stays independent of the folders feature module.
  request<Folder[]>("/folders/tree")
   .then(data=>{
    if(!valid)return;
    setFolders(data);
    setTreeState("ready");
    if(entry.oldParentId&&data.some(f=>f.id===entry.oldParentId)){
     setTargetId(entry.oldParentId);
     setStage("confirm");
    }else{
     setTargetId("");
     setStage("pick");
    }
   })
   .catch(()=>{if(valid)setTreeState("failed");});
  return()=>{valid=false;};
 },[entry.oldParentId,reloadToken]);

 // Flat tree order with depth from visible parents only: a folder whose
 // parent is outside the visible set renders as a root, and hidden ancestors
 // are never invented.
 const rows=useMemo(()=>{
  const byId=new Map(folders.map(f=>[f.id,f]));
  const childrenOf=new Map<string,Folder[]>();
  for(const folder of folders){
   const key=folder.parentId!==null&&byId.has(folder.parentId)?folder.parentId:"";
   const list=childrenOf.get(key);
   if(list)list.push(folder);else childrenOf.set(key,[folder]);
  }
  const out:{folder:Folder;depth:number}[]=[];
  const walk=(parentId:string,depth:number)=>{
   if(depth>32)return;
   for(const folder of childrenOf.get(parentId)??[]){
    out.push({folder,depth});
    walk(folder.id,depth+1);
   }
  };
  walk("",0);
  return out;
 },[folders]);

 const targetPath=useMemo(()=>pathOf(folders,targetId),[folders,targetId]);
 const originalPath=entry.oldParentId?pathOf(folders,entry.oldParentId):"";

 async function submit(){
  if(busy||targetId==="")return;
  if(stage==="rename"&&newName.trim()==="")return;
  setBusy(true);setMessage("");setUnknown(false);
  // Only a user-chosen name is sent; an unchanged name keeps the server's
  // default resolution and its authority over the final name.
  const renamed=newName.trim()!==entry.oldName?newName.trim():"";
  try{
   await trashApi.restore(entry.id,targetId,renamed);
   onRestored();
  }catch(error){
   const code=errorCode(error);
   if(code==="E_NAME_CONFLICT"){
    setStage("rename");
    setMessage(errorCopy(error,"名称已存在，请更换"));
   }else if(code==="E_PARENT_MISSING"){
    // Stay on the confirm step: the target is gone, so offer the picker.
    setMessage(errorCopy(error,"原位置已不存在，请选择目标目录"));
   }else if(code==="E_NETWORK"){
    // The request outcome is unknown: never claim the restore completed.
    setUnknown(true);
    setMessage("网络中断，无法确认是否已恢复，请刷新查看状态。");
   }else{
    setMessage(errorCopy(error,"恢复失败"));
   }
  }finally{
   setBusy(false);
  }
 }

 return <Dialog open title={`恢复 — ${entry.oldName}`} onClose={onClose} closeGuard={()=>!busy} className="dialog restore-dialog">
  {stage==="loading"&&treeState==="loading"&&<p className="empty">正在读取目录…</p>}
  {treeState==="failed"&&<>
   <p role="alert" className="notice error">获取目录失败，无法确认原位置是否可用。</p>
   <button type="button" className="secondary-action" onClick={()=>setReloadToken(token=>token+1)} disabled={busy}>重试</button>
  </>}
  {treeState==="ready"&&stage==="pick"&&<>
   <p className="hint">{entry.oldParentId?"原位置已不存在或不可访问，请选择目标目录。":"请选择目标目录。"}</p>
   {rows.length===0&&<p className="empty">没有可选择的目标目录。</p>}
   <div role="radiogroup" aria-label="选择目标目录" className="group-list" style={{maxHeight:"220px",overflow:"auto"}}>
    {rows.map(({folder,depth})=><button key={folder.id} type="button" role="radio"
     aria-checked={targetId===folder.id}
     className={targetId===folder.id?"on":""}
     style={{paddingLeft:String(8+Math.min(depth,8)*14)+"px"}}
     disabled={busy}
     onClick={()=>setTargetId(folder.id)}>{folder.name}</button>)}
   </div>
  </>}
  {treeState==="ready"&&stage==="confirm"&&<>
   <p>类型：{entry.folderId?`目录${entry.subtreeCount?`（含 ${entry.subtreeCount} 个子项）`:""}`:"文件"}</p>
   <p>名称：{entry.oldName}</p>
   <p>原位置：{originalPath||"原位置已不存在"}</p>
   <p>目标位置：{targetPath}</p>
  </>}
  {treeState==="ready"&&stage==="rename"&&<>
   <p>目标位置：{targetPath}</p>
   <label htmlFor="restore-name">新名称</label>
   <input id="restore-name" value={newName} onChange={e=>setNewName(e.target.value)} disabled={busy}/>
   <p className="hint">仅当名称与原名不同时才会提交新名称，服务端保留最终命名权。</p>
  </>}
  {message&&<p role="alert" className="notice error">{message}</p>}
  <div className="dialog-actions">
   {unknown&&<button type="button" className="secondary-action" onClick={onReload} disabled={busy}>刷新查看状态</button>}
   <button type="button" className="secondary-action" onClick={onClose} disabled={busy}>取消</button>
   {treeState==="ready"&&stage==="pick"&&<button type="button" className="primary" disabled={busy||targetId===""} onClick={()=>setStage("confirm")}>使用所选目录</button>}
   {treeState==="ready"&&stage==="confirm"&&<>
    <button type="button" className="secondary-action" onClick={()=>setStage("pick")} disabled={busy}>更改目标目录</button>
    <button type="button" className="primary" onClick={submit} disabled={busy||targetId===""}>{busy?"恢复中…":"确认恢复"}</button>
   </>}
   {treeState==="ready"&&stage==="rename"&&<button type="button" className="primary" onClick={submit} disabled={busy||newName.trim()===""}>{busy?"恢复中…":"以新名称恢复"}</button>}
  </div>
 </Dialog>;
}

// Visible-ancestor path only: an ancestor outside the caller's visible set is
// never invented or leaked.
function pathOf(folders:Folder[],id:string):string{
 const byId=new Map(folders.map(f=>[f.id,f]));
 const names:string[]=[];
 const seen=new Set<string>();
 let current=byId.get(id);
 while(current&&!seen.has(current.id)){
  seen.add(current.id);
  names.unshift(current.name);
  const parentId=current.parentId;
  current=parentId!==null?byId.get(parentId):undefined;
 }
 return names.join(" / ");
}
