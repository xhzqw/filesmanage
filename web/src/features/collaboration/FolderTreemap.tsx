import {useMemo,useState} from "react";
import type {Folder} from "../../entities/folder/model";
import {RareButton} from "../../shared/ui/rare";
import {formatBytes,type Stats} from "./api";
import {assetTree,categoryInfo,distributionBackground,ROOT_ID,type AssetNode} from "./statsTree";

type Tile={node:AssetNode;x:number;y:number;w:number;h:number};
const CAP=45;
function tiles(children:AssetNode[],width=1000,height=560):Tile[]{
 const out:Tile[]=[];
 const useCounts=children.every(node=>node.bytes===0);
 const weight=(n:AssetNode)=>Math.max(0,useCounts?n.count:n.bytes);
 function visit(list:AssetNode[],x:number,y:number,w:number,h:number){
  if(!list.length||w<=0||h<=0)return;
  if(list.length===1){const single=list[0];if(single)out.push({node:single,x,y,w,h});return;}
  const total=list.reduce((sum,n)=>sum+weight(n),0);if(total<=0)return;
  let half=0,cut=0;
  while(cut<list.length-1){const next=list[cut];if(!next)break;half+=weight(next);cut++;if(half>=total/2)break;}
  const ratio=Math.max(.001,Math.min(.999,half/total));
  if(w>h){visit(list.slice(0,cut),x,y,w*ratio,h);visit(list.slice(cut),x+w*ratio,y,w*(1-ratio),h);}
  else {visit(list.slice(0,cut),x,y,w,h*ratio);visit(list.slice(cut),x,y+h*ratio,w,h*(1-ratio));}
 }
 visit(children,0,0,width,height);return out;
}

export function FolderTreemap({stats,folders,onChoose}:{stats:Stats;folders:Folder[];onChoose:(id:string)=>void}){
 const root=useMemo(()=>assetTree(stats,folders),[stats,folders]);
 const [selected,setSelected]=useState(ROOT_ID);
 const lookup=useMemo(()=>{
  const map=new Map<string,AssetNode>();
  const walk=(node:AssetNode)=>{map.set(node.id,node);node.children.forEach(walk);};walk(root);return map;
 },[root]);
 const active=lookup.get(selected)??root;
 const crumbs:AssetNode[]=[];
 let cursor:AssetNode|undefined=active;
 while(cursor){crumbs.unshift(cursor);cursor=cursor.parentId?lookup.get(cursor.parentId):undefined;}
 if(crumbs[0]?.id!==ROOT_ID)crumbs.unshift(root);
 const direct:AssetNode[]=active.directCount?[
  {id:active.id+":direct",parentId:active.id,name:"直属文件",children:[],directCount:active.directCount,directBytes:active.directBytes,directTypes:active.directTypes,count:active.directCount,bytes:active.directBytes,types:active.directTypes,virtual:true}
 ]:[];
 const options=[...active.children,...direct].sort((a,b)=>b.bytes-a.bytes||b.count-a.count);
 const hidden=options.slice(CAP-1);
 const visible=options.length>CAP?[
  ...options.slice(0,CAP-1),
  {id:active.id+":hidden",name:"其余 "+hidden.length+" 项",parentId:active.id,children:[],directCount:0,directBytes:0,directTypes:[],count:hidden.reduce((sum,n)=>sum+n.count,0),bytes:hidden.reduce((sum,n)=>sum+n.bytes,0),types:hidden.flatMap(n=>n.types),virtual:true} as AssetNode
 ]:options;
 const total=visible.reduce((sum,n)=>sum+n.bytes,0);
 const count=visible.reduce((sum,n)=>sum+n.count,0);
 const drawable=total>0?visible.filter(n=>n.bytes>0):visible.filter(n=>n.count>0);
 const rects=tiles(drawable);
 return <div className="stats-map-wrap">
  <nav className="stats-map-path" aria-label="目录层级">
   {crumbs.map((node,i)=><span className="stats-map-crumb" key={node.id}>
    {i>0&&<span className="stats-map-separator" aria-hidden="true">/</span>}
    <RareButton type="button" tone="ghost" aria-current={node.id===active.id?"page":undefined} onClick={()=>setSelected(node.id)}>{node.id===ROOT_ID?"全部目录":node.name}</RareButton>
   </span>)}
  </nav>
  {rects.length===0?<div className="stats-map-empty">当前筛选下暂无文件</div>:
   <div className="stats-map-canvas" role="group" aria-label="按真实文件类型着色的目录容量矩形图">
    {rects.map(({node,x,y,w,h})=>{
     const tiny=w<86||h<42,compact=w<166||h<77;
     const major=node.types[0];
     const percent=(100*(total>0?node.bytes/total:count>0?node.count/count:0)).toFixed(1);
     return <RareButton key={node.id} type="button" tone="ghost" disabled={node.id.endsWith(":hidden")||node.id==="__other_folders__"}
      className={"stats-map-tile"+(tiny?" is-tiny":"")}
      style={{left:x/10+"%",top:y/5.6+"%",width:w/10+"%",height:h/5.6+"%",background:distributionBackground(node.types,node.bytes,node.count)}}
      title={node.name+" · "+formatBytes(node.bytes)+" · "+node.count+" 个文件 · "+percent+"%"+(major?" · 主要："+categoryInfo(major.category).label:"")}
      aria-label={node.name+"，"+formatBytes(node.bytes)+"，"+node.count+"个文件，"+percent+"%"}
      onClick={()=>node.id.endsWith(":direct")?onChoose(active.id):setSelected(node.id)}>
      {!tiny&&<strong className="stats-map-tile-name">{node.name}</strong>}
      {!compact&&<span className="stats-map-tile-number">{formatBytes(node.bytes)}</span>}
      {!compact&&<span className="stats-map-tile-meta">{major?categoryInfo(major.category).label+" · ":""}{percent}% · {node.count} 个</span>}
     </RareButton>;
    })}
   </div>}
  <div className="stats-map-caption">
   <span>{drawable.length} 项 · {formatBytes(total)}</span>
   {stats.treeTruncated&&<span>仅统计前 1500 个含文件目录，余量合并显示</span>}
   {active.id!==ROOT_ID&&<RareButton type="button" tone="ghost" onClick={()=>onChoose(active.id)}>按此目录筛选 ↗</RareButton>}
  </div>
 </div>;
}
