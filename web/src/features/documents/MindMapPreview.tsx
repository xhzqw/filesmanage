import {useEffect,useMemo,useRef,useState,type PointerEvent,type WheelEvent} from "react";
import {RareButton} from "../../shared/ui/rare";
import type {XMindPreview,XMindTopic} from "../../entities/file/model";
import "./mindMapPreview.css";

type MapNode={path:string;topic:XMindTopic;depth:number;x:number;y:number;children:number};
type MapEdge={fromX:number;fromY:number;toX:number;toY:number;kind?:string};
const NODE_WIDTH=200;
const NODE_HEIGHT=48;
const COLUMN_SPACING=76;
const ROW_SPACING=17;
const PADDING=42;
const clamp=(value:number,min:number,max:number)=>Math.min(max,Math.max(min,value));

function arrange(root:XMindTopic,folded:Set<string>){
 const heights=new Map<string,number>();
 let maxDepth=0;
 function measure(topic:XMindTopic,path:string,depth:number):number {
  maxDepth=Math.max(maxDepth,depth);
  const children=folded.has(path)?[]:topic.children??[];
  const total=children.reduce((sum,child,i)=>sum+measure(child,path+"."+i,depth+1)+(i>0?ROW_SPACING:0),0);
  const height=Math.max(NODE_HEIGHT,total);
  heights.set(path,height);
  return height;
 }
 const height=measure(root,"0",0);
 const nodes:MapNode[]=[];
 const edges:MapEdge[]=[];
 function place(topic:XMindTopic,path:string,depth:number,top:number){
  const y=top+((heights.get(path)??NODE_HEIGHT)-NODE_HEIGHT)/2;
  const x=PADDING+depth*(NODE_WIDTH+COLUMN_SPACING);
  const children=folded.has(path)?[]:topic.children??[];
  nodes.push({path,topic,depth,x,y,children:(topic.children??[]).length});
  let cursor=top;
  children.forEach((child,i)=>{
   const childPath=path+"."+i;
   const childHeight=heights.get(childPath)??NODE_HEIGHT;
   const childY=cursor+(childHeight-NODE_HEIGHT)/2;
   edges.push({fromX:x+NODE_WIDTH,fromY:y+NODE_HEIGHT/2,
    toX:x+NODE_WIDTH+COLUMN_SPACING,toY:childY+NODE_HEIGHT/2,kind:child.kind});
   place(child,childPath,depth+1,cursor);
   cursor+=childHeight+ROW_SPACING;
  });
 }
 place(root,"0",0,PADDING);
 return {nodes,edges,width:PADDING*2+(maxDepth+1)*NODE_WIDTH+maxDepth*COLUMN_SPACING,height:height+PADDING*2};
}

export function MindMapPreview({value,note=""}:{value:XMindPreview;note?:string}){
 const [sheetIndex,setSheetIndex]=useState(0);
 const [folded,setFolded]=useState<Set<string>>(()=>new Set());
 const [selectedPath,setSelectedPath]=useState<string|null>(null);
 const [zoom,setZoom]=useState(1);
 const [pan,setPan]=useState({x:40,y:40});
 const surface=useRef<HTMLDivElement>(null);
 const drag=useRef<{id:number;startX:number;startY:number;x:number;y:number}|null>(null);
 const sheet=value.sheets[sheetIndex]??value.sheets[0];
 const layout=useMemo(()=>sheet?arrange(sheet.root,folded):null,[sheet,folded]);
 const selected=layout?.nodes.find(n=>n.path===selectedPath);
 function fit(){
  if(!layout||!surface.current)return;
  const {clientWidth,clientHeight}=surface.current;
  if(!clientWidth||!clientHeight)return;
  const scale=clamp(Math.min((clientWidth-65)/layout.width,(clientHeight-65)/layout.height),.25,1.4);
  setZoom(scale);
  setPan({x:(clientWidth-layout.width*scale)/2,y:(clientHeight-layout.height*scale)/2});
 }
 useEffect(()=>{fit();},[sheetIndex,layout?.width,layout?.height]);
 useEffect(()=>{setFolded(new Set());setSelectedPath(null);},[sheetIndex]);
 function updateZoom(next:number,anchorX?:number,anchorY?:number){
  const value=clamp(next,.25,2.5);
  const x=anchorX??(surface.current?.clientWidth??0)/2;
  const y=anchorY??(surface.current?.clientHeight??0)/2;
  setPan(previous=>({x:x-(x-previous.x)*value/zoom,y:y-(y-previous.y)*value/zoom}));
  setZoom(value);
 }
 function wheel(event:WheelEvent<HTMLDivElement>){
  if(!event.ctrlKey&&!event.metaKey)return;
  event.preventDefault();
  const bounds=surface.current?.getBoundingClientRect();
  if(!bounds)return;
  updateZoom(zoom*(event.deltaY>0?.92:1.08),event.clientX-bounds.left,event.clientY-bounds.top);
 }
 function pointerDown(event:PointerEvent<HTMLDivElement>){
  if(event.button!==0||(event.target as HTMLElement).closest("button"))return;
  drag.current={id:event.pointerId,startX:event.clientX,startY:event.clientY,x:pan.x,y:pan.y};
  event.currentTarget.setPointerCapture(event.pointerId);
 }
 function pointerMove(event:PointerEvent<HTMLDivElement>){
  if(!drag.current||drag.current.id!==event.pointerId)return;
  const origin=drag.current;
  setPan({x:origin.x+event.clientX-origin.startX,y:origin.y+event.clientY-origin.startY});
 }
 function stopPan(event:PointerEvent<HTMLDivElement>){
  if(drag.current?.id!==event.pointerId)return;
  drag.current=null;
  if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
 }
 function toggle(path:string){
  setFolded(before=>{
   const next=new Set(before);
   if(next.has(path))next.delete(path);else next.add(path);
   return next;
  });
 }
 if(!sheet||!layout)return <div className="xmind-empty" role="status">没有可预览的思维导图画布。</div>;
 return <div className="xmind-viewer" aria-label="XMind 思维导图只读预览">
  <div className="xmind-bar">
   <div className="xmind-sheets" role="tablist" aria-label="思维导图画布">
    {value.sheets.map((item,i)=><RareButton key={i} type="button" tone="ghost" role="tab" aria-selected={i===sheetIndex}
      className={"xmind-sheet"+(i===sheetIndex?" is-active":"")} onClick={()=>setSheetIndex(i)}
      title={item.title}>{item.title}</RareButton>)}
   </div>
   <div className="xmind-tools" role="group" aria-label="画布工具">
    <RareButton type="button" tone="ghost" title="全部展开" onClick={()=>setFolded(new Set())}>展开</RareButton>
    <RareButton type="button" tone="ghost" title="折叠到第一级" onClick={()=>{
     const next=new Set<string>();
     const walk=(topic:XMindTopic,path:string,depth:number)=>{
      if(depth>0&&(topic.children?.length??0)>0)next.add(path);
      topic.children?.forEach((child,i)=>walk(child,path+"."+i,depth+1));
     };
     walk(sheet.root,"0",0);setFolded(next);setSelectedPath(null);
    }}>收起</RareButton>
    <span className="xmind-divider" aria-hidden="true"/>
    <RareButton type="button" tone="ghost" aria-label="缩小" onClick={()=>updateZoom(zoom/1.2)}>−</RareButton>
    <span className="xmind-zoom">{Math.round(zoom*100)}%</span>
    <RareButton type="button" tone="ghost" aria-label="放大" onClick={()=>updateZoom(zoom*1.2)}>＋</RareButton>
    <RareButton type="button" tone="ghost" onClick={fit}>适应画布</RareButton>
   </div>
  </div>
  <div className={"xmind-surface"+(drag.current?" is-dragging":"")} ref={surface}
   onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={stopPan}
   onPointerCancel={stopPan} onWheel={wheel} aria-label="思维导图画布，可以拖动；按 Ctrl 或 Command 并滚轮缩放">
   <div className="xmind-stage" style={{width:layout.width,height:layout.height,transform:`translate(${pan.x}px,${pan.y}px) scale(${zoom})`}}>
    <svg width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`}
     className="xmind-edges" aria-hidden="true">
     {layout.edges.map((edge,i)=><path key={i}
      d={`M ${edge.fromX} ${edge.fromY} C ${edge.fromX+35} ${edge.fromY}, ${edge.toX-35} ${edge.toY}, ${edge.toX} ${edge.toY}`}
      className={edge.kind==="floating"?"is-floating":""}/>)}
    </svg>
    {layout.nodes.map(node=><div key={node.path}
      className={"xmind-node"+(node.depth===0?" is-root":"")+(selectedPath===node.path?" is-selected":"")+
       (node.topic.kind==="floating"?" is-floating":"")}
      style={{left:node.x,top:node.y,width:NODE_WIDTH,height:NODE_HEIGHT}}>
      <RareButton type="button" tone="ghost" className="xmind-node-title" title={node.topic.title}
       aria-label={"主题："+node.topic.title} aria-pressed={selectedPath===node.path}
       onClick={()=>setSelectedPath(path=>path===node.path?null:node.path)}>{node.topic.title}</RareButton>
      {node.children>0&&<RareButton type="button" tone="ghost" className="xmind-fold" title={folded.has(node.path)?"展开子主题":"收起子主题"}
       aria-label={folded.has(node.path)?"展开子主题":"收起子主题"} aria-expanded={!folded.has(node.path)}
       onClick={()=>toggle(node.path)}>{folded.has(node.path)?"+" :"−"}</RareButton>}
     </div>)}
   </div>
   {selected&&<aside className="xmind-details" aria-label="主题详情">
    <div className="xmind-details-heading"><strong title={selected.topic.title}>{selected.topic.title}</strong>
     <RareButton type="button" tone="ghost" aria-label="关闭主题详情" onClick={()=>setSelectedPath(null)}>×</RareButton></div>
    {selected.topic.kind&&<small>{selected.topic.kind==="floating"?"自由主题":selected.topic.kind==="summary"?"概要":"标注"}</small>}
    {!!selected.topic.labels?.length&&<div className="xmind-labels">{selected.topic.labels.map((label,i)=><span key={i}>{label}</span>)}</div>}
    {!!selected.topic.markers?.length&&<p className="xmind-markers">标记：{selected.topic.markers.join(" · ")}</p>}
    {selected.topic.notes?<p className="xmind-notes">{selected.topic.notes}</p>:<p className="xmind-no-notes">无备注</p>}
   </aside>}
   <div className="xmind-canvas-hint">拖动画布 · Ctrl / ⌘ + 滚轮缩放 · 点击主题查看备注</div>
  </div>
  <div className="xmind-status">
   <span>{sheet.title} · 共 {value.topicCount.toLocaleString()} 个主题 · 只读</span>
   {(value.truncated||note)&&<span role="status">{note||"仅显示安全预览范围内的主题"}</span>}
  </div>
 </div>;
}
