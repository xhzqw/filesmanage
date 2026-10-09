import {useEffect,useState,type ChangeEvent,type FormEvent} from "react";
import type {FileItem} from "../../entities/file/model";
import {fileApi,formatSize,uploadFile} from "./api";
import {errorCode} from "../../shared/errors";
import {newIdempotencyKey} from "../../shared/ids";

type SortKey="updated_desc"|"name_asc"|"name_desc"|"size_desc";

const SORT_LABELS:Record<SortKey,string>={
 updated_desc:"最近修改",
 name_asc:"名称 A→Z",
 name_desc:"名称 Z→A",
 size_desc:"大小降序",
};

const SORT_KEYS:SortKey[]=["updated_desc","name_asc","name_desc","size_desc"];

export function FileTable({folder,folderName,onEdit,reloadKey}:{folder:string;folderName:string;onEdit:(fileId:string)=>void;reloadKey:number}){
 const[items,setItems]=useState<FileItem[]>([]);
 const[status,setStatus]=useState("loading");
 const[message,setMessage]=useState("");
 const[messageTone,setMessageTone]=useState<"info"|"error">("info");
 const[sort,setSort]=useState<SortKey>("updated_desc");
 const[cursor,setCursor]=useState("");
 const[hasMore,setHasMore]=useState(false);
 const[uploading,setUploading]=useState(false);
 const[renaming,setRenaming]=useState<FileItem|null>(null);
 const[renameValue,setRenameValue]=useState("");

 useEffect(()=>{
  let valid=true;
  setStatus("loading");
  fileApi.list(folder,sort,"",50)
   .then(page=>{
    if(!valid)return;
    setItems(page.items);
    setHasMore(page.nextCursor!=="");
    setCursor(page.nextCursor);
    setStatus("ready");
   })
   .catch(()=>{if(valid)setStatus("failed");});
  return()=>{valid=false;};
 },[folder,sort,reloadKey]);

 function announce(text:string,tone:"info"|"error"){
  setMessage(text);
  setMessageTone(tone);
 }

 async function reload(){
  const page=await fileApi.list(folder,sort,"",50);
  setItems(page.items);setHasMore(page.nextCursor!=="");setCursor(page.nextCursor);
 }

 async function onUpload(event:ChangeEvent<HTMLInputElement>){
  const file=event.target.files?.[0];
  event.target.value="";
  if(!file)return;
  setUploading(true);announce("","info");
  try{
   await uploadFile(folder,file,newIdempotencyKey());
   await reload();
   announce(`已上传 ${file.name}，生成 v1 新版本`,"info");
  }catch(error){
   const code=errorCode(error);
   announce(code==="E_NAME_CONFLICT"?"同名文件已存在，请改名后上传":code==="E_FORBIDDEN"?"当前目录没有上传权限":"上传失败，请重试","error");
  }finally{setUploading(false);}
 }

 async function loadMore(){
  if(!cursor)return;
  const page=await fileApi.list(folder,sort,cursor,50);
  setItems(prev=>[...prev,...page.items]);
  setCursor(page.nextCursor);
  setHasMore(page.nextCursor!=="");
 }

 async function onDelete(item:FileItem){
  if(!window.confirm(`删除后将进入回收站，可恢复。确定删除「${item.name}」？`))return;
  announce("","info");
  try{
   await fileApi.remove(item.id);
   setItems(prev=>prev.filter(f=>f.id!==item.id));
   announce(`已移入回收站：${item.name}`,"info");
  }catch{announce("删除失败，请重试","error");}
 }

 async function submitRename(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(!renaming)return;
  announce("","info");
  try{
   const updated=await fileApi.rename(renaming.id,renameValue);
   setItems(prev=>prev.map(f=>f.id===updated.id?updated:f));
   setRenaming(null);
   announce("重命名成功","info");
  }catch(error){
   announce(errorCode(error)==="E_NAME_CONFLICT"?"目标名称已存在":"重命名失败：名称冲突或无权操作","error");
  }
 }

 return <div className="work-body">
  <div className="toolbar">
   <label className="upload-button">
    {uploading?"上传中…":"上传文件"}
    <input type="file" onChange={onUpload} disabled={uploading}/>
   </label>
   <label className="sort-label">排序
    <select aria-label="排序方式" value={sort} onChange={e=>setSort(e.target.value as SortKey)}>
     {SORT_KEYS.map(key=><option key={key} value={key}>{SORT_LABELS[key]}</option>)}
    </select>
   </label>
   <span className="toolbar-hint">{folderName}</span>
  </div>
  {message&&<p role="status" className={"notice "+messageTone}>{message}</p>}
  <div className="table">
   <table>
    <thead><tr><th>文件名</th><th>大小</th><th>版本</th><th>校验值</th><th>修改日期</th><th>操作</th></tr></thead>
    <tbody>
     {status==="loading"&&<tr><td colSpan={6} className="empty">正在加载文件…</td></tr>}
     {status==="failed"&&<tr><td colSpan={6} className="empty" role="alert">获取文件失败，请刷新重试</td></tr>}
     {status==="ready"&&items.length===0&&<tr><td colSpan={6} className="empty">目录为空。上传第一个文件开始使用。</td></tr>}
     {status==="ready"&&items.map(item=><tr key={item.id}>
      <td><a href={"/preview/"+item.id}>{item.name}</a></td>
      <td>{formatSize(item.sizeBytes)}</td>
      <td>v{item.currentVersionSeq}</td>
      <td className="hash" title={item.sha256}>{item.sha256.slice(0,12)}…</td>
      <td>{item.updatedAt.replace("T"," ").slice(0,16)}</td>
      <td className="row-actions">
       <a href={"/api/files/"+item.id+"/bytes"} download={item.name}>下载</a>
       <button type="button" onClick={()=>onEdit(item.id)}>编辑</button>
       <button type="button" onClick={()=>{setRenaming(item);setRenameValue(item.name);}}>重命名</button>
       <button type="button" className="danger" onClick={()=>onDelete(item)}>删除</button>
      </td>
     </tr>)}
    </tbody>
   </table>
  </div>
  {hasMore&&<button type="button" className="secondary-action" onClick={loadMore}>加载更多</button>}
  {renaming&&<dialog open className="dialog">
   <form onSubmit={submitRename}>
    <h3>重命名文件</h3>
    <label htmlFor="rename-input">新名称</label>
    <input id="rename-input" value={renameValue} maxLength={200} onChange={e=>setRenameValue(e.target.value)} required/>
    <div className="dialog-actions">
     <button type="button" className="secondary-action" onClick={()=>setRenaming(null)}>取消</button>
     <button type="submit" className="primary">保存</button>
    </div>
   </form>
  </dialog>}
 </div>;
}
