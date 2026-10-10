import {useMemo,useState} from "react";
import {RareButton} from "../../shared/ui/rare";
import type {OfficeSemanticChange} from "./api";
import "./officeChangeGrid.css";

const statusText={added:"新增",removed:"删除",changed:"修改"} as const;

export function OfficeChangeGrid({changes}:{changes:OfficeSemanticChange[]}){
 const sections=useMemo(()=>{
  const groups=new Map<string,OfficeSemanticChange[]>();
  for(const change of changes){
   const group=groups.get(change.section)??[];
   group.push(change);
   groups.set(change.section,group);
  }
  return Array.from(groups,([name,items])=>({name,items}));
 },[changes]);
 const[selected,setSelected]=useState("");
 const active=sections.find(section=>section.name===selected)??sections[0];
 if(changes.length===0)return <p className="office-changes-empty">提取的段落或单元格值未变化，可能仅有样式、公式或其他文档部件发生变化。</p>;
 return <div className={"office-change-grid"+(sections.length===1?" single-section":"")} aria-label="Office 结构化版本差异">
  {sections.length>1&&<nav className="office-change-sections" aria-label="差异位置">
   {sections.map(section=><RareButton key={section.name} type="button" className={section.name===active?.name?"active":""}
    aria-pressed={section.name===active?.name} onClick={()=>setSelected(section.name)}
    title={section.name}>{section.name}<span>{section.items.length}</span></RareButton>)}
  </nav>}
  <section className="office-change-content" aria-label={active?.name??"差异"}>
   <div className="office-change-heading">
    <strong>{active?.name}</strong>
    <span>共 {active?.items.length??0} 处变更</span>
   </div>
   <div className="office-change-scroll">
    <table className="office-change-table">
     <thead><tr><th scope="col">位置</th><th scope="col">原版本</th><th scope="col">新版本</th><th scope="col">状态</th></tr></thead>
     <tbody>
      {active?.items.map(change=><tr key={change.section+"/"+change.key} className={"office-change-row "+change.kind}>
       <th scope="row" title={change.key}>{change.key}</th>
       <td className="office-before">{change.kind==="added"?"—":change.before||"（空）"}</td>
       <td className="office-after">{change.kind==="removed"?"—":change.after||"（空）"}</td>
       <td><span className={"office-change-status "+change.kind}>{statusText[change.kind]}</span></td>
      </tr>)}
     </tbody>
    </table>
   </div>
  </section>
 </div>;
}
