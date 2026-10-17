import {useEffect,useMemo,useRef,useState,type PointerEvent,type MouseEvent,type WheelEvent} from "react";
import {RareButton,RareInput} from "../../shared/ui/rare";
import type {XMindPreview,XMindTopic} from "../../entities/file/model";
import {indexMindMap,layoutMindMap,MIND_NODE_WIDTH,MIND_NODE_HEIGHT,type MindMapDirection} from "./mindMapLayout";
import "./mindMapPreview.css";

const clamp=(n:number,low:number,high:number)=>Math.min(high,Math.max(low,n));
type Viewport={width:number;height:number};
const structureName=(structure?:string)=>{
 if(!structure)return "思维导图";
 if(structure.includes("org-chart"))return "组织结构图";
 if(structure.includes("logic"))return "逻辑图";
 if(structure.includes("tree"))return "树状图";
 if(structure.includes("fishbone"))return "鱼骨图";
 if(structure.includes("timeline"))return "时间线";
 if(structure.includes("matrix"))return "矩阵";
 return "思维导图";
};
const safeImage=(source?:string)=>source&&/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(source)?source:undefined;
const safeWebLink=(source?:string)=>{
 if(!source||!/^https?:\/\//i.test(source))return undefined;
 try{
  const link=new URL(source);
  return (link.protocol==="https:"||link.protocol==="http:")&&link.username===""&&link.password===""?link.href:undefined;
 }catch{return undefined;}
};
function textContrast(fill?:string){
 if(!fill)return undefined;
 let hex=fill.slice(1);
 if(hex.length===3)hex=hex.split("").map(c=>c+c).join("");
 const red=parseInt(hex.slice(0,2),16),green=parseInt(hex.slice(2,4),16),blue=parseInt(hex.slice(4,6),16);
 return red*.299+green*.587+blue*.114>155?"#25354A":"#FFFFFF";
}
function initialFolds(root?:XMindTopic,large=false):Set<string>{
 const folds=new Set<string>();
 if(!root)return folds;
 function walk(topic:XMindTopic,path:string,depth:number){
  if(topic.children?.length&&(topic.collapsed||(large&&depth>=2)))folds.add(path);
  topic.children?.forEach((child,i)=>walk(child,path+"."+i,depth+1));
 }
 walk(root,"0",0);
 return folds;
}
function ancestorPaths(path:string){
 const ancestors:string[]=[];
 let cursor=path.lastIndexOf(".");
 while(cursor>0){ancestors.push(path.slice(0,cursor));cursor=path.lastIndexOf(".",cursor-1);}
 return ancestors;
}

export function MindMapPreview({value,note=""}:{value?:XMindPreview;note?:string}){
 const [sheetIndex,setSheetIndex]=useState(0);
 const sheet=value?.sheets[sheetIndex]??value?.sheets[0];
 const big=(value?.topicCount??0)>350;
 const [folded,setFolded]=useState<Set<string>>(()=>initialFolds(value?.sheets[0]?.root,big));
 const [direction,setDirection]=useState<MindMapDirection>("balanced");
 const [selectedPath,setSelectedPath]=useState<string|null>(null);
 const [outlineOpen,setOutlineOpen]=useState(false);
 const [search,setSearch]=useState("");
 const [zoom,setZoom]=useState(1);
 const [pan,setPan]=useState({x:0,y:0});
 const [viewport,setViewport]=useState<Viewport>({width:0,height:0});
 const [fitNonce,setFitNonce]=useState(0);
 const [focusPath,setFocusPath]=useState<string|null>(null);
 const surface=useRef<HTMLDivElement>(null);
 const searchRef=useRef<HTMLInputElement>(null);
 const mapRef=useRef<HTMLCanvasElement>(null);
 const drag=useRef<{id:number;startX:number;startY:number;x:number;y:number}|null>(null);
 const fitted=useRef("");
 const indexed=useMemo(()=>sheet?indexMindMap(sheet.root):[],[sheet]);
 const layout=useMemo(()=>sheet?layoutMindMap(sheet.root,folded,direction):null,[sheet,folded,direction]);
 const selected=layout?.nodes.find(item=>item.path===selectedPath);
 const topicIds=useMemo(()=>{
  const once=new Map<string,string>(),duplicate=new Set<string>();
  for(const item of indexed){
   const id=item.topic.id;
   if(!id)continue;
   if(once.has(id)){duplicate.add(id);continue;}
   once.set(id,item.path);
  }
  duplicate.forEach(id=>once.delete(id));
  return once;
 },[indexed]);
 const relationships=useMemo(()=>sheet?.relationships?.filter(link=>
  topicIds.has(link.fromId)&&topicIds.has(link.toId))??[],[sheet,topicIds]);
 const nodeById=useMemo(()=>{
  const lookup=new Map<string,NonNullable<typeof layout>["nodes"][number]>();
  layout?.nodes.forEach(node=>{
   if(node.topic.id&&topicIds.has(node.topic.id))lookup.set(node.topic.id,node);
  });
  return lookup;
 },[layout,topicIds]);
 const related=selected?.topic.id?relationships.filter(link=>
  link.fromId===selected.topic.id||link.toId===selected.topic.id):[];
 const relationshipPaths=relationships.flatMap((link,i)=>{
  const from=nodeById.get(link.fromId),to=nodeById.get(link.toId);
  if(!from||!to)return [];
  const fromX=from.x+MIND_NODE_WIDTH/2,fromY=from.y+MIND_NODE_HEIGHT/2;
  const toX=to.x+MIND_NODE_WIDTH/2,toY=to.y+MIND_NODE_HEIGHT/2;
  const top=Math.min(fromY,toY)-Math.max(45,Math.min(160,Math.abs(toX-fromX)/3));
  return [{link,key:"relation-"+i,fromX,fromY,toX,toY,top}];
 }).filter(line=>{
  if(!viewport.width)return false;
  const show=(x:number,y:number)=>{
   const px=pan.x+x*zoom,py=pan.y+y*zoom;
   return px>-200&&px<viewport.width+200&&py>-200&&py<viewport.height+200;
  };
  return show(line.fromX,line.fromY)&&show(line.toX,line.toY);
 });
 const selectedImage=selected?.topic.image?safeImage(value?.images?.[selected.topic.image]):undefined;
 const selectedWebLink=safeWebLink(selected?.topic.link);
 const matches=useMemo(()=>{
  const term=search.trim().toLocaleLowerCase();
  return term?indexed.filter(item=>item.topic.title.toLocaleLowerCase().includes(term)||
    item.topic.notes?.toLocaleLowerCase().includes(term)||item.topic.labels?.some(label=>label.toLocaleLowerCase().includes(term))||
    item.topic.markers?.some(marker=>marker.toLocaleLowerCase().includes(term))):indexed;
 },[search,indexed]);
 const listed=matches.slice(0,180);
 useEffect(()=>{
  const el=surface.current;
  if(!el)return;
  const observer=new ResizeObserver(()=>{
   setViewport(v=>{
    const width=el.clientWidth,height=el.clientHeight;
    return v.width===width&&v.height===height?v:{width,height};
   });
  });
  observer.observe(el);
  return()=>observer.disconnect();
 },[!!sheet]);
 const mapScale=layout?Math.min(180/layout.width,96/layout.height):0;
 const mapOffsetX=layout?(196-layout.width*mapScale)/2:0;
 const mapOffsetY=layout?(112-layout.height*mapScale)/2:0;
 useEffect(()=>{
  const canvas=mapRef.current;
  const ctx=canvas?.getContext("2d");
  if(!canvas||!ctx||!layout||!mapScale)return;
  ctx.clearRect(0,0,196,112);
  ctx.fillStyle="#E9F0F8";
  for(const node of layout.nodes){
   ctx.fillStyle=node.path===selectedPath?"#176DCE":node.depth===0?"#397EC2":"#9EB9D7";
   ctx.fillRect(mapOffsetX+node.x*mapScale,mapOffsetY+node.y*mapScale,
    Math.max(2,MIND_NODE_WIDTH*mapScale),Math.max(2,MIND_NODE_HEIGHT*mapScale));
  }
  const x=mapOffsetX-pan.x/zoom*mapScale,y=mapOffsetY-pan.y/zoom*mapScale;
  ctx.strokeStyle="#0058D0";ctx.lineWidth=1.5;ctx.strokeRect(x,y,
   viewport.width/zoom*mapScale,viewport.height/zoom*mapScale);
 },[layout,mapScale,mapOffsetX,mapOffsetY,pan,zoom,viewport,selectedPath]);
 function mapJump(event:MouseEvent<HTMLCanvasElement>){
  if(!layout||!mapScale)return;
  const b=event.currentTarget.getBoundingClientRect();
  const x=((event.clientX-b.left)*196/b.width-mapOffsetX)/mapScale;
  const y=((event.clientY-b.top)*112/b.height-mapOffsetY)/mapScale;
  setPan({x:viewport.width/2-x*zoom,y:viewport.height/2-y*zoom});
 }
 function fitCanvas(){
  if(!layout||viewport.width<=0||viewport.height<=0)return;
  const availableWidth=Math.max(70,viewport.width-64);
  const availableHeight=Math.max(70,viewport.height-64);
  const ideal=Math.min(availableWidth/layout.width,availableHeight/layout.height);
  const scale=clamp(ideal,.12,1.25);
  const root=layout.nodes[0];
  // When the whole map is too large to fit at the readable minimum scale,
  // prioritize the root instead of centering on miles of invisible canvas.
  if(ideal<.12&&root){
   setPan({x:viewport.width/2-(root.x+MIND_NODE_WIDTH/2)*scale,
    y:viewport.height/2-(root.y+MIND_NODE_HEIGHT/2)*scale});
  }else{
   setPan({x:(viewport.width-layout.width*scale)/2,y:(viewport.height-layout.height*scale)/2});
  }
  setZoom(scale);
 }
 const fitKey=sheetIndex+":"+direction+":"+viewport.width+":"+viewport.height+":"+fitNonce;
 useEffect(()=>{
  if(!layout||viewport.width===0||viewport.height===0||fitted.current===fitKey)return;
  fitted.current=fitKey;
  fitCanvas();
 },[layout,fitKey]);
 useEffect(()=>{
  if(!focusPath||!layout||!viewport.width)return;
  const node=layout.nodes.find(item=>item.path===focusPath);
  if(!node)return;
  setPan({x:viewport.width/2-(node.x+MIND_NODE_WIDTH/2)*zoom,
   y:viewport.height/2-(node.y+MIND_NODE_HEIGHT/2)*zoom});
  setFocusPath(null);
 },[focusPath,layout,zoom,viewport.width,viewport.height]);
 function switchSheet(i:number){
  const root=value?.sheets[i]?.root;
  setSheetIndex(i);setFolded(initialFolds(root,big));setSelectedPath(null);
  setSearch("");setFocusPath(null);
 }
 function jump(path:string){
  setFolded(old=>{
   const updated=new Set(old);
   ancestorPaths(path).forEach(item=>updated.delete(item));
   return updated;
  });
  setSelectedPath(path);setFocusPath(path);
  setOutlineOpen(false);
 }
 function changeZoom(next:number,x=viewport.width/2,y=viewport.height/2){
  const target=clamp(next,.12,3);
  setPan(previous=>({x:x-(x-previous.x)*target/zoom,y:y-(y-previous.y)*target/zoom}));
  setZoom(target);
 }
 function wheel(event:WheelEvent<HTMLDivElement>){
  event.preventDefault();
  if(event.ctrlKey||event.metaKey){
   const rect=surface.current?.getBoundingClientRect();
   if(rect)changeZoom(zoom*Math.exp(-event.deltaY*.004),event.clientX-rect.left,event.clientY-rect.top);
  }else{
   setPan(previous=>({x:previous.x-event.deltaX,y:previous.y-event.deltaY}));
  }
 }
 function pointerDown(event:PointerEvent<HTMLDivElement>){
  if(event.button!==0||(event.target as HTMLElement).closest("button,input"))return;
  drag.current={id:event.pointerId,startX:event.clientX,startY:event.clientY,x:pan.x,y:pan.y};
  event.currentTarget.setPointerCapture(event.pointerId);
 }
 function pointerMove(event:PointerEvent<HTMLDivElement>){
  const initial=drag.current;
  if(!initial||initial.id!==event.pointerId)return;
  setPan({x:initial.x+event.clientX-initial.startX,y:initial.y+event.clientY-initial.startY});
 }
 function stopPan(event:PointerEvent<HTMLDivElement>){
  if(drag.current?.id!==event.pointerId)return;
  drag.current=null;
  if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
 }
 function toggle(path:string){
  setFolded(old=>{
   const updated=new Set(old);
   if(updated.has(path))updated.delete(path);else updated.add(path);
   return updated;
  });
 }
 function foldDeep(){
  if(!sheet)return;
  const next=new Set<string>();
  indexed.forEach(item=>{
   if(item.depth>=1&&item.topic.children?.length)next.add(item.path);
  });
  setFolded(next);setSelectedPath(null);
 }
 const visibleNodes=layout?.nodes.filter(node=>{
  if(!viewport.width)return node.depth<=2;
  const left=pan.x+node.x*zoom,top=pan.y+node.y*zoom;
  return left<viewport.width+170&&left+MIND_NODE_WIDTH*zoom> -170&&
   top<viewport.height+170&&top+MIND_NODE_HEIGHT*zoom> -170;
 })??[];
 const visiblePaths=new Set(visibleNodes.map(item=>item.path));
 const edges=layout?.edges.filter(edge=>{
  if(visiblePaths.has(edge.key))return true;
  if(!viewport.width)return false;
  const minX=pan.x+Math.min(edge.fromX,edge.toX)*zoom;
  const maxX=pan.x+Math.max(edge.fromX,edge.toX)*zoom;
  const minY=pan.y+Math.min(edge.fromY,edge.toY)*zoom;
  const maxY=pan.y+Math.max(edge.fromY,edge.toY)*zoom;
  return maxX>=-150&&minX<=viewport.width+150&&maxY>=-150&&minY<=viewport.height+150;
 })??[];

 return <div className="xmind-viewer" aria-label="XMind 思维导图只读预览">
  {!sheet||!layout?<div className="xmind-invalid" role="status">
   <strong>无法展示此思维导图</strong><p>{note||"未找到可解析的画布或主题。请检查文件完整性及 XMind 格式。"}</p>
  </div>:<>
   <div className="xmind-bar">
    <div className="xmind-sheets" role="tablist" aria-label="XMind 工作表">
     {value?.sheets.map((item,i)=><RareButton key={i} type="button" tone="ghost" role="tab"
      aria-selected={i===sheetIndex} className={"xmind-sheet"+(i===sheetIndex?" is-active":"")}
      title={item.title} onClick={()=>switchSheet(i)}>{item.title}</RareButton>)}
    </div>
    <div className="xmind-tools" role="group" aria-label="思维导图阅读工具">
     <RareButton type="button" tone="ghost" className="xmind-outline-toggle" aria-pressed={outlineOpen}
      onClick={()=>setOutlineOpen(v=>!v)}>{outlineOpen?"关闭目录":"目录 / 搜索"}</RareButton>
     <span className="xmind-divider"/>
     <RareButton type="button" tone="ghost" aria-pressed={direction==="balanced"}
      onClick={()=>setDirection("balanced")} title="左右均衡展开">左右</RareButton>
     <RareButton type="button" tone="ghost" aria-pressed={direction==="right"}
      onClick={()=>setDirection("right")} title="仅向右展开">向右</RareButton>
     <span className="xmind-divider"/>
     <RareButton type="button" tone="ghost" title="展开全部主题" onClick={()=>setFolded(new Set())}>展开</RareButton>
     <RareButton type="button" tone="ghost" title="收起第 2 级以下主题" onClick={foldDeep}>收起</RareButton>
     <span className="xmind-divider"/>
     <RareButton type="button" tone="ghost" title="缩小" aria-label="缩小" onClick={()=>changeZoom(zoom/1.25)}>−</RareButton>
     <span className="xmind-zoom">{Math.round(zoom*100)}%</span>
     <RareButton type="button" tone="ghost" title="放大" aria-label="放大" onClick={()=>changeZoom(zoom*1.25)}>＋</RareButton>
     <RareButton type="button" tone="ghost" onClick={()=>setFitNonce(v=>v+1)}>适应画布</RareButton>
     <RareButton type="button" tone="ghost" title="居中根主题" onClick={()=>jump("0")}>根主题</RareButton>
    </div>
   </div>
   <div className="xmind-main">
    {outlineOpen&&<aside className="xmind-outline" aria-label="主题目录与搜索">
     <div className="xmind-outline-search">
      <RareInput ref={searchRef} value={search} type="search" placeholder="搜索主题、备注"
       aria-label="搜索思维导图主题或备注" onChange={e=>setSearch(e.target.value)}
       onKeyDown={e=>{if(e.key==="Enter"&&matches[0])jump(matches[0].path);if(e.key==="Escape")setOutlineOpen(false);}}/>
      <small>{search.trim()?matches.length+" 个结果":indexed.length+" 个主题"}</small>
     </div>
     <div className="xmind-outline-scroll" role="list">
      {listed.map(item=><RareButton key={item.path} type="button" tone="ghost" role="listitem"
       className={"xmind-outline-row"+(item.path===selectedPath?" is-current":"")}
       style={{paddingLeft:11+Math.min(item.depth,6)*12}}
       title={item.topic.title} onClick={()=>jump(item.path)}>
       <span className="xmind-outline-depth" aria-hidden="true">{item.topic.children?.length?"◇":"·"}</span>
       <span className="xmind-outline-text">{item.topic.title}</span>
      </RareButton>)}
      {matches.length>listed.length&&<p className="xmind-outline-hint">只列出前 {listed.length} 项，可搜索缩小范围</p>}
      {matches.length===0&&<p className="xmind-outline-hint">未找到匹配的主题</p>}
     </div>
    </aside>}
    <div className="xmind-surface" ref={surface} role="region" tabIndex={0}
     aria-label="思维导图画布，拖动平移、滚轮移动，按 Ctrl 或 Command 并滚轮缩放"
     onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={stopPan}
     onPointerCancel={stopPan} onWheel={wheel}
     onKeyDown={event=>{
      if(event.target!==event.currentTarget)return;
      if(event.key==="Escape"){setSelectedPath(null);setOutlineOpen(false);}
      if(event.key==="+"||event.key==="="){event.preventDefault();changeZoom(zoom*1.25);}
      if(event.key==="-"){event.preventDefault();changeZoom(zoom/1.25);}
      if(event.key==="0"){event.preventDefault();setFitNonce(n=>n+1);}
      if(event.key==="/"){event.preventDefault();setOutlineOpen(true);requestAnimationFrame(()=>searchRef.current?.focus());}
     }}>
     <div className="xmind-stage" style={{width:layout.width,height:layout.height,
      transform:"translate("+pan.x+"px,"+pan.y+"px) scale("+zoom+")"}}>
      <svg width={layout.width} height={layout.height} viewBox={"0 0 "+layout.width+" "+layout.height}
       className="xmind-edges" aria-hidden="true">
       {edges.map(edge=>{
        const side=edge.fromX<=edge.toX?1:-1;
        return <path key={edge.key} d={"M "+edge.fromX+" "+edge.fromY+" C "+
         (edge.fromX+side*38)+" "+edge.fromY+", "+(edge.toX-side*38)+" "+edge.toY+", "+edge.toX+" "+edge.toY}
         className={edge.kind==="floating"?"is-floating":""}/>;
       })}
       {relationshipPaths.map(line=><g key={line.key} className="xmind-relationship">
        <title>{line.link.title||"关联关系"}</title>
        <path d={"M "+line.fromX+" "+line.fromY+" Q "+
         ((line.fromX+line.toX)/2)+" "+line.top+" "+line.toX+" "+line.toY}/>
        {line.link.title&&<text x={(line.fromX+line.toX)/2}
         y={(line.fromY+line.toY+line.top*2)/4-5}
         textAnchor="middle">{line.link.title}</text>}
       </g>)}
      </svg>
      {visibleNodes.map(node=><div key={node.path} style={{left:node.x,top:node.y,width:MIND_NODE_WIDTH,height:MIND_NODE_HEIGHT,...(node.topic.color?.fill?{backgroundColor:node.topic.color.fill}:{})}}
       className={"xmind-node"+(node.depth===0?" is-root":"")+(selectedPath===node.path?" is-selected":"")+
       (node.topic.kind?" is-"+node.topic.kind:"")}>
       {node.topic.image&&safeImage(value?.images?.[node.topic.image])&&<img className="xmind-node-image" alt="" src={safeImage(value?.images?.[node.topic.image])}/>}
       <RareButton type="button" tone="ghost" className="xmind-node-title" title={node.topic.title}
        aria-label={"主题："+node.topic.title} aria-pressed={selectedPath===node.path}
        style={node.topic.color?.text?{color:node.topic.color.text}:node.topic.color?.fill?{color:textContrast(node.topic.color.fill)}:undefined}
        onClick={()=>setSelectedPath(path=>path===node.path?null:node.path)}>
        {node.topic.title}
       </RareButton>
       {(node.topic.notes||node.topic.labels?.length||node.topic.markers?.length||node.topic.link||node.topic.boundaries?.length||node.topic.summaries?.length)&&
        <span className="xmind-node-meta" aria-hidden="true" title="有备注、标签或标记">•</span>}
       {node.children>0&&<RareButton type="button" tone="ghost" className="xmind-fold"
        aria-label={folded.has(node.path)?"展开子主题":"收起子主题"}
        aria-expanded={!folded.has(node.path)} title={folded.has(node.path)?"展开子主题":"收起子主题"}
        onClick={()=>toggle(node.path)}>{folded.has(node.path)?"+" :"−"}</RareButton>}
      </div>)}
     </div>
     {selected&&<aside className="xmind-details" aria-label="主题详情">
      <div className="xmind-details-heading"><strong>{selected.topic.title}</strong>
       <RareButton type="button" tone="ghost" aria-label="关闭主题详情" onClick={()=>setSelectedPath(null)}>×</RareButton></div>
      {selected.topic.kind&&<small>{selected.topic.kind==="floating"?"自由主题":selected.topic.kind==="summary"?"概要":"标注主题"}</small>}
      {selected.topic.labels?.length?<div className="xmind-labels">{selected.topic.labels.map((label,i)=><span key={i}>{label}</span>)}</div>:null}
      {selected.topic.markers?.length?<p className="xmind-markers">标记：{selected.topic.markers.join(" · ")}</p>:null}
      {selectedImage&&<img className="xmind-preview-image" alt={"主题图片："+selected.topic.title} src={selectedImage}/>}
      {selected.topic.link&&(selectedWebLink?
       <a className="xmind-link" href={selectedWebLink} target="_blank" rel="noopener noreferrer">打开外部链接 ↗</a>:
       selected.topic.link.startsWith("xmind:#")&&topicIds.has(selected.topic.link.slice(7))?
       <RareButton type="button" tone="ghost" className="xmind-detail-jump"
        onClick={()=>jump(topicIds.get(selected.topic.link!.slice(7))!)}>跳转关联主题 ↗</RareButton>:
       <p className="xmind-unsupported-link">包含本地附件或其他引用，无法在浏览器中安全打开</p>)}
      {selected.topic.boundaries?.length?<section className="xmind-annotation" aria-label="边界">
       <strong>边界分组</strong>
       {selected.topic.boundaries.map((entry,i)=><p key={i}>{entry.title||"未命名边界"}{entry.range?" · "+entry.range:""}</p>)}
      </section>:null}
      {selected.topic.summaries?.length?<section className="xmind-annotation" aria-label="概要">
       <strong>概要范围</strong>
       {selected.topic.summaries.map((entry,i)=><p key={i}>{entry.title||"概要"}{entry.range?" · "+entry.range:""}</p>)}
      </section>:null}
      {related.length>0&&<section className="xmind-detail-relations" aria-label="关联关系">
       <strong>关联关系（{related.length}）</strong>
       {related.map((rel,i)=>{
        const id=rel.fromId===selected.topic.id?rel.toId:rel.fromId;
        const destination=topicIds.get(id);
        const target=indexed.find(item=>item.path===destination);
        return destination&&target?<RareButton key={i} type="button" tone="ghost"
         className="xmind-detail-jump" onClick={()=>jump(destination)}>
         {rel.title?rel.title+" · ":""}{target.topic.title} ↗
        </RareButton>:null;
       })}
      </section>}
      {selected.topic.notes?<p className="xmind-notes">{selected.topic.notes}</p>:<p className="xmind-no-notes">无备注</p>}
     </aside>}
     <canvas className="xmind-minimap" ref={mapRef} width={196} height={112}
      role="button" tabIndex={0} title="导航小地图，点击可跳转到对应位置"
      aria-label="导航小地图，点击移动画布，按回车键返回根主题"
      onPointerDown={event=>event.stopPropagation()}
      onClick={mapJump}
      onKeyDown={event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();jump("0");}}}/>
     <div className="xmind-canvas-hint">拖动平移 · 滚轮移动 · Ctrl / ⌘ + 滚轮缩放</div>
    </div>
   </div>
   <div className="xmind-status">
    <span>{sheet.title} · {structureName(sheet.structure)} · {layout.nodes.length} 个画布主题 · {relationships.length} 条关系 · 全文件 {value?.topicCount??0} 个 · 只读</span>
    <span title="保留关系、主题注释和受限图片预览；复杂布局、边界的原始几何位置仍为结构化近似">
     {note||(value?.truncated?"超过安全预览上限，部分主题已省略":"增强结构阅读 · 布局可能有差异")}
    </span>
   </div>
  </>}
 </div>;
}
