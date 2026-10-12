import {useEffect,useMemo,useRef,useState,type CSSProperties,type PointerEvent,type WheelEvent} from "react";
import type {Folder} from "../../entities/folder/model";
import {RareButton} from "../../shared/ui/rare";
import {formatBytes,type FileCategory,type Stats} from "./api";
import {assetTree,categoryInfo,ROOT_ID,type AssetNode} from "./statsTree";

type Kind="folder"|"type"|"more";
type GraphItem={
 key:string;parent:string|null;label:string;count:number;bytes:number;
 kind:Kind;category?:FileCategory;node?:AssetNode;children:GraphItem[];
 depth:number;angle:number;x:number;y:number;
};
type Edge={from:GraphItem;to:GraphItem};
type Layout={items:GraphItem[];edges:Edge[];width:number;height:number;rootX:number;rootY:number};
type View={x:number;y:number;scale:number};
const NODE_W=150,NODE_H=44,ROOT_W=132,ROOT_H=132,MAX_NODES=110;
const DEFAULT_CHILDREN=7;
const TAU=Math.PI*2;

function defaultExpanded(root:AssetNode):Set<string>{
 const expanded=new Set<string>([ROOT_ID]);
 let current=root;
 // Reveal a real branching point when all files sit under one wrapper folder.
 for(let i=0;i<3&&current.children.length===1;i++){
  const child=current.children[0];
  if(!child||child.virtual)break;
  expanded.add(child.id);
  current=child;
 }
 return expanded;
}

function makeVisible(root:AssetNode,expanded:Set<string>,limits:Map<string,number>,revealTypes:Set<string>):GraphItem{
 let total=0;
 function folder(node:AssetNode,parent:string|null):GraphItem{
  const key="folder:"+node.id;
  const item:GraphItem={key,parent,label:node.name,count:node.count,bytes:node.bytes,kind:"folder",
   node,children:[],depth:0,angle:0,x:0,y:0};
  total++;
  if(!expanded.has(node.id)||node.virtual)return item;
  const limit=limits.get(node.id)??DEFAULT_CHILDREN;
  const children=node.children.slice(0,limit);
  for(const child of children){
   if(total>=MAX_NODES-1)break;
   item.children.push(folder(child,key));
  }
  const remaining=node.children.length-children.length;
  if(remaining>0&&total<MAX_NODES){
   item.children.push({key:"more:"+node.id,parent:key,label:"其余 "+remaining+" 个目录",
    count:0,bytes:0,kind:"more",node,children:[],depth:0,angle:0,x:0,y:0});
   total++;
  }
  // Keep the initial graph readable: wrapper folders show their directory
  // branches first. Show exact file-class leaves on explicit exploration,
  // or automatically for a terminal folder that has been expanded.
  const showTypes=node.children.length===0||revealTypes.has(node.id);
  for(const type of (showTypes?node.directTypes:[]).filter(t=>t.count>0)){
   if(total>=MAX_NODES)break;
   item.children.push({key:"type:"+node.id+":"+type.category,parent:key,
    label:categoryInfo(type.category).label,count:type.count,bytes:type.bytes,
    kind:"type",category:type.category,node,children:[],depth:0,angle:0,x:0,y:0});
   total++;
  }
  return item;
 }
 return folder(root,null);
}

/**
 * Radial tidy-tree: assign disjoint angular sectors in proportion to the
 * number of visible terminal nodes, then place every depth on a concentric
 * ring. Expand the ring radius if any axis-aligned cards would overlap.
 * Unlike a horizontal layered tree, all quadrants can contain descendants.
 */
function radialLayout(root:GraphItem):Layout{
 const items:GraphItem[]=[];
 const edges:Edge[]=[];
 const byDepth=new Map<number,GraphItem[]>();
 function leaves(item:GraphItem):number{
  return item.children.length?item.children.reduce((sum,child)=>sum+leaves(child),0):1;
 }
 function position(item:GraphItem,depth:number,start:number,end:number):void{
  item.depth=depth;
  item.angle=(start+end)/2;
  items.push(item);
  const peers=byDepth.get(depth)??[];
  peers.push(item);byDepth.set(depth,peers);
  const n=leaves(item);
  let used=start;
  for(const child of item.children){
   const next=used+(end-start)*leaves(child)/n;
   position(child,depth+1,used,next);
   edges.push({from:item,to:child});
   used=next;
  }
 }
 // Top of the circle first; child sectors grow clockwise around the hub.
 position(root,0,-Math.PI/2,-Math.PI/2+TAU);
 // A sole first child sits above the hub, while its own children still spread
 // over the full 360-degree sector.
 if(root.children.length===1)root.children[0]!.angle=-Math.PI/2;
 root.x=0;root.y=0;
 for(const [depth,peers] of byDepth){
  if(depth===0)continue;
  // Position is based on angular density, not on alphabetical row order.
  const minimum=depth===1?160:160+(depth-1)*145;
  let radius=Math.max(minimum,peers.length*152/TAU);
  for(let step=0;step<90;step++){
   for(const node of peers){node.x=Math.cos(node.angle)*radius;node.y=Math.sin(node.angle)*radius;}
   let collision=false;
   for(let i=0;i<peers.length&&!collision;i++){
    const a=peers[i]!;
    for(let j=i+1;j<peers.length;j++){
     const b=peers[j]!;
     if(Math.abs(a.x-b.x)<NODE_W+15&&Math.abs(a.y-b.y)<NODE_H+14){collision=true;break;}
    }
   }
   if(!collision)break;
   radius+=18;
  }
 }
 const pad=32;
 const minX=Math.min(...items.map(n=>n.x-(n===root?ROOT_W:NODE_W)/2))-pad;
 const minY=Math.min(...items.map(n=>n.y-(n===root?ROOT_H:NODE_H)/2))-pad;
 const maxX=Math.max(...items.map(n=>n.x+(n===root?ROOT_W:NODE_W)/2))+pad;
 const maxY=Math.max(...items.map(n=>n.y+(n===root?ROOT_H:NODE_H)/2))+pad;
 for(const item of items){item.x-=minX;item.y-=minY;}
 return {items,edges,width:maxX-minX,height:maxY-minY,rootX:-minX,rootY:-minY};
}

function connector(a:GraphItem,b:GraphItem,scale:number):string{
 const dx=b.x-a.x,dy=b.y-a.y;
 const sw=a.depth===0?ROOT_W:NODE_W,sh=a.depth===0?ROOT_H:NODE_H;
 // Intersect the ray with the actual card edge so connectors do not
 // continue through the opaque rectangle at any angle.
 const dist=Math.max(.0001,Math.hypot(dx,dy));
 // Screen-space node pills retain their legible size while the graph zooms.
 const startT=a.depth===0?(ROOT_W/2)/dist/scale:Math.min((sw/2)/Math.max(.0001,Math.abs(dx)),(sh/2)/Math.max(.0001,Math.abs(dy)))/scale;
 const endT=Math.min((NODE_W/2)/Math.max(.0001,Math.abs(dx)),(NODE_H/2)/Math.max(.0001,Math.abs(dy)))/scale;
 const ax=a.x+dx*startT,ay=a.y+dy*startT;
 const bx=b.x-dx*endT,by=b.y-dy*endT;
 const span=Math.hypot(bx-ax,by-ay),handle=Math.min(64,span*.4);
 const distance=Math.max(.0001,Math.hypot(dx,dy));
 const vx=dx/distance,vy=dy/distance;
 const bend=Math.sin(b.angle-a.angle)*Math.min(22,span*.16);
 const px=-vy*bend,py=vx*bend;
 return "M"+ax+" "+ay+" C"+(ax+vx*handle+px)+" "+(ay+vy*handle+py)+" "+(bx-vx*handle+px)+" "+(by-vy*handle+py)+" "+bx+" "+by;
}

function fit(layout:Layout,width:number,height:number):View{
 const scale=Math.min(1.07,Math.max(.26,Math.min((width-32)/layout.width,(height-32)/layout.height)));
 // Anchor the semantic root, not the asymmetric bounding box, at viewport centre.
 return {scale,x:width/2-layout.rootX*scale,y:height/2-layout.rootY*scale};
}
const clamp=(x:number)=>Math.max(.26,Math.min(2.2,x));

export function FolderNodeGraph({stats,folders,onChoose}:{stats:Stats;folders:Folder[];onChoose:(id:string)=>void}){
 const root=useMemo(()=>assetTree(stats,folders),[stats,folders]);
 const [expanded,setExpanded]=useState<Set<string>>(()=>defaultExpanded(root));
 const [limits,setLimits]=useState<Map<string,number>>(()=>new Map());
 const [revealTypes,setRevealTypes]=useState<Set<string>>(()=>new Set());
 const [active,setActive]=useState(ROOT_ID);
 const [viewport,setViewport]=useState({width:0,height:0});
 const [view,setView]=useState<View>({x:0,y:0,scale:1});
 const viewportRef=useRef<HTMLDivElement>(null);
 const previousLayoutRef=useRef<Layout|null>(null);
 const previousViewportRef=useRef({width:0,height:0});
 const drag=useRef<{x:number;y:number;ox:number;oy:number}|null>(null);
 const [dragging,setDragging]=useState(false);
 const dragPointerRef=useRef<number|null>(null);
 useEffect(()=>{setExpanded(defaultExpanded(root));setLimits(new Map());setRevealTypes(new Set());setActive(ROOT_ID);},[root]);
 const model=useMemo(()=>makeVisible(root,expanded,limits,revealTypes),[root,expanded,limits,revealTypes]);
 const layout=useMemo(()=>radialLayout(model),[model]);
 const byKey=useMemo(()=>new Map(layout.items.map(item=>[item.key,item])),[layout]);
 const activeNode=byKey.get("folder:"+active)?.node;
 const branch=useMemo(()=>{
  const keys=new Set<string>();let item=byKey.get("folder:"+active);
  while(item&&!keys.has(item.key)){keys.add(item.key);item=item.parent?byKey.get(item.parent):undefined;}
  return keys;
 },[active,byKey]);
 useEffect(()=>{
  const el=viewportRef.current;if(!el)return;
  const observer=new ResizeObserver(entries=>{
   const box=entries[0]?.contentRect;
   if(box)setViewport(old=>Math.abs(old.width-box.width)<1&&Math.abs(old.height-box.height)<1?old:{width:box.width,height:box.height});
  });
  observer.observe(el);
  return ()=>observer.disconnect();
 },[]);
 useEffect(()=>{
  if(viewport.width<=0||viewport.height<=0)return;
  const previous=previousLayoutRef.current;
  const size=previousViewportRef.current;
  if(!previous||Math.abs(size.width-viewport.width)>1||Math.abs(size.height-viewport.height)>1){
   setView(fit(layout,viewport.width,viewport.height));
  }else{
   // Expanding a branch must not reset a user-selected zoom or drag offset.
   // Re-anchor the stable semantic root while bounding geometry grows.
   setView(old=>({...old,x:old.x+(previous.rootX-layout.rootX)*old.scale,y:old.y+(previous.rootY-layout.rootY)*old.scale}));
  }
  previousLayoutRef.current=layout;
  previousViewportRef.current=viewport;
 },[layout,viewport]);
 function zoomBy(factor:number,clientX?:number,clientY?:number){
  setView(old=>{
   const scale=clamp(old.scale*factor),ratio=scale/old.scale;
   const fx=clientX??viewport.width/2,fy=clientY??viewport.height/2;
   return {scale,x:fx-(fx-old.x)*ratio,y:fy-(fy-old.y)*ratio};
  });
 }
 function handlePointerDown(event:PointerEvent<HTMLDivElement>){
  if(event.button!==0||dragPointerRef.current!==null||(event.target as HTMLElement).closest("button"))return;
  dragPointerRef.current=event.pointerId;
  drag.current={x:event.clientX,y:event.clientY,ox:view.x,oy:view.y};
  setDragging(true);event.currentTarget.setPointerCapture(event.pointerId);
 }
 function handlePointerMove(event:PointerEvent<HTMLDivElement>){
  if(!drag.current||dragPointerRef.current!==event.pointerId)return;
  setView(old=>({...old,x:drag.current!.ox+event.clientX-drag.current!.x,y:drag.current!.oy+event.clientY-drag.current!.y}));
 }
 function handlePointerUp(event:PointerEvent<HTMLDivElement>){
  if(dragPointerRef.current!==event.pointerId)return;
  dragPointerRef.current=null;drag.current=null;setDragging(false);
  if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
 }
 function handleWheel(event:WheelEvent<HTMLDivElement>){
  if(!event.ctrlKey)return;
  event.preventDefault();
  const rect=event.currentTarget.getBoundingClientRect();
  zoomBy(event.deltaY<0?1.12:1/1.12,event.clientX-rect.left,event.clientY-rect.top);
 }
 function select(item:GraphItem){
  if(item.kind==="more"&&item.node){
   setLimits(old=>{const next=new Map(old);next.set(item.node!.id,(next.get(item.node!.id)??DEFAULT_CHILDREN)+12);return next;});return;
  }
  if(item.kind!=="folder"||!item.node||item.node.virtual)return;
  setActive(item.node.id);
  setRevealTypes(old=>new Set(old).add(item.node!.id));
  setExpanded(old=>{const next=new Set(old);if(next.has(item.node!.id))next.delete(item.node!.id);else next.add(item.node!.id);return next;});
 }
 return <div className="stats-graph">
  <div className="stats-graph-toolbar">
   <span className="stats-graph-hint">目录拓扑 <span aria-hidden="true">·</span> {layout.items.length} 个节点</span>
   <div className="stats-graph-tools" aria-label="图谱缩放">
    <RareButton type="button" tone="ghost" aria-label="缩小图谱" onClick={()=>zoomBy(1/1.2)}>－</RareButton>
    <span aria-label="图谱缩放比例">{Math.round(view.scale*100)}%</span>
    <RareButton type="button" tone="ghost" aria-label="放大图谱" onClick={()=>zoomBy(1.2)}>＋</RareButton>
    <RareButton type="button" tone="ghost" onClick={()=>setView(fit(layout,viewport.width,viewport.height))}>适应</RareButton>
   </div>
  </div>
  <div className={"stats-graph-viewport"+(dragging?" is-dragging":"")} role="group"
   aria-label="从中心向四周放射的目录与文件类型径向树图谱" ref={viewportRef}
   onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp} onWheel={handleWheel}>
   <div className="stats-graph-plane" style={{width:layout.width,height:layout.height,transform:"translate("+view.x+"px,"+view.y+"px) scale("+view.scale+")"}}>
    <svg className="stats-graph-lines" aria-hidden="true" width={layout.width} height={layout.height}>
     {layout.edges.map(({from,to})=><path key={from.key+"->"+to.key}
      d={connector(from,to,view.scale)}
      className={"stats-graph-edge"+(branch.has(from.key)&&branch.has(to.key)?" is-active":"")}/>)}
    </svg>
    {layout.items.map(item=>{
     const isRoot=item.node?.id===ROOT_ID;
     const open=item.node?expanded.has(item.node.id):false;
     const canExpand=Boolean(item.node&&!item.node.virtual&&(item.node.children.length>0||item.node.directTypes.length>0));
     const color=item.kind==="type"&&item.category?categoryInfo(item.category).color:"var(--folder-fill)";
     return <RareButton key={item.key} type="button" tone="ghost" onClick={()=>select(item)}
      disabled={item.node?.virtual||item.kind==="type"}
      aria-expanded={canExpand?open:undefined}
      aria-label={item.label+"，"+item.count+" 个文件，"+formatBytes(item.bytes)+(canExpand?"，点击展开或折叠":"")}
      title={item.label+" · "+item.count+" 个文件 · "+formatBytes(item.bytes)}
      className={"stats-graph-node"+(isRoot?" is-root":"")+(item.kind==="type"?" stats-graph-type":" stats-graph-folder")+(item.kind==="more"?" stats-graph-more":"")+(active===item.node?.id&&item.kind==="folder"?" is-selected":"")}
      style={{left:item.x-(isRoot?ROOT_W:NODE_W)/2,top:item.y-(isRoot?ROOT_H:NODE_H)/2,
       width:isRoot?ROOT_W:NODE_W,height:isRoot?ROOT_H:NODE_H,"--stats-node-color":color,"--stats-node-inverse":1/view.scale} as CSSProperties}>
      <span className="stats-graph-node-content">
       <span className="stats-graph-node-name">{item.kind==="folder"?<svg className="stats-graph-folder-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 7.2V5.8c0-.8.6-1.4 1.4-1.4H9l2.1 2.2h7.8c.9 0 1.6.7 1.6 1.6v9.6c0 .9-.7 1.6-1.6 1.6H5.1c-.9 0-1.6-.7-1.6-1.6V7.2Z"/></svg>:<i className="stats-graph-dot" aria-hidden="true"/>}<span className="stats-graph-node-label">{item.label}</span></span>
       <span className="stats-graph-node-detail">{item.kind==="more"?"展开剩余目录":formatBytes(item.bytes)+"  ·  "+item.count+" 个文件"}</span>
      </span>
      {canExpand&&<span className="stats-graph-toggle" aria-hidden="true">{open?"−":"+"}</span>}
     </RareButton>;
    })}
   </div>
  </div>
  <div className="stats-graph-footer">
   <span>{stats.treeTruncated?"部分目录合并显示":"拖拽移动 · Ctrl + 滚轮缩放"}</span>
   {activeNode&&activeNode.id!==ROOT_ID&&!activeNode.virtual&&
    <><span className="stats-graph-current" title={activeNode.name}>{activeNode.name}</span>
     <RareButton type="button" tone="ghost" onClick={()=>onChoose(activeNode.id)}>筛选此目录 ↗</RareButton></>}
  </div>
 </div>;
}
