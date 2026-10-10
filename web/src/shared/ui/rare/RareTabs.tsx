import {type KeyboardEvent,type ReactNode} from "react";
import "./controls.css";

// WAI-ARIA Tabs keyboard contract; styling is owned by the host layout.
// Works with native RareButton tabs without duplicating business state.
export function RareTabs({className="",label,children}:{
  className?:string;label:string;children:ReactNode;
}){
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
  return <div role="tablist" aria-label={label} data-rare-tabs="" className={"rare-tabs"+(className?" "+className:"")} onKeyDown={onKeyDown}>{children}</div>;
}
