import {useCallback,useEffect,useLayoutEffect,useRef,useState,type MouseEvent,type PointerEvent} from "react";
import {RareButton} from "../../shared/ui/rare";
import {sealsApi} from "./api";
import {fitStampToPage} from "./sealGeometry";
import type {FileSealMark,SealAsset} from "../../entities/seal/model";

type StampPosition={x:number;y:number;width:number;height:number};
type StagedCanvasMark={assetId:string;asset?:SealAsset;pageNumber:number;x:number;y:number;width:number;height:number;angleDegrees:number};
type Props={
 drafts?:StagedCanvasMark[];
 fileId:string;page:number;imageUrl:string;selected?:SealAsset;marks:FileSealMark[];
 position:StampPosition;setPosition:(update:(value:StampPosition)=>StampPosition)=>void;
 angle:number;pageRatio:number;setPageRatio:(value:number)=>void;
 imageAvailable:boolean;setImageAvailable:(value:boolean)=>void;
};
const zoomLimit=(value:number)=>Math.max(1,Math.min(5,Math.round(value*100)/100));

/** Viewport zoom/pan is presentation-only; actual signatures use page-relative coordinates. */
export function SealPageCanvas({fileId,page,imageUrl,selected,marks,position,setPosition,angle,pageRatio,setPageRatio,imageAvailable,setImageAvailable,drafts=[]}:Props){
 const viewportRef=useRef<HTMLDivElement>(null);
 const dragRef=useRef<{x:number;y:number;left:number;top:number}|null>(null);
 const pendingAnchor=useRef<{x:number;y:number;oldZoom:number;left:number;top:number}|null>(null);
 const zoomRef=useRef(1);
 const[zoom,setZoom]=useState(1);
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
 useEffect(()=>{
  zoomRef.current=1;setZoom(1);
  const viewport=viewportRef.current;if(viewport){viewport.scrollLeft=0;viewport.scrollTop=0}
 },[imageUrl]);
 const fitWidth=Math.max(80,Math.min(Math.max(80,viewportWidth-24),Math.max(80,(viewportHeight-24)/pageRatio)));
 const displayWidth=fitWidth*zoom;
 const setZoomAt=useCallback((next:number,clientX?:number,clientY?:number)=>{
  const viewport=viewportRef.current;if(!viewport)return;
  const value=zoomLimit(next);
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
   if(!e.shiftKey){
    e.preventDefault();
    setZoomAt(zoomRef.current*(e.deltaY>0?0.9:1.1),e.clientX,e.clientY);
   }
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
  if(panMode||!selected)return;
  const rect=e.currentTarget.getBoundingClientRect();
  if(!rect.width||!rect.height)return;
  const x=(e.clientX-rect.left)/rect.width,y=(e.clientY-rect.top)/rect.height;
  setPosition(p=>fitStampToPage({...p,x:x-p.width/2,y:y-p.height/2},angle,pageRatio));
 }
 function fit(){
  zoomRef.current=1;pendingAnchor.current=null;setZoom(1);
  const viewport=viewportRef.current;if(viewport){viewport.scrollLeft=0;viewport.scrollTop=0}
 }
 return <div className="seal-file-preview">
  <div className="seal-page-toolbar">
   <strong>页面定位</strong>
   <div className="seal-page-tools" role="group" aria-label="PDF 视图工具">
    <RareButton type="button" aria-label="缩小页面" disabled={zoom<=1} onClick={()=>setZoomAt(zoomRef.current/1.25)}>−</RareButton>
    <span aria-live="polite" className="seal-page-zoom">{Math.round(zoom*100)}%</span>
    <RareButton type="button" aria-label="放大页面" disabled={zoom>=5} onClick={()=>setZoomAt(zoomRef.current*1.25)}>＋</RareButton>
    <RareButton type="button" onClick={fit}>适应页面</RareButton>
    <RareButton type="button" aria-pressed={panMode} onClick={()=>setPanMode(value=>!value)}>{panMode?"平移中":"拖动平移"}</RareButton>
   </div>
  </div>
  <div className="seal-page-viewport" ref={viewportRef} onPointerDown={pointerDown} onPointerMove={pointerMove}
   onPointerUp={pointerEnd} onPointerCancel={pointerEnd} aria-label="PDF 签章页面，可放大并拖动平移"
   style={{cursor:panMode?"grab":"auto",touchAction:panMode?"none":"auto"}}>
   {imageAvailable?<div className={"seal-page-surface"+(panMode?" is-panning":"")} style={{width:displayWidth+"px"}}
    onClick={place} role="button" tabIndex={0} aria-label="点击放置签章" onKeyDown={e=>{
     if(e.key==="Enter"||e.key===" "){e.preventDefault();setPosition(p=>fitStampToPage({...p,x:.5-p.width/2,y:.5-p.height/2},angle,pageRatio))}
    }}>
    <img src={imageUrl} alt={"PDF 第 "+page+" 页定位图"} onError={()=>setImageAvailable(false)} onLoad={e=>{
     const image=e.currentTarget;
     const ratio=image.naturalHeight/image.naturalWidth;
     if(Number.isFinite(ratio)&&ratio>0){
      setPageRatio(ratio);
      setPosition(p=>fitStampToPage(p,angle,ratio));
     }
    }}/>
    {drafts.filter(p=>p.pageNumber===page&&p.asset&&p.assetId!==selected?.id).map(p=><span key={p.assetId} className="seal-staged-mark" title={(p.asset?.ownerName||p.asset?.name||"签章")+" · 待签"} style={{left:p.x*100+"%",top:p.y*100+"%",width:p.width*100+"%",height:p.height*100+"%",transform:"rotate("+p.angleDegrees+"deg)"}}><img alt="" src={sealsApi.imageUrl(p.assetId)}/></span>)}
    {selected&&<span className="seal-position-mark" style={{left:position.x*100+"%",top:position.y*100+"%",width:position.width*100+"%",height:position.height*100+"%",transform:"rotate("+angle+"deg)"}}>
     <img alt="" src={sealsApi.imageUrl(selected.id)}/>
    </span>}
    {marks.filter(m=>m.pageNumber===page).map(m=><span key={m.id} className="seal-existing-mark" style={{left:m.x*100+"%",top:m.y*100+"%",width:m.width*100+"%",height:m.height*100+"%",transform:"rotate("+(m.angleDegrees??0)+"deg)"}}>
     <img alt={m.assetName} src={sealsApi.markImageUrl(fileId,m.id)}/></span>)}
   </div>:<p className="empty">页面图无法加载。请检查 PDF 预览和打印权限。</p>}
  </div>
  <span className="seal-page-tip">{panMode?"拖动页面平移，点击「平移中」可恢复盖章定位":"滚轮放大缩小 · 点击页面放置签章 · 选择「拖动平移」移动页面"}</span>
 </div>;
}
