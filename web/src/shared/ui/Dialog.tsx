import {useEffect,useId,useRef,type ReactNode,type KeyboardEvent}from "react";

// Real modal dialog primitive (DESIGN-SYSTEM-v1 §4.2 / DESKTOP-INTERACTION §4.1).
// Built on the native <dialog>.showModal() top layer: the background is inert,
// Tab cycles inside the dialog, Escape fires `cancel` and the host decides
// whether closing is allowed, and focus returns to the trigger on close.
// The declarative `open` attribute is deliberately not used — it renders a
// non-modal popup, not a modal.
export function Dialog({open,title,onClose,closeGuard,initialFocus,className,children}:{
 open:boolean;
 title:string;
 onClose:()=>void;
 // Returning false keeps the dialog open (in-flight submit, unsaved edits).
 closeGuard?:()=>boolean;
 // CSS selector for the element that receives focus when the dialog opens.
 initialFocus?:string;
 className?:string;
 children:ReactNode;
}){
 const node=useRef<HTMLDialogElement>(null);
 const trigger=useRef<HTMLElement|null>(null);
 const titleId=useId();
 // React state mirror: a dialog unmounted while open is already closed by the
 // DOM removal, so the native `open` flag cannot drive the focus restore.
 const shown=useRef(false);

 useEffect(()=>{
  const dialog=node.current;
  if(!dialog)return;
  shown.current=open;
  if(open){
   if(!dialog.open){
    const active=document.activeElement;
    trigger.current=active instanceof HTMLElement&&!dialog.contains(active)?active:null;
    dialog.showModal();
   }
   const target=initialFocus?dialog.querySelector<HTMLElement>(initialFocus):firstFocusable(dialog);
   (target??dialog).focus();
   return;
  }
  if(dialog.open)dialog.close();
  restoreFocus();
 },[open,initialFocus]);

 // Unmounting an open dialog (route change, parent condition) must not leave
 // the native top-layer element behind, and focus still returns to the
 // trigger when it survives.
 useEffect(()=>()=>{
  const dialog=node.current;
  if(dialog?.open)dialog.close();
  if(shown.current)restoreFocus();
 },[]);

 useEffect(()=>{
  const dialog=node.current;
  if(!dialog||!open)return;
  function onCancel(event:Event){
   event.preventDefault();
   if(closeGuard&&!closeGuard())return;
   onClose();
  }
  dialog.addEventListener("cancel",onCancel);
  return()=>dialog.removeEventListener("cancel",onCancel);
 },[open,onClose,closeGuard]);

 // If the trigger is gone, keep keyboard focus inside the page instead of
 // dropping it to <body>.
 function restoreFocus(){
  const previous=trigger.current;
  trigger.current=null;
  if(previous&&previous.isConnected)previous.focus();
 }

 function onDialogKeyDown(event:KeyboardEvent<HTMLDialogElement>){
  if(event.key!=="Tab")return;
  // Browsers may move focus to the document when a modal contains only one
  // tabbable element. Explicit boundaries also handle hidden/disabled fields.
  const dialog=node.current;
  if(!dialog)return;
  const candidates=Array.from(dialog.querySelectorAll<HTMLElement>(
   'input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])'
  )).filter(el=>el.tabIndex>=0&&el.getClientRects().length>0);
  if(!candidates.length){event.preventDefault();dialog.focus();return;}
  const first=candidates[0]!;
  const last=candidates[candidates.length-1]!;
  if(event.shiftKey&&(document.activeElement===first||!dialog.contains(document.activeElement))){
   event.preventDefault();last.focus();return;
  }
  if(!event.shiftKey&&(document.activeElement===last||!dialog.contains(document.activeElement))){
   event.preventDefault();first.focus();
  }
 }

 return <dialog ref={node} className={"dialog "+(className??"")} aria-labelledby={titleId}
  onKeyDown={onDialogKeyDown} tabIndex={-1}>
  <h2 id={titleId} className="dialog-title">{title}</h2>
  {children}
 </dialog>;
}

function firstFocusable(root:HTMLElement):HTMLElement|null{
 const candidates=root.querySelectorAll<HTMLElement>("input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled]),[href],[tabindex]:not([tabindex='-1'])");
 for(const candidate of candidates){
  if(candidate.tabIndex>=0)return candidate;
 }
 return null;
}
