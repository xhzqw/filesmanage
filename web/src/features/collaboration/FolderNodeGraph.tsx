import {useEffect,useMemo,useRef,useState,type CSSProperties,type PointerEvent,type WheelEvent} from "react";
import type {Folder} from "../../entities/folder/model";
import {RareButton} from "../../shared/ui/rare";
import {formatBytes,type FileCategory,type Stats} from "./api";
import {assetTree,categoryInfo,ROOT_ID,type AssetNode} from "./statsTree";

type Item={
 key:string;parent:string|null;x:number;y:number;
 label:string;count:number;bytes:number;
 node?:AssetNode;kind?:"folder"|"type"|"more";category?:FileCategory;
 extra?:string;
};
const STEP_X=232,STEP_Y=72,WIDTH=198,HEIGHT=54,MAX_NODES=140;
const defaultExpanded=(root:AssetNode)=>new Set([ROOT_ID,...(root.children.length<=3?root.children.slice(0,2).filter(n=>!n.virtual).map(n=>n.id):[])]);
function graphLayout(root:AssetNode,expanded:Set<string>,limits:Map<string,number>):{items:Item[];edges:{a:Item;b:Item}[];width:number;height:number}{
 const items:Item[]=[];
 let row=0;
 function visit(node:AssetNode,depth:number,parent:string|null):Item{
  const key="folder:"+node.id;
  const item:Item={key,parent,x:24+depth*STEP_X,y:0,label:node.name,bytes:node.bytes,count:node.count,node,kind:"folder"};
  items.push(item);
  const children:Item[]=[];
  if(expanded.has(node.id)&&!node.virtual){
   const limit=limits.get(node.id)??7;
   const visibleFolders=node.children.slice(0,limit);
   for(const child of visibleFolders){if(items.length>=MAX_NODES)break;children.push(visit(child,depth+1,key));}
   const hidden=node.children.length-visibleFolders.length;
   if(hidden>0&&items.length<MAX_NODES){
    const extra:Item={key:"more:"+node.id,parent:key,x:24+(depth+1)*STEP_X,y:0,label:"其余 "+hidden+" 个目录",count:0,bytes:0,kind:"more",node};
    items.push(extra);extra.y=24+row++*STEP_Y;children.push(extra);
   }
   // File-type leaves are actual aggregates of direct files, not estimates
   // derived from a folder's dominant extension or a global percentage.
   for(const type of node.directTypes.filter(t=>t.count>0)){
    if(items.length>=MAX_NODES)break;
    const leaf:Item={key:"type:"+node.id+":"+type.category,parent:key,x:24+(depth+1)*STEP_X,y:0,
      label:categoryInfo(type.category).label,count:type.count,bytes:type.bytes,kind:"type",category:type.category,node};
    items.push(leaf);leaf.y=24+row++*STEP_Y;children.push(leaf);
   }
  }
  item.y=children.length>0?(children[0]!.y+children[children.length-1]!.y)/2:24+row++*STEP_Y;
  return item;
 }
 visit(root,0,null);
 const byKey=new Map(items.map(n=>[n.key,n]));
 return {items,edges:items.flatMap(item=>item.parent&&byKey.has(item.parent)?[{a:byKey.get(item.parent)!,b:item}]:[]),
  width:Math.max(690,...items.map(n=>n.x+WIDTH+26)),height:Math.max(450,row*STEP_Y+46)};
}

export function FolderNodeGraph({stats,folders,onChoose}:{stats:Stats;folders:Folder[];onChoose:(id:string)=>void}){
 const root=useMemo(()=>assetTree(stats,folders),[stats,folders]);
 const [expanded,setExpanded]=useState<Set<string>>(()=>defaultExpanded(root));
 const [limits,setLimits]=useState<Map<string,number>>(new Map());
 const [active,setActive]=useState<string>(ROOT_ID);
 const [zoom,setZoom]=useState(1);
 const [offset,setOffset]=useState({x:18,y:24});
 const drag=useRef<{x:number;y:number;ox:number;oy:number}|null>(null);
 useEffect(()=>{setExpanded(defaultExpanded(root));setLimits(new Map());setActive(ROOT_ID);},[root]);
 const {items,edges,width,height}=useMemo(()=>graphLayout(root,expanded,limits),[root,expanded,limits]);
 const activeNode=items.find(n=>n.node?.id===active)?.node;
 const changeZoom=(factor:number)=>setZoom(z=>Math.min(1.8,Math.max(.45,Math.round((z+factor)*100)/100)));
 function handlePointerDown(event:PointerEvent<HTMLDivElement>){
  if(event.button!==0||(event.target as HTMLElement).closest("button"))return;
  drag.current={x:event.clientX,y:event.clientY,ox:offset.x,oy:offset.y};
  event.currentTarget.setPointerCapture(event.pointerId);
 }
 function handlePointerMove(event:PointerEvent<HTMLDivElement>){
  if(!drag.current)return;
  setOffset({x:drag.current.ox+event.clientX-drag.current.x,y:drag.current.oy+event.clientY-drag.current.y});
 }
 function handlePointerUp(event:PointerEvent<HTMLDivElement>){drag.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}
 function onWheel(event:WheelEvent<HTMLDivElement>){
  // Ctrl+wheel zooms; ordinary wheel continues scrolling the page.
  if(!event.ctrlKey)return;
  event.preventDefault();
  changeZoom(event.deltaY<0?.12:-.12);
 }
 function select(item:Item){
  if(item.kind==="more"&&item.node){
   setLimits(old=>{const next=new Map(old);next.set(item.node!.id,(next.get(item.node!.id)??7)+30);return next;});return;
  }
  if(item.kind!=="folder"||!item.node||item.node.virtual)return;
  setActive(item.node.id);
  setExpanded(old=>{const next=new Set(old);if(next.has(item.node!.id))next.delete(item.node!.id);else next.add(item.node!.id);return next;});
 }
 return <div className="stats-graph">
  <div className="stats-graph-toolbar">
   <span className="stats-graph-hint">点击节点展开 · 拖动画布 · Ctrl + 滚轮缩放</span>
   <div className="stats-graph-tools" aria-label="图谱缩放">
    <RareButton type="button" tone="ghost" aria-label="缩小图谱" onClick={()=>changeZoom(-.2)}>－</RareButton>
    <span aria-label="图谱缩放比例">{Math.round(zoom*100)}%</span>
    <RareButton type="button" tone="ghost" aria-label="放大图谱" onClick={()=>changeZoom(.2)}>＋</RareButton>
    <RareButton type="button" tone="ghost" onClick={()=>{setZoom(1);setOffset({x:18,y:24});}}>重置</RareButton>
   </div>
  </div>
  <div className="stats-graph-viewport" role="group" aria-label="包含父子连线的目录与文件类型树图谱"
   onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp} onWheel={onWheel}>
   <div className="stats-graph-plane" style={{width,height,transform:"translate("+offset.x+"px,"+offset.y+"px) scale("+zoom+")"}}>
    <svg className="stats-graph-lines" aria-hidden="true" width={width} height={height}>
     {edges.map(({a,b})=><path key={a.key+"->"+b.key}
      d={"M"+(a.x+WIDTH)+" "+(a.y+HEIGHT/2)+" C"+(a.x+WIDTH+35)+" "+(a.y+HEIGHT/2)+","+(b.x-35)+" "+(b.y+HEIGHT/2)+","+b.x+" "+(b.y+HEIGHT/2)}
      fill="none" stroke="var(--border-strong)" strokeOpacity=".48" strokeWidth="1.5"/>)}
    </svg>
    {items.map(item=>{
     const isType=item.kind==="type";
     const open=item.node?expanded.has(item.node.id):false;
     const hasChildren=Boolean(item.node&&!item.node.virtual&&(item.node.children.length>0||item.node.directTypes.length>0));
     const color=isType&&item.category?categoryInfo(item.category).color:"var(--folder-fill)";
     return <RareButton key={item.key} type="button" tone="ghost" onClick={()=>select(item)}
      disabled={item.node?.virtual||isType}
      aria-expanded={hasChildren?open:undefined}
      aria-label={item.label+"，"+item.count+" 个文件，"+formatBytes(item.bytes)+(hasChildren?",点击展开或折叠":"")}
      title={item.label+" · "+item.count+" 个文件 · "+formatBytes(item.bytes)}
      className={"stats-graph-node "+(isType?"stats-graph-type":"stats-graph-folder")+(item.kind==="more"?" stats-graph-more":"")+(active===item.node?.id?" is-selected":"")}
      style={{left:item.x,top:item.y,width:WIDTH,height:HEIGHT,"--stats-node-color":color} as CSSProperties}>
      <span className="stats-graph-node-content">
       <span className="stats-graph-node-name"><i className="stats-graph-dot" aria-hidden="true"/>{item.label}</span>
       <span className="stats-graph-node-detail">{item.kind==="more"?"点击显示更多":formatBytes(item.bytes)+" · "+item.count+" 个"}</span>
      </span>
      {hasChildren&&<span className="stats-graph-toggle" aria-hidden="true">{open?"−":"+"}</span>}
     </RareButton>;
    })}
   </div>
  </div>
  <div className="stats-graph-footer">
   <span>{items.length} 个节点 · {stats.treeTruncated?"仅含已统计目录":"当前筛选范围"}</span>
   {activeNode&&activeNode.id!==ROOT_ID&&!activeNode.virtual&&
    <><span className="stats-graph-current" title={activeNode.name}>{activeNode.name}</span>
     <RareButton type="button" tone="ghost" onClick={()=>onChoose(activeNode.id)}>筛选此目录 ↗</RareButton></>}
  </div>
 </div>;
}
