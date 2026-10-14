import {Link} from "react-router-dom";
import {FileTypeIcon} from "../../shared/ui/FileTypeIcon";
import type {FileLineage} from "../../entities/file/model";
import "./fileLineage.css";

const action=(type:FileLineage["relationType"])=>type==="docx_to_pdf"?"转为 PDF":type==="pdf_to_docx"?"转为 Word":"签章副本";
export function FileLineageTree({fileName,parent,children}:{
 fileName:string;parent?:FileLineage|null;children?:FileLineage[];
}){
 if(!parent&&!children?.length)return null;
 return <section className="file-lineage-tree" aria-label="格式互转与血缘追溯">
  <strong>格式互转与血缘追溯</strong>
  <ol>
   {parent&&<li>
    <Link title={parent.name} to={"/preview/"+encodeURIComponent(parent.id)}>
     <FileTypeIcon name={parent.name} size={16}/><span>{parent.name}</span><small>源文档 · v{parent.sourceVersionSeq}</small>
    </Link>
    <span className="file-lineage-connector">↓ {action(parent.relationType)}</span>
   </li>}
   <li className="is-current"><span className="file-lineage-node">
    <FileTypeIcon name={fileName} size={16}/><span title={fileName}>{fileName}</span><small>当前</small>
   </span></li>
   {children?.map(child=><li key={child.id}>
    <span className="file-lineage-connector">↓ {action(child.relationType)} · 源 v{child.sourceVersionSeq}</span>
    <Link to={"/preview/"+encodeURIComponent(child.id)} title={child.name}>
     <FileTypeIcon name={child.name} size={16}/><span>{child.name}</span><small>v{child.versionSeq}</small>
    </Link>
    <time>{new Date(child.createdAt).toLocaleString("zh-CN")}</time>
   </li>)}
  </ol>
 </section>;
}
