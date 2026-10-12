import {useState} from "react";
import {RareInput} from "../../shared/ui/rare";
import {formatSize} from "./api";
import type {StructuredPreview} from "../../entities/file/model";
import "./structuredPreview.css";

export function StructuredFilePreview({value}:{value:StructuredPreview}){
 const [filter,setFilter]=useState("");
 const entries=value.entries??[];
 const sections=value.sections??[];
 const matched=entries.filter(entry=>entry.name.toLowerCase().includes(filter.trim().toLowerCase()));
 return <div className="structured-preview">
  <div className="structured-preview-scroll">
  {value.note&&<p className="structured-note" role="status">{value.note}</p>}
  {value.kind==="archive"&&entries.length>0&&<>
   <div className="structured-table-scroll"><table className="structured-table">
    <thead><tr><th scope="col">名称</th><th scope="col">类型</th><th scope="col">大小</th></tr></thead>
    <tbody>{matched.map((entry,index)=><tr key={entry.name+index}>
     <td className="structured-path" title={entry.name}>{entry.name}</td>
     <td>{entry.directory?"文件夹":"文件"}</td>
     <td>{entry.directory?"—":formatSize(entry.size)}</td>
    </tr>)}</tbody>
   </table></div>
   {matched.length===0&&<p className="empty">没有匹配的文件</p>}
  </>}
  {sections.length>0&&<div className="structured-sections">{sections.map((section,index)=><section key={section.title+index} className="structured-section">
   <h3>{section.title}</h3>
   <div className="structured-lines">{section.lines.map((line,i)=><p key={i}>{line}</p>)}</div>
  </section>)}</div>}
  {!value.note&&sections.length===0&&entries.length===0&&<p className="empty">没有可展示的内容。</p>}
  {value.truncated&&<p className="structured-limit">当前仅显示安全读取范围内的内容，可下载后查看完整文件。</p>}
  </div>
  {value.kind==="archive"&&entries.length>0&&<label className="structured-filter-label preview-reader-dock">
   <span>{entries.length} 项</span>
   <RareInput value={filter} onChange={event=>setFilter(event.target.value)} placeholder="筛选文件名"/>
  </label>}
 </div>;
}
