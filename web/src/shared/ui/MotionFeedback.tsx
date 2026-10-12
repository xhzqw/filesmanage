import {useEffect} from "react";

/** Shared, delegated press effect. Never re-renders a file row or button. */
export function MotionFeedback(){
 useEffect(()=>{
  const reduced=window.matchMedia("(prefers-reduced-motion: reduce)");
  function onPointerDown(event:PointerEvent){
   if(reduced.matches||document.hidden||!event.isPrimary||event.button!==0)return;
   if(!(event.target instanceof Element))return;
   const button=event.target.closest<HTMLButtonElement>(
    '[data-rare-control="button"], .toolbar button, .folder-actions button, .tree-row button'
   );
   if(!button||button.disabled||button.getAttribute("aria-disabled")==="true"||button.getAttribute("aria-busy")==="true")return;
   // Let office, CAD and resize/pan gestures keep sole ownership of their DOM.
   if(button.closest(".viewer-stage, .office-holder, [data-motion-ripple='off']"))return;
   const bounds=button.getBoundingClientRect();
   if(!bounds.width||!bounds.height||bounds.width>420)return;
   const diameter=Math.min(440,Math.max(bounds.width,bounds.height)*2);
   const wave=document.createElement("span");
   wave.className="fm-click-wave";
   wave.setAttribute("aria-hidden","true");
   wave.style.width=wave.style.height=diameter+"px";
   wave.style.left=event.clientX-bounds.left-diameter/2+"px";
   wave.style.top=event.clientY-bounds.top-diameter/2+"px";
   button.appendChild(wave);
   if(typeof wave.animate!=="function"){wave.remove();return;}
   const animation=wave.animate([
    {transform:"scale(.08)",opacity:.24},
    {transform:"scale(1)",opacity:0}
   ],{duration:420,easing:"cubic-bezier(.2,.8,.2,1)"});
   animation.addEventListener("finish",()=>wave.remove(),{once:true});
   animation.addEventListener("cancel",()=>wave.remove(),{once:true});
  }
  document.addEventListener("pointerdown",onPointerDown,{passive:true});
  return()=>document.removeEventListener("pointerdown",onPointerDown);
 },[]);
 return null;
}
