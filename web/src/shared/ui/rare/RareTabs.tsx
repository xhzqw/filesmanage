import {useLayoutEffect,useRef,useState,type KeyboardEvent,type ReactNode} from "react";
import {motion,useReducedMotion} from "motion/react";
import "./controls.css";

// WAI-ARIA Tabs keyboard contract; styling is owned by the host layout.
// Works with native RareButton tabs without duplicating business state.
export function RareTabs({className="",label,children}:{
  className?:string;label:string;children:ReactNode;
}){
  const tablistRef=useRef<HTMLDivElement>(null);
  const reduce=useReducedMotion();
  const [activeRail,setActiveRail]=useState<{left:number;width:number}|null>(null);
  useLayoutEffect(()=>{
    const root=tablistRef.current;
    if(!root)return;
    const update=()=>{
      const selected=root.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if(!selected){setActiveRail(null);return;}
      const container=root.getBoundingClientRect();
      const element=selected.getBoundingClientRect();
      const left=element.left-container.left+root.scrollLeft;
      const width=element.width;
      setActiveRail(previous=>previous&&Math.abs(previous.left-left)<.5&&Math.abs(previous.width-width)<.5?previous:{left,width});
    };
    update();
    const resize=typeof ResizeObserver==="undefined"?null:new ResizeObserver(update);
    resize?.observe(root);
    const tabs=Array.from(root.querySelectorAll('[role="tab"]'));
    tabs.forEach(tab=>resize?.observe(tab));
    // Watch semantic selection changes rather than re-measuring on each React commit.
    // A layout effect that sets rail state after every render can loop forever when
    // tab badges change geometry during organization filtering.
    const observer=typeof MutationObserver==="undefined"?null:new MutationObserver(update);
    observer?.observe(root,{subtree:true,attributes:true,attributeFilter:["aria-selected"]});
    root.addEventListener("scroll",update,{passive:true});
    return()=>{resize?.disconnect();observer?.disconnect();root.removeEventListener("scroll",update);};
  },[]);
  function onKeyDown(event:KeyboardEvent<HTMLDivElement>){
    if(!["ArrowRight","ArrowLeft","Home","End"].includes(event.key))return;
    const tabs=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'));
    if(!tabs.length)return;
    const current=tabs.indexOf(document.activeElement as HTMLButtonElement);
    if(current<0)return;
    event.preventDefault();
    let next=current;
    if(event.key==="Home")next=0;
    else if(event.key==="End")next=tabs.length-1;
    else next=(current+(event.key==="ArrowRight"?1:-1)+tabs.length)%tabs.length;
    tabs[next]?.focus();
    tabs[next]?.click();
  }
  return <div ref={tablistRef} role="tablist" aria-label={label} data-rare-tabs="" className={"rare-tabs"+(className?" "+className:"")} onKeyDown={onKeyDown}>
    {children}
    {activeRail&&<motion.span aria-hidden="true" className="rare-tab-active-rail" initial={false}
      animate={{left:activeRail.left,width:activeRail.width}}
      transition={reduce?{duration:0}:{type:"spring",stiffness:480,damping:36}}/>}
  </div>;
}
