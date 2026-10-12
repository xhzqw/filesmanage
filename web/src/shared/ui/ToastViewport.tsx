import {useEffect,useState} from "react";
import {RareButton} from "./rare";
import {toast,useToastStore,type ToastItem} from "./feedback";
import "./toast.css";

function ToastRow({item}:{item:ToastItem}){
 const[paused,setPaused]=useState(false);
 useEffect(()=>{
  if(!item.duration||paused)return;
  const handle=window.setTimeout(()=>toast.dismiss(item.id),item.duration);
  return()=>window.clearTimeout(handle);
 },[item.id,item.duration,paused]);
 return <div className="rare-toast" data-toast-tone={item.tone}
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
 </div>;
}
export function ToastViewport(){
 const items=useToastStore(state=>state.items);
 if(!items.length)return null;
 return <aside className="rare-toast-viewport" aria-label="操作通知">
  {items.map(item=><ToastRow key={item.id} item={item}/>)}
 </aside>;
}
