import {useCallback,useEffect,useLayoutEffect,useRef,useState,type MouseEvent,type PointerEvent,type KeyboardEvent} from "react";
import {RareButton} from "../../shared/ui/rare";
import {sealsApi} from "./api";
import {fitStampToPage} from "./sealGeometry";
import type {FileSealMark,SealAsset} from "../../entities/seal/model";

type StampPosition={x:number;y:number;width:number;height:number};
type StagedCanvasMark={assetId:string;asset?:SealAsset;pageNumber:number;x:number;y:number;width:number;height:number;angleDegrees:number};
type Props={
 drafts?:StagedCanvasMark[];
 onSelectDraft:(assetId:string)=>void;onRemoveDraft:(assetId:string)=>void;
 pendingCount:number;onConfirm:()=>void;canConfirm:boolean;
 fileId:string;page:number;pageCount:number;onPageChange:(page:number)=>void;onRetry:()=>void;
 imageUrl:string;selected?:SealAsset;marks:FileSealMark[];
 position:StampPosition;setPosition:(update:(value:StampPosition)=>StampPosition)=>void;
 angle:number;pageRatio:number;setPageRatio:(value:number)=>void;
 imageAvailable:boolean;setImageAvailable:(value:boolean)=>void;
};
type StampDrag={kind:"move"|"nw"|"ne"|"sw"|"se";x:number;y:number;initial:StampPosition;rect:DOMRect};
const limit=(value:number)=>Math.max(.6,Math.min(5,Math.round(value*100)/100));

/** All mark coordinates remain normalized to the unscaled PDF page. */
export function SealPageCanvas({fileId,page,pageCount,onPageChange,onRetry,imageUrl,selected,marks,
 position,setPosition,angle,pageRatio,setPageRatio,imageAvailable,setImageAvailable,drafts=[],
 onSelectDraft,onRemoveDraft,pendingCount,onConfirm,canConfirm}:Props){
 const viewportRef=useRef<HTMLDivElement>(null);
 const surfaceRef=useRef<HTMLDivElement>(null);
 const dragRef=useRef<{x:number;y:number;left:number;top:number}|null>(null);
 const stampDragRef=useRef<StampDrag|null>(null);
 const pendingAnchor=useRef<{x:number;y:number;oldZoom:number;left:number;top:number}|null>(null);
 const zoomRef=useRef(1);
 const[zoom,setZoom]=useState(1);
 const[fitMode,setFitMode]=useState<"page"|"width">("width");
 const[panMode,setPanMode]=useState(false);
 const[viewportWidth,setViewportWidth]=useState(650);
 const[viewportHeight,setViewportHeight]=useState(590);
 useEffect(()=>{
  const element=viewportRef.current;if(!element)return;
  const measure=()=>{setViewportWidth(element.clientWidth);setViewportHeight(element.clientHeight)};
  measure();
  const observer=new ResizeObserver(measure);observer.observe(element);
  return()=>observer.disconnect();
 },[]);
 // Do not reset zoom or scroll merely because a page changed.
 useEffect(()=>{
  zoomRef.current=1;setZoom(1);setFitMode("width");setPanMode(false);
  const viewport=viewportRef.current;if(viewport){viewport.scrollLeft=0;viewport.scrollTop=0}
 },[fileId]);
 const availableWidth=Math.max(120,viewportWidth-32);
 const baseWidth=fitMode==="width"?availableWidth:Math.min(availableWidth,Math.max(120,(viewportHeight-32)/pageRatio));
 const displayWidth=baseWidth*zoom;
 // Focus a newly selected asset in the viewport rather than leaving it below
 // the fold in width-fit mode. Do not refocus on every pointer move.
 useLayoutEffect(()=>{
  if(!selected)return;
  const stagedPage=drafts.find(item=>item.assetId===selected.id)?.pageNumber;
  if(stagedPage!==undefined&&stagedPage!==page)return;
  const viewport=viewportRef.current;
  if(!viewport)return;
  const x=(position.x+position.width/2)*displayWidth;
  const y=(position.y+position.height/2)*displayWidth*pageRatio;
  viewport.scrollLeft=Math.max(0,x-viewport.clientWidth/2);
  viewport.scrollTop=Math.max(0,y-viewport.clientHeight/2);
 },[selected?.id,page]);
 const setZoomAt=useCallback((next:number,clientX?:number,clientY?:number)=>{
  const viewport=viewportRef.current;if(!viewport)return;
  const value=limit(next);
  if(value===zoomRef.current)return;
  const rect=viewport.getBoundingClientRect();
  pendingAnchor.current={
   x:clientX===undefined?viewport.clientWidth/2:clientX-rect.left,
   y:clientY===undefined?viewport.clientHeight/2:clientY-rect.top,
   left:viewport.scrollLeft,top:viewport.scrollTop,oldZoom:zoomRef.current
  };
  zoomRef.current=value;setZoom(value);
 },[]);
 useLayoutEffect(()=>{
  const viewport=viewportRef.current,anchor=pendingAnchor.current;
  if(!viewport||!anchor)return;
  const factor=zoom/anchor.oldZoom;
  viewport.scrollLeft=(anchor.left+anchor.x)*factor-anchor.x;
  viewport.scrollTop=(anchor.top+anchor.y)*factor-anchor.y;
  pendingAnchor.current=null;
 },[zoom]);
 useEffect(()=>{
  const viewport=viewportRef.current;if(!viewport)return;
  function wheel(e:WheelEvent){
   // Ordinary wheel/trackpad movement scrolls. Ctrl/Cmd-wheel zooms around pointer.
   if(!e.ctrlKey&&!e.metaKey)return;
   e.preventDefault();
   setZoomAt(zoomRef.current*(e.deltaY>0?.9:1.1),e.clientX,e.clientY);
  }
  viewport.addEventListener("wheel",wheel,{passive:false});
  return()=>viewport.removeEventListener("wheel",wheel);
 },[setZoomAt]);
 function pointerDown(e:PointerEvent<HTMLDivElement>){
  if(!panMode||e.button!==0)return;
  const viewport=viewportRef.current;if(!viewport)return;
  dragRef.current={x:e.clientX,y:e.clientY,left:viewport.scrollLeft,top:viewport.scrollTop};
  viewport.setPointerCapture(e.pointerId);e.preventDefault();
 }
 function pointerMove(e:PointerEvent<HTMLDivElement>){
  const drag=dragRef.current,viewport=viewportRef.current;
  if(!drag||!viewport)return;
  viewport.scrollLeft=drag.left-(e.clientX-drag.x);
  viewport.scrollTop=drag.top-(e.clientY-drag.y);
 }
 function pointerEnd(e:PointerEvent<HTMLDivElement>){
  dragRef.current=null;
  const viewport=viewportRef.current;
  if(viewport?.hasPointerCapture(e.pointerId))viewport.releasePointerCapture(e.pointerId);
 }
 function place(e:MouseEvent<HTMLDivElement>){
  if(panMode||!selected||!imageAvailable)return;
  const rect=e.currentTarget.getBoundingClientRect();
  if(!rect.width||!rect.height)return;
  const x=(e.clientX-rect.left)/rect.width,y=(e.clientY-rect.top)/rect.height;
  setPosition(p=>fitStampToPage({...p,x:x-p.width/2,y:y-p.height/2},angle,pageRatio));
 }
 function startStamp(e:PointerEvent<HTMLSpanElement>){
  if(!selected||panMode||e.button!==0)return;
  const rect=surfaceRef.current?.getBoundingClientRect();
  if(!rect||!rect.width||!rect.height)return;
  const target=e.target;
  const handle=target instanceof Element?target.closest<HTMLElement>(".seal-resize-handle"):null;
  const kind=handle?.dataset.corner as StampDrag["kind"]|undefined;
  stampDragRef.current={
   kind:kind??"move",x:e.clientX,y:e.clientY,initial:{...position},rect
  };
  e.currentTarget.setPointerCapture(e.pointerId);
  e.preventDefault();e.stopPropagation();
 }
 function moveStamp(e:PointerEvent<HTMLSpanElement>){
  const drag=stampDragRef.current;
  if(!drag)return;
  const dx=(e.clientX-drag.x)/drag.rect.width,dy=(e.clientY-drag.y)/drag.rect.height;
  if(drag.kind==="move"){
   setPosition(()=>fitStampToPage({...drag.initial,x:drag.initial.x+dx,y:drag.initial.y+dy},angle,pageRatio));
  }else{
   const start=drag.initial;
   const min=.05;
   let x=start.x,y=start.y,width=start.width,height=start.height;
   if(drag.kind==="nw"||drag.kind==="sw"){
    const delta=Math.min(start.width-min,dx);
    x+=delta;width-=delta;
   }else width=Math.max(min,width+dx);
   if(drag.kind==="nw"||drag.kind==="ne"){
    const delta=Math.min(start.height-min,dy);
    y+=delta;height-=delta;
   }else height=Math.max(min,height+dy);
   const resized=fitStampToPage({x,y,width,height},angle,pageRatio);
   if(resized.width<=1&&resized.height<=1&&resized.x>=-1e-6&&resized.y>=-1e-6&&
    resized.x+resized.width<=1+1e-6&&resized.y+resized.height<=1+1e-6){
    setPosition(()=>resized);
   }
  }
  e.stopPropagation();
 }
 function endStamp(e:PointerEvent<HTMLSpanElement>){
  stampDragRef.current=null;
  if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);
  e.stopPropagation();
 }
 function markKey(e:KeyboardEvent<HTMLSpanElement>){
  const dx=e.key==="ArrowLeft"?-1:e.key==="ArrowRight"?1:0;
  const dy=e.key==="ArrowUp"?-1:e.key==="ArrowDown"?1:0;
  if(!dx&&!dy)return;
  e.preventDefault();e.stopPropagation();
  const step=e.shiftKey?.02:.005;
  setPosition(p=>fitStampToPage({...p,x:p.x+dx*step,y:p.y+dy*step},angle,pageRatio));
 }
 function fit(){
  pendingAnchor.current=null;zoomRef.current=1;setZoom(1);
  const viewport=viewportRef.current;if(viewport){viewport.scrollLeft=0;viewport.scrollTop=0}
 }
 const stagedPage=drafts.find(d=>d.assetId===selected?.id)?.pageNumber;
 const activeOnPage=!!selected&&(stagedPage===undefined||stagedPage===page);
 return <div className="seal-file-preview">
  <div className="seal-page-toolbar">
   <div className="seal-page-tools" role="group" aria-label="PDF 页码">
    <RareButton type="button" aria-label="上一页" disabled={page<=1||!pageCount} onClick={()=>onPageChange(page-1)}>‹</RareButton>
    <span className="seal-page-count">第 {page} / {pageCount||"—"} 页</span>
    <RareButton type="button" aria-label="下一页" disabled={!pageCount||page>=pageCount} onClick={()=>onPageChange(page+1)}>›</RareButton>
   </div>
   <div className="seal-page-tools" role="group" aria-label="PDF 视图工具">
    <RareButton type="button" aria-label="缩小页面" disabled={zoom<=.6} onClick={()=>setZoomAt(zoomRef.current/1.25)}>−</RareButton>
    <span aria-live="polite" className="seal-page-zoom">{Math.round(zoom*100)}%</span>
    <RareButton type="button" aria-label="放大页面" disabled={zoom>=5} onClick={()=>setZoomAt(zoomRef.current*1.25)}>＋</RareButton>
    <RareButton type="button" onClick={()=>{setFitMode(m=>m==="page"?"width":"page");fit();}}>{fitMode==="page"?"适应页面":"适应宽度"}</RareButton>
    <RareButton type="button" aria-pressed={panMode} onClick={()=>setPanMode(value=>!value)}>{panMode?"退出平移":"平移"}</RareButton>
   </div>
   {pendingCount>0&&<RareButton type="button" className="seal-confirm-action primary"
    aria-label={"确认签署 "+pendingCount+" 枚签章"} disabled={!canConfirm} onClick={onConfirm}>
    确认签署 · {pendingCount}
   </RareButton>}
  </div>
  <div className="seal-page-viewport" ref={viewportRef} onPointerDown={pointerDown} onPointerMove={pointerMove}
   onPointerUp={pointerEnd} onPointerCancel={pointerEnd} aria-label="PDF 签章页面，可放大并拖动平移"
   style={{cursor:panMode?"grab":"auto",touchAction:panMode?"none":"auto"}}>
   {imageAvailable?<div ref={surfaceRef} className={"seal-page-surface"+(panMode?" is-panning":"")}
    style={{width:displayWidth+"px"}} onClick={place} role="button" tabIndex={0} aria-label="点击 PDF 页面定位签章"
    onKeyDown={e=>{if(e.target!==e.currentTarget)return;if(e.key==="Enter"||e.key===" "){e.preventDefault();setPosition(p=>fitStampToPage({...p,x:.5-p.width/2,y:.5-p.height/2},angle,pageRatio))}}}>
    <img src={imageUrl} alt={"PDF 第 "+page+" 页定位图"} onError={()=>setImageAvailable(false)}
     onLoad={e=>{const img=e.currentTarget;const ratio=img.naturalHeight/img.naturalWidth;if(Number.isFinite(ratio)&&ratio>0)setPageRatio(ratio)}}/>
    {drafts.filter(p=>p.pageNumber===page&&p.asset&&p.assetId!==selected?.id).map(p=>
     <RareButton key={p.assetId} type="button" className="seal-staged-mark"
      aria-label={"选择调整 "+(p.asset?.ownerName||p.asset?.name||"签章")}
      onClick={e=>{e.stopPropagation();onSelectDraft(p.assetId)}}
      style={{left:p.x*100+"%",top:p.y*100+"%",width:p.width*100+"%",height:p.height*100+"%"}}>
      <img alt="" draggable={false} src={sealsApi.imageUrl(p.assetId)} style={{transform:"rotate("+p.angleDegrees+"deg)"}}/>
     </RareButton>)}
    {activeOnPage&&<span className="seal-position-mark is-editable" role="group" tabIndex={0}
     aria-label={"调整 "+selected?.name+"；拖动移动，四角调整尺寸，方向键微调"}
     style={{left:position.x*100+"%",top:position.y*100+"%",width:position.width*100+"%",height:position.height*100+"%"}}
     onPointerDown={startStamp} onPointerMove={moveStamp} onPointerUp={endStamp} onPointerCancel={endStamp}
     onClick={e=>e.stopPropagation()} onKeyDown={markKey}>
     <img alt="" draggable={false} src={sealsApi.imageUrl(selected!.id)}
      style={{transform:"rotate("+angle+"deg)"}}/>
     <RareButton type="button" tone="ghost" className="seal-remove-mark"
      aria-label={"移除 "+selected!.name} title="移除此签章"
      disabled={false} onPointerDown={e=>e.stopPropagation()} onClick={e=>{e.stopPropagation();onRemoveDraft(selected!.id)}}>
      <svg viewBox="0 0 20 20" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M5 5l10 10M15 5 5 15"/></svg>
     </RareButton>
     {(["nw","ne","sw","se"] as const).map(corner=>
      <span key={corner} className={"seal-resize-handle is-"+corner} data-corner={corner} aria-hidden="true"/>)}
    </span>}
    {marks.filter(m=>m.pageNumber===page).map(m=><span key={m.id} className="seal-existing-mark"
     style={{left:m.x*100+"%",top:m.y*100+"%",width:m.width*100+"%",height:m.height*100+"%",transform:"rotate("+(m.angleDegrees??0)+"deg)"}}>
     <img alt={m.assetName} src={sealsApi.markImageUrl(fileId,m.id)}/></span>)}
   </div>:
    <div className="seal-page-error" role="alert">此页无法显示
     <RareButton type="button" onClick={()=>{setImageAvailable(true);onRetry()}}>重试加载</RareButton>
    </div>}
  </div>
  {selected&&<span className="seal-page-tip">{panMode?"拖动空白区域平移":stagedPage!==undefined&&stagedPage!==page?"点击当前页可将选中签章移至此页":"拖动签章调整位置 · 右下角调整大小 · Ctrl/⌘ + 滚轮缩放"}</span>}
 </div>;
}
