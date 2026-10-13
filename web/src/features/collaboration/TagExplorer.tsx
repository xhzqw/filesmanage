import {useEffect,useState,type MouseEvent} from "react";
import {Link,useLocation} from "react-router-dom";
import type {TaggedFile} from "../../shared/finderLabels";
import {RareButton} from "../../shared/ui/rare";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {Menu,type MenuPoint} from "../../shared/ui/Menu";
import {FileTypeIcon} from "../../shared/ui/FileTypeIcon";
import {toast} from "../../shared/ui/feedback";
import {errorCopy} from "../../shared/errors";
import {FINDER_COLORS,finderColor,labelApi,type FinderLabel} from "../../shared/finderLabels";
import "./tagExplorer.css";

function compactSize(bytes:number){return bytes<1024?bytes+" B":bytes<1048576?(bytes/1024).toFixed(1)+" KB":(bytes/1048576).toFixed(1)+" MB";}
export function TagExplorer(){
 const location=useLocation();
 const labelId=new URLSearchParams(location.search).get("label")||"";
 const [labels,setLabels]=useState<FinderLabel[]>([]);
 const [files,setFiles]=useState<TaggedFile[]>([]);
 const [assignments,setAssignments]=useState<Record<string,string[]>>({});
 const [loading,setLoading]=useState(true);
 const [failure,setFailure]=useState("");
 const [revision,setRevision]=useState(0);
 const [menu,setMenu]=useState<{file:TaggedFile;point:MenuPoint;anchor:HTMLElement}|null>(null);
 const [busy,setBusy]=useState(false);
 const active=labels.find(label=>label.id===labelId);
 useEffect(()=>{
  const refresh=()=>setRevision(value=>value+1);
  window.addEventListener("filesmanage:labels-change",refresh);
  return()=>window.removeEventListener("filesmanage:labels-change",refresh);
 },[]);
 useEffect(()=>{
  let mounted=true;setFailure("");setLoading(true);
  labelApi.list().then(async list=>{
   if(!mounted)return;
   setLabels(list);
   if(!labelId){setFiles([]);setAssignments({});setLoading(false);return;}
   if(!list.some(label=>label.id===labelId)){setFiles([]);setLoading(false);setFailure("标签不存在或已被删除");return;}
   const page=await labelApi.files(labelId);
   if(!mounted)return;
   setFiles(page.items);
   const ids=page.items.slice(0,100).map(file=>file.id);
   setAssignments(ids.length?await labelApi.assignments(ids):{});
   if(mounted)setLoading(false);
  }).catch(error=>{if(mounted){setFailure(errorCopy(error,"加载标签文件失败"));setLoading(false);}});
  return()=>{mounted=false;};
 },[labelId,revision]);
 async function mark(label:FinderLabel,file:TaggedFile){
  if(busy)return;
  const add=!(assignments[file.id]??[]).includes(label.id);
  setBusy(true);
  try{
   await labelApi.setFiles(label.id,[file.id],add);
   toast.success(add?"已添加标签":"已移除标签");
  }catch(error){toast.error(errorCopy(error,"修改标签失败"));}
  finally{setBusy(false);}
 }
 function context(event:MouseEvent<HTMLElement>,file:TaggedFile){
  event.preventDefault();
  setMenu({file,point:{x:event.clientX,y:event.clientY},anchor:event.currentTarget});
 }
 return <section className="tag-explorer">
  <header className="tag-explorer-head">
   <div className="tag-explorer-title">
    {active&&<span className="finder-tag-dot" style={{backgroundColor:finderColor(active.color)}}/>}
    <strong>{active?.name??"所有标签"}</strong>
   </div>
   {active&&<span className="tag-explorer-count">{loading?"":files.length+" 个文件"}</span>}
  </header>
  {!labelId&&<div className="tag-explorer-overview">
   {labels.map(label=><Link key={label.id} to={"/doc?view=labels&label="+encodeURIComponent(label.id)} className="tag-explorer-choice">
    <span className="finder-tag-dot" style={{backgroundColor:finderColor(label.color)}}/>
    <span>{label.name}</span>
   </Link>)}
   <p className="tag-explorer-hint">选择标签即可查看所有目录中符合权限的文件。</p>
  </div>}
  {labelId&&loading&&<p className="tag-explorer-message" role="status"><BrandLoadingLabel decorative>正在加载标签文件…</BrandLoadingLabel></p>}
  {labelId&&failure&&<div className="tag-explorer-message" role="alert">{failure} <RareButton type="button" onClick={()=>setRevision(v=>v+1)}>重试</RareButton></div>}
  {labelId&&!loading&&!failure&&files.length===0&&<p className="tag-explorer-message">暂无文件。在文档列表中右键文件，即可添加颜色标签。</p>}
  {labelId&&!loading&&!failure&&files.length>0&&<div className="tag-explorer-list" role="list" aria-label={active?.name+" 标签文件"}>
   {files.map(file=><div key={file.id} role="listitem" className="tag-explorer-file"
    onContextMenu={event=>context(event,file)}>
    <FileTypeIcon name={file.name} size={19}/>
    <Link className="tag-explorer-filename" title={file.name} to={"/preview/"+encodeURIComponent(file.id)}>{file.name}</Link>
    <div className="tag-explorer-dots">{labels.filter(label=>(assignments[file.id]??[]).includes(label.id)).map(label=>
     <span key={label.id} className="finder-tag-dot" style={{backgroundColor:finderColor(label.color)}} title={label.name}/>)}</div>
    <span className="tag-explorer-size">{compactSize(file.sizeBytes)}</span>
    <Link className="tag-explorer-location" to={"/doc?folder="+encodeURIComponent(file.folderId)}>到此目录</Link>
    <RareButton type="button" tone="ghost" className="tag-explorer-more" aria-label={"标记 "+file.name}
     onClick={event=>{setMenu({file,point:{x:event.clientX,y:event.clientY},anchor:event.currentTarget});}}>···</RareButton>
   </div>)}
  </div>}
  {menu&&<Menu open label="文件标签和操作" anchor={menu.anchor} point={menu.point} onClose={()=>setMenu(null)}
   items={[{id:"open",label:"打开文件",onSelect:()=>{window.location.href="/preview/"+encodeURIComponent(menu.file.id);}},
    ...labels.filter(label=>!label.isDefault).map(label=>({id:label.id,label:((assignments[menu.file.id]??[]).includes(label.id)?"✓ ":"")+"添加或移除："+label.name,
     onSelect:()=>void mark(label,menu.file),disabled:busy}))]}
   swatches={FINDER_COLORS.map(color=>{
    const label=labels.find(label=>label.isDefault&&label.color===color.id);
    return {id:color.id,label:color.name,color:color.hex,checked:!!label&&(assignments[menu.file.id]??[]).includes(label.id),
     disabled:!label||busy,onSelect:()=>{if(label)void mark(label,menu.file);}};
   })}/>}
 </section>;
}
