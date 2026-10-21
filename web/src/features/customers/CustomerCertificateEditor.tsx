import {useEffect,useState} from "react";
import {Link} from "react-router-dom";
import {customerApi} from "./api";
import {RareButton,RareInput,RareSelect} from "../../shared/ui/rare";
import type {CustomerCertificate} from "./model";
import type {FileItem} from "../../entities/file/model";

export function CustomerCertificateEditor({certificate,onChange,onRemove}:{certificate:CustomerCertificate;onChange:(c:CustomerCertificate)=>void;onRemove:()=>void}){
 const [search,setSearch]=useState("");
 const [matches,setMatches]=useState<FileItem[]>([]);
 const [fileName,setFileName]=useState("");
 const [busy,setBusy]=useState(false);
 useEffect(()=>{
  if(search.trim().length<2){setMatches([]);return;}
  const controller=new AbortController();let valid=true;
  const timer=window.setTimeout(()=>{
   setBusy(true);
   customerApi.searchFiles(search.trim(),controller.signal)
    .then(page=>{if(valid)setMatches(page.items)})
    .catch(()=>{if(valid)setMatches([])})
    .finally(()=>{if(valid)setBusy(false)});
  },250);
  return()=>{valid=false;controller.abort();window.clearTimeout(timer)};
 },[search]);
 function field<K extends keyof CustomerCertificate>(key:K,value:CustomerCertificate[K]){onChange({...certificate,[key]:value})}
 return <section className="customer-cert-entry">
  <div className="customer-cert-head"><strong>资质证照</strong><RareButton type="button" tone="ghost" onClick={onRemove}>移除</RareButton></div>
  <div className="customer-cert-fields">
   <label>证照类型<RareSelect value={certificate.kind} onChange={e=>field("kind",e.target.value)}>
    <option value="">选择证照</option>
    <option value="营业执照">营业执照</option><option value="经营许可证">经营许可证</option>
    <option value="第二类医疗器械备案凭证">第二类医疗器械备案凭证</option>
    <option value="生产许可证">生产许可证</option><option value="法人委托书">法人委托书</option>
    <option value="其他资质">其他资质</option>
   </RareSelect></label>
   <label>证照号码<RareInput value={certificate.number} maxLength={120} onChange={e=>field("number",e.target.value)}/></label>
   <label>签发日期<RareInput type="date" value={certificate.issuedOn} onChange={e=>field("issuedOn",e.target.value)}/></label>
   <label>有效期至<RareInput type="date" value={certificate.expiresOn} onChange={e=>field("expiresOn",e.target.value)}/></label>
  </div>
  <label>关联现有文件<RareInput type="search" value={search} placeholder="输入文件名，搜索文档管理中的证照…" onChange={e=>setSearch(e.target.value)}/></label>
  {search.trim().length>=2&&<div className="customer-file-results" aria-label="证照文件搜索结果">
   {busy&&<small>正在检索文件…</small>}
   {!busy&&matches.length===0&&<small>未找到可访问的文件，请先上传至文档管理</small>}
   {matches.map(file=><RareButton type="button" key={file.id} tone="ghost" onClick={()=>{field("fileId",file.id);setFileName(file.name);setSearch("");}}>
    {file.name}
   </RareButton>)}
  </div>}
  {certificate.fileId&&<div className="customer-file-linked">
   <span>已关联：{fileName||"已选择文件"}</span>
   <Link to={"/preview/"+encodeURIComponent(certificate.fileId)}>查看文件 ↗</Link>
   <RareButton type="button" tone="ghost" onClick={()=>{field("fileId","");setFileName("")}}>取消关联</RareButton>
  </div>}
 </section>;
}
