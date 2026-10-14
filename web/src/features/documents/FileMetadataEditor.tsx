import {useEffect,useState,type FormEvent} from "react";
import {RareBadge,RareButton,RareInput,RareTextarea} from "../../shared/ui/rare";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {toast} from "../../shared/ui/feedback";
import {errorCopy} from "../../shared/errors";
import {fileApi} from "./api";
import type {FileMetadata,FileLineage} from "../../entities/file/model";
import {FileLineageTree} from "./FileLineageTree";

// File business metadata lives alongside document attributes, not in a
// full-page create form. Server authorizes both read and write.
export function FileMetadataEditor({fileId,fileName,lineageParent,lineageChildren}:{fileId:string;fileName?:string;lineageParent?:FileLineage|null;lineageChildren?:FileLineage[]}){
 const[metadata,setMetadata]=useState<FileMetadata|null>(null);
 const[error,setError]=useState("");
 const[editing,setEditing]=useState(false);
 const[busy,setBusy]=useState(false);
 const[category,setCategory]=useState("");
 const[description,setDescription]=useState("");
 const[tags,setTags]=useState("");
 useEffect(()=>{
  let live=true;setMetadata(null);setEditing(false);setError("");
  fileApi.metadata(fileId).then(m=>{if(!live)return;setMetadata(m);setCategory(m.category);setDescription(m.description);setTags(m.tags.join("、"));})
  .catch(err=>{if(live)setError(errorCopy(err,"读取分类失败"));});
  return()=>{live=false;};
 },[fileId]);
 async function save(event:FormEvent<HTMLFormElement>){
  event.preventDefault();if(busy)return;
  setBusy(true);setError("");
  try{
   const value=await toast.track(()=>fileApi.setMetadata(fileId,{category:category.trim(),description:description.trim(),tags:tags.split(/[,，、]/).map(s=>s.trim()).filter(Boolean)}),{
    loading:"正在保存文档属性…",success:"文档属性已保存",error:e=>errorCopy(e,"保存文档属性失败")
   });
   setMetadata(value);setEditing(false);
  }catch(err){setError(errorCopy(err,"保存失败"));}
  finally{setBusy(false);}
 }
 return <section className="file-metadata-section" aria-label="文档分类">
  {fileName&&<FileLineageTree fileName={fileName} parent={lineageParent} children={lineageChildren}/>}
  <header className="file-metadata-bar"><strong>业务分类</strong>
   {metadata&&!editing&&<RareButton type="button" onClick={()=>setEditing(true)}>编辑</RareButton>}
  </header>
  {error&&<p role="alert" className="notice error">{error}</p>}
  {!metadata&&!error&&<p role="status" className="hint"><BrandLoadingLabel>正在读取元数据…</BrandLoadingLabel></p>}
  {metadata&&!editing&&<div className="file-metadata-summary">
   <span>分类：<strong>{metadata.category||"未分类"}</strong></span>
   <span>标签：{metadata.tags.length?metadata.tags.map(t=><RareBadge key={t}>{t}</RareBadge>):"—"}</span>
   <span>描述：{metadata.description||"—"}</span>
  </div>}
  {metadata&&editing&&<form className="file-metadata-form" onSubmit={save}>
   <label>分类<RareInput value={category} maxLength={80} onChange={e=>setCategory(e.target.value)} disabled={busy} placeholder="例如：工程图纸"/></label>
   <label>标签<RareInput value={tags} onChange={e=>setTags(e.target.value)} disabled={busy} placeholder="多个标签以逗号分隔"/></label>
   <label>描述<RareTextarea rows={2} maxLength={2000} value={description} onChange={e=>setDescription(e.target.value)} disabled={busy}/></label>
   <div className="file-metadata-actions">
    <RareButton type="button" disabled={busy} onClick={()=>{setEditing(false);setError("");}}>取消</RareButton>
    <RareButton type="submit" className="primary" loading={busy}>保存</RareButton>
   </div>
  </form>}
 </section>;
}
