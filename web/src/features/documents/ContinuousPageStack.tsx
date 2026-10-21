import {forwardRef,useEffect,useImperativeHandle,useLayoutEffect,useMemo,useRef,useState,type PointerEvent} from "react";
import {BrandLoader} from "../../shared/ui/BrandLoader";
import {RareButton} from "../../shared/ui/rare";
import "./continuousPageStack.css";

const GAP=20;
const DEFAULT_RATIO=1.414;
export type ContinuousPageHandle={goToPage:(page:number)=>void};
type Viewport={width:number;height:number;left:number;right:number;top:number;bottom:number};
type Props={pages:number;className:string;label:string;pageUrl:(page:number,retry:number)=>string;zoom:number;
 fitMode?:"page"|"width";panMode?:boolean;onPageChange?:(page:number)=>void;imageLabel?:(page:number)=>string};

// Binary search over height estimates: no page images outside the small render
// window, even if the document contains thousands of pages.
function pageAt(offsets:number[],position:number){
 let lo=0,hi=offsets.length-2;
 while(lo<hi){const mid=(lo+hi+1)>>1;if(offsets[mid]<=position)lo=mid;else hi=mid-1;}
 return Math.max(0,lo);
}
export const ContinuousPageStack=forwardRef<ContinuousPageHandle,Props>(function ContinuousPageStack({
 pages,className,label,pageUrl,zoom,fitMode="page",panMode=false,onPageChange,imageLabel,
},ref){
 const stage=useRef<HTMLDivElement>(null);
 const drag=useRef<{x:number;y:number;left:number;top:number}|null>(null);
 const frame=useRef<number|null>(null);
 const previous=useRef<{offsets:number[];width:number}|null>(null);
 const[viewport,setViewport]=useState<Viewport>({width:0,height:0,left:0,right:0,top:0,bottom:0});
 const[ratios,setRatios]=useState<Record<number,number>>({});
 const[loaded,setLoaded]=useState<Record<number,"ready"|"failed">>({});
 const[retry,setRetry]=useState<Record<number,number>>({});
 const[active,setActive]=useState(1);
 const[window,setWindow]=useState({first:0,last:0});
 const ratio=ratios[1]??DEFAULT_RATIO;
 const usableWidth=Math.max(1,viewport.width-viewport.left-viewport.right-12);
 const usableHeight=Math.max(1,viewport.height-viewport.top-viewport.bottom-12);
 const width=Math.max(1,Math.round((fitMode==="width"?usableWidth:Math.min(usableWidth,usableHeight/ratio))*zoom));
 const offsets=useMemo(()=>{
  const values=[0];
  for(let page=1;page<=pages;page++)values.push(values[page-1]+Math.max(1,Math.round(width*(ratios[page]??ratio)))+GAP);
  return values;
 },[pages,width,ratios,ratio]);
 useLayoutEffect(()=>{
  const node=stage.current;if(!node)return;
  const measure=()=>{
   const style=getComputedStyle(node);
   const next={width:node.clientWidth,height:node.clientHeight,
    left:parseFloat(style.paddingLeft)||0,right:parseFloat(style.paddingRight)||0,
    top:parseFloat(style.paddingTop)||0,bottom:parseFloat(style.paddingBottom)||0};
   setViewport(old=>Object.keys(next).every(k=>old[k as keyof Viewport]===next[k as keyof Viewport])?old:next);
  };
  measure();
  const observer=new ResizeObserver(measure);observer.observe(node);
  return()=>observer.disconnect();
 },[]);
 function sync(){
  const node=stage.current;if(!node||!pages||!viewport.height)return;
  const top=Math.max(0,node.scrollTop-viewport.top);
  const first=Math.max(0,pageAt(offsets,Math.max(0,top-viewport.height))-1);
  const last=Math.min(pages-1,pageAt(offsets,top+viewport.height*2)+1);
  setWindow(old=>old.first===first&&old.last===last?old:{first,last});
  const current=pageAt(offsets,top+viewport.height*.3)+1;
  setActive(old=>old===current?old:current);
 }
 useLayoutEffect(()=>{
  const node=stage.current,old=previous.current;
  if(!node||!pages)return;
  if(old&&old.width>1&&viewport.height){
   const anchor=Math.max(0,node.scrollTop-viewport.top+viewport.height*.3);
   const index=Math.min(pages-1,pageAt(old.offsets,anchor));
   const progress=Math.max(0,Math.min(1,(anchor-old.offsets[index])/Math.max(1,old.offsets[index+1]-old.offsets[index])));
   node.scrollTop=Math.max(0,viewport.top+offsets[index]+progress*(offsets[index+1]-offsets[index])-viewport.height*.3);
  }
  previous.current={offsets,width};sync();
 },[offsets,width,viewport.height,viewport.top,pages]);
 useEffect(()=>()=>{if(frame.current!==null)cancelAnimationFrame(frame.current);},[]);
 useEffect(()=>{onPageChange?.(active);},[active,onPageChange]);
 function onScroll(){
  if(frame.current!==null)return;
  frame.current=requestAnimationFrame(()=>{frame.current=null;sync();});
 }
 function goToPage(page:number){
  const node=stage.current;if(!node||!pages)return;
  const target=Math.max(1,Math.min(pages,Math.round(page)));
  node.scrollTop=viewport.top+offsets[target-1];
  setActive(target);setWindow({first:Math.max(0,target-2),last:Math.min(pages-1,target+1)});
 }
 useImperativeHandle(ref,()=>({goToPage}));
 function pointerDown(e:PointerEvent<HTMLDivElement>){
  const node=stage.current;if(!panMode||e.button!==0||!node)return;
  drag.current={x:e.clientX,y:e.clientY,left:node.scrollLeft,top:node.scrollTop};
  node.setPointerCapture(e.pointerId);e.preventDefault();
 }
 function pointerMove(e:PointerEvent<HTMLDivElement>){
  const node=stage.current,d=drag.current;if(!node||!d)return;
  node.scrollLeft=d.left-(e.clientX-d.x);node.scrollTop=d.top-(e.clientY-d.y);
 }
 function pointerEnd(e:PointerEvent<HTMLDivElement>){
  drag.current=null;const node=stage.current;if(node?.hasPointerCapture(e.pointerId))node.releasePointerCapture(e.pointerId);
 }
 const first=Math.min(pages-1,Math.max(0,window.first)),last=Math.min(pages-1,Math.max(first,window.last));
 const items=[];
 for(let i=first;i<=last;i++){
  const number=i+1,status=loaded[number];
  items.push(<div key={number} className="continuous-page" data-page={number}
   style={{width:width+"px",height:Math.max(1,offsets[i+1]-offsets[i]-GAP)+"px"}}>
   {status!=="ready"&&<div className="continuous-page-placeholder" role="status">
    {status==="failed"?<><span>第 {number} 页加载失败</span><RareButton type="button" onClick={()=>{
     setRetry(old=>({...old,[number]:(old[number]??0)+1}));
     setLoaded(old=>{const next={...old};delete next[number];return next;});
    }}>重试此页</RareButton></>:<>{number===active&&<BrandLoader size="sm" decorative/>}<span>第 {number} 页</span></>}
   </div>}
   {status!=="failed"&&<img key={number+":"+(retry[number]??0)}
    src={pageUrl(number,retry[number]??0)} alt={imageLabel?.(number)??("第 "+number+" 页")}
    loading={Math.abs(number-active)<=1?"eager":"lazy"} decoding="async"
    style={{width:"100%",height:"100%",visibility:status==="ready"?"visible":"hidden"}}
    onLoad={event=>{
     const img=event.currentTarget;if(!img.naturalWidth||!img.naturalHeight)return;
     const value=img.naturalHeight/img.naturalWidth;
     setRatios(old=>Math.abs((old[number]??DEFAULT_RATIO)-value)<.001?old:{...old,[number]:value});
     setLoaded(old=>old[number]==="ready"?old:{...old,[number]:"ready"});
    }} onError={()=>setLoaded(old=>old[number]==="failed"?old:{...old,[number]:"failed"})}/>}
  </div>);
 }
 return <div ref={stage} className={className+" continuous-page-viewport"+(panMode?" is-panning":"")}
  role="region" aria-label={label} tabIndex={0} onScroll={onScroll}
  onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd}
  style={{touchAction:panMode?"none":"auto"}}>
  <div className="continuous-page-stack">
   <div aria-hidden="true" style={{height:offsets[first]}}/>
   {items}
   <div aria-hidden="true" style={{height:Math.max(0,offsets[pages]-offsets[last+1])}}/>
  </div>
 </div>;
});
