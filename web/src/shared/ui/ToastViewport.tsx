import {useEffect,useRef,useState} from "react";
import {createPortal} from "react-dom";
import {AnimatePresence,motion,useReducedMotion} from "motion/react";
import {RareButton} from "./rare";
import {toast,useToastStore,type ToastItem} from "./feedback";
import "./toast.css";

function ToastRow({item}:{item:ToastItem}){
 const reduced=useReducedMotion();
 const[paused,setPaused]=useState(false);
 const[hidden,setHidden]=useState(()=>document.hidden);
 const remaining=useRef(item.duration);
 const timerIdentity=useRef({id:item.id,revision:item.revision});
 useEffect(()=>{
  const sync=()=>setHidden(document.hidden);
  document.addEventListener("visibilitychange",sync);
  return()=>document.removeEventListener("visibilitychange",sync);
 },[]);
 useEffect(()=>{
  if(timerIdentity.current.id!==item.id||timerIdentity.current.revision!==item.revision){
   timerIdentity.current={id:item.id,revision:item.revision};
   remaining.current=item.duration;
  }
  if(!item.duration||paused||hidden)return;
  const start=Date.now();
  const handle=window.setTimeout(()=>toast.dismiss(item.id),remaining.current);
  return()=>{window.clearTimeout(handle);remaining.current=Math.max(0,remaining.current-(Date.now()-start));};
 },[item.id,item.duration,item.revision,paused,hidden]);
 return <motion.div layout className="rare-toast" data-toast-tone={item.tone}
  initial={reduced?false:{opacity:0,y:-8,scale:.97}}
  animate={{opacity:1,y:0,scale:1}}
  exit={reduced?{opacity:0}:{opacity:0,x:14,scale:.98}}
  transition={reduced?{duration:0}:{duration:.21,ease:[.2,.8,.2,1]}}
  role={item.tone==="danger"?"alert":"status"}
  onMouseEnter={()=>setPaused(true)} onMouseLeave={()=>setPaused(false)}
  onFocusCapture={()=>setPaused(true)} onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget))setPaused(false);}}>
  <span className="rare-toast-mark" aria-hidden="true">
   {item.tone==="success"?<svg viewBox="0 0 20 20"><path d="m4 10 4 4 8-8"/></svg>:
    item.tone==="danger"?<svg viewBox="0 0 20 20"><path d="M10 5v6m0 3v1M10 2l8 15H2L10 2Z"/></svg>:
    item.tone==="loading"?<span className="rare-toast-spinner"/>:
    item.tone==="warning"?<svg viewBox="0 0 20 20"><path d="M10 5v6m0 3v1M10 2l8 15H2L10 2Z"/></svg>:
    <svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8"/><path d="M10 9v5m0-8v1"/></svg>}
  </span>
  <span className="rare-toast-text">{item.text}</span>
  <RareButton type="button" tone="ghost" className="rare-toast-close" aria-label="关闭通知" onClick={()=>toast.dismiss(item.id)}>
   <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>
  </RareButton>
 </motion.div>;
}
export function ToastViewport(){
 const items=useToastStore(state=>state.items);
 const[modal,setModal]=useState<HTMLDialogElement|null>(null);
 useEffect(()=>{
  const update=()=>{
   const dialogs=Array.from(document.querySelectorAll<HTMLDialogElement>("dialog:modal"));
   const active=dialogs[dialogs.length-1]??null;
   setModal(old=>old===active?old:active);
  };
  update();
  const observer=new MutationObserver(update);
  observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:["open"]});
  return()=>observer.disconnect();
 },[]);
 const viewport=<aside className="rare-toast-viewport" aria-label="操作通知">
  <AnimatePresence initial={false}>
   {items.map(item=><ToastRow key={item.id} item={item}/>)}
  </AnimatePresence>
 </aside>;
 // showModal() moves a dialog into the browser top layer. No sibling z-index
 // can beat that layer; render notifications inside the active modal.
 return modal?createPortal(viewport,modal):viewport;
}
