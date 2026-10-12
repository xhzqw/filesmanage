import {RareButton,RareInput} from "../../shared/ui/rare";
import {toast} from "../../shared/ui/feedback";
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
 const[locationChanged,setLocationChanged]=useState(false);
 const[explicitChoice,setExplicitChoice]=useState(false);
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
    const current=entry.oldParentId?trailOf(data,entry.oldParentId):[];
    const original=entry.oldParentTrail??[];
    const same=original.length>0&&current.length===original.length&&current.every((v,i)=>v.id===original[i]?.id&&v.name===original[i]?.name);
    setLocationChanged(!same);
    setExplicitChoice(false);
    if(same&&entry.oldParentId){
     setTargetId(entry.oldParentId);
     setStage("confirm");
    }else{
     setTargetId("");
     setStage("pick");
    }
   })
   .catch(()=>{if(valid)setTreeState("failed");});
  return()=>{valid=false;};
 },[entry.oldParentId,entry.oldParentTrail,reloadToken]);

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
   await trashApi.restore(entry.id,targetId,renamed,explicitChoice);
   toast.success("资源已恢复");
   onRestored();
  }catch(error){
   const code=errorCode(error);
   if(code==="E_NAME_CONFLICT"){
    setStage("rename");
    setMessage(errorCopy(error,"名称已存在，请更换"));
    toast.warning("恢复遇到同名资源，请修改名称后重试");
   }else if(code==="E_PARENT_MISSING"){
    setLocationChanged(true);setExplicitChoice(false);setTargetId("");setStage("pick");
    setMessage(errorCopy(error,"原目录位置已变化，请重新选择恢复目录"));
    toast.warning("原恢复位置已变化，请重新选择目录");
   }else if(code==="E_NETWORK"){
    // The request outcome is unknown: never claim the restore completed.
    setUnknown(true);
    setMessage("网络中断，无法确认是否已恢复，请刷新查看状态。");
    toast.warning("恢复结果未确认，请刷新回收站后核对");
   }else{
    setMessage(errorCopy(error,"恢复失败"));
    toast.error(errorCopy(error,"恢复失败"));
   }
  }finally{
   setBusy(false);
  }
 }

 return <Dialog open title={`恢复 — ${entry.oldName}`} onClose={onClose} closeGuard={()=>!busy} className="dialog restore-dialog">
  {stage==="loading"&&treeState==="loading"&&<p className="empty">正在读取目录…</p>}
  {treeState==="failed"&&<>
   <p role="alert" className="notice error">获取目录失败，无法确认原位置是否可用。</p>
   <RareButton type="button" className="secondary-action" onClick={()=>setReloadToken(token=>token+1)} disabled={busy}>重试</RareButton>
  </>}
  {treeState==="ready"&&stage==="pick"&&<>
   <p className="hint">{locationChanged?"原目录已变化、不可访问，或缺少历史路径记录。请选择恢复位置。":"请选择恢复位置。"}</p>
   {entry.oldParentPath&&<p className="hint">删除时所在目录：{entry.oldParentPath}</p>}
   {rows.length===0&&<p className="empty">没有可选择的目标目录。</p>}
   <div role="radiogroup" aria-label="选择目标目录" className="group-list" style={{maxHeight:"220px",overflow:"auto"}}>
    {rows.map(({folder,depth})=><RareButton key={folder.id} type="button" role="radio"
     aria-checked={targetId===folder.id}
     className={targetId===folder.id?"on":""}
     style={{paddingLeft:String(8+Math.min(depth,8)*14)+"px"}}
     disabled={busy}
     onClick={()=>{setTargetId(folder.id);setExplicitChoice(true);}}>{folder.name}</RareButton>)}
   </div>
  </>}
  {treeState==="ready"&&stage==="confirm"&&<>
   <p>类型：{entry.folderId?`目录${entry.subtreeCount?`（含 ${entry.subtreeCount} 个子项）`:""}`:"文件"}</p>
   <p>名称：{entry.oldName}</p>
   <p>删除时位置：{entry.oldParentPath||"历史位置未记录"}</p>
   {originalPath&&<p>目前位置：{originalPath}</p>}
   <p>目标位置：{targetPath}</p>
  </>}
  {treeState==="ready"&&stage==="rename"&&<>
   <p>目标位置：{targetPath}</p>
   <RareButton type="button" className="secondary-action" disabled={busy} onClick={()=>setStage("pick")}>更改目标目录</RareButton>
   <label htmlFor="restore-name">新名称</label>
   <RareInput id="restore-name" value={newName} onChange={e=>setNewName(e.target.value)} disabled={busy}/>
   <p className="hint">仅当名称与原名不同时才会提交新名称，服务端保留最终命名权。</p>
  </>}
  {message&&<p role="alert" className="notice error">{message}</p>}
  <div className="dialog-actions">
   {unknown&&<RareButton type="button" className="secondary-action" onClick={onReload} disabled={busy}>刷新查看状态</RareButton>}
   <RareButton type="button" className="secondary-action" onClick={onClose} disabled={busy}>取消</RareButton>
   {treeState==="ready"&&stage==="pick"&&<RareButton type="button" className="primary" disabled={busy||targetId===""} onClick={()=>setStage("confirm")}>使用所选目录</RareButton>}
   {treeState==="ready"&&stage==="confirm"&&<>
    <RareButton type="button" className="secondary-action" onClick={()=>setStage("pick")} disabled={busy}>更改目标目录</RareButton>
    <RareButton type="button" className="primary" onClick={submit} disabled={busy||targetId===""}>{busy?"恢复中…":"确认恢复"}</RareButton>
   </>}
   {treeState==="ready"&&stage==="rename"&&<RareButton type="button" className="primary" onClick={submit} disabled={busy||newName.trim()===""}>{busy?"恢复中…":"以新名称恢复"}</RareButton>}
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

// A complete ancestor trail is required: inaccessible or removed ancestors
// are not treated as a matching location.
function trailOf(folders:Folder[],id:string):{id:string;name:string}[]{
 const byId=new Map(folders.map(f=>[f.id,f]));
 const out:{id:string;name:string}[]=[];
 const visited=new Set<string>();
 let current:string|null=id;
 while(current){
  if(visited.has(current)||out.length>=64)return [];
  visited.add(current);
  const folder=byId.get(current);
  if(!folder)return [];
  out.unshift({id:folder.id,name:folder.name});
  current=folder.parentId;
 }
 return out;
}
