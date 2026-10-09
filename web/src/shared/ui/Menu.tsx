import {useEffect,useLayoutEffect,useRef,useState,type KeyboardEvent}from "react";
import "./menu.css";

export type MenuItem={
 id:string;
 label:string;
 onSelect:()=>void;
 disabled?:boolean;
 danger?:boolean;
 hint?:string;
};

export type MenuPoint={x:number;y:number};

// Non-modal context-menu primitive (DESIGN-SYSTEM-v1 §4.2 Menu contract,
// DESKTOP-INTERACTION-v1 §3.3/§4): opened by right-click or Shift+F10, it is
// deliberately NOT a native <dialog> — the page behind stays interactive.
// Focus moves into the menu on open and back to the anchor on close, Tab and
// Escape close instead of leaking focus into the page, and an action the
// current user may not perform never reaches the item list because the host
// computes it.
export function Menu({open,onClose,items,anchor,label,point}:{
 open:boolean;
 onClose:()=>void;
 items:MenuItem[];
 anchor?:HTMLElement|null;
 label:string;
 // Pointer coordinates of the triggering contextmenu event; a keyboard-opened
 // menu (Shift+F10 / Menu key) passes none and is placed under the anchor.
 point?:MenuPoint|null;
}){
 const node=useRef<HTMLDivElement>(null);
 const[position,setPosition]=useState<MenuPoint|null>(null);
 const entered=useRef(false);

 // Focus enters on open, skipping disabled entries; a host re-render while
 // the menu is open must not yank focus back to the first item.
 useLayoutEffect(()=>{
  if(!open){entered.current=false;return;}
  if(entered.current)return;
  const menu=node.current;
  if(!menu)return;
  const first=enabledItems(menu)[0];
  (first??menu).focus();
  entered.current=true;
 },[open]);

 // Measured once per opening and clamped into the viewport. The pre-measure
 // render is transparent rather than display:none so focus() still lands.
 useLayoutEffect(()=>{
  if(!open){setPosition(null);return;}
  const menu=node.current;
  if(!menu)return;
  const margin=8;
  let left=point?point.x:margin;
  let top=point?point.y:margin;
  if(!point&&anchor){
   const rect=anchor.getBoundingClientRect();
   left=rect.left;
   top=rect.bottom+4;
  }
  setPosition({
   left:Math.max(margin,Math.min(left,window.innerWidth-menu.offsetWidth-margin)),
   top:Math.max(margin,Math.min(top,window.innerHeight-menu.offsetHeight-margin)),
  });
 },[open,point,anchor]);

 // A non-modal menu is dismissed by an outside pointer, a viewport resize or
 // any scroll; capture phase so the close runs before the next contextmenu.
 useEffect(()=>{
  if(!open)return;
  function onPointerDown(event:PointerEvent){
   const menu=node.current;
   if(menu&&event.target instanceof Node&&menu.contains(event.target))return;
   // Restore focus only while the menu still holds it, so a click landing on
   // another control keeps that control as the focus target.
   const hadFocus=menu!==null&&menu.contains(document.activeElement);
   onClose();
   if(hadFocus)focusAnchor();
  }
  function onViewportChange(){onClose();}
  document.addEventListener("pointerdown",onPointerDown,true);
  window.addEventListener("resize",onViewportChange);
  document.addEventListener("scroll",onViewportChange,true);
  return()=>{
   document.removeEventListener("pointerdown",onPointerDown,true);
   window.removeEventListener("resize",onViewportChange);
   document.removeEventListener("scroll",onViewportChange,true);
  };
 },[open,onClose]);

 function focusAnchor(){
  if(anchor&&anchor.isConnected)anchor.focus();
 }

 function closeMenu(restoreFocus:boolean){
  // Restore before the host reaction: an action that opens a dialog then
  // captures the anchor as its trigger, exactly like the Dialog primitive.
  if(restoreFocus)focusAnchor();
  onClose();
 }

 function onItemSelect(item:MenuItem){
  if(item.disabled)return;
  closeMenu(true);
  item.onSelect();
 }

 function onKeyDown(event:KeyboardEvent<HTMLDivElement>){
  switch(event.key){
   case "ArrowDown":
    event.preventDefault();moveFocus(1);break;
   case "ArrowUp":
    event.preventDefault();moveFocus(-1);break;
   case "Home":
    event.preventDefault();focusEdge(true);break;
   case "End":
    event.preventDefault();focusEdge(false);break;
   case "Escape":
   case "Tab":
    // Tab must never leak focus into the page behind a non-modal menu.
    event.preventDefault();closeMenu(true);break;
  }
 }

 function moveFocus(delta:number){
  const list=enabledItems(node.current);
  if(list.length===0)return;
  const current=list.findIndex(button=>button===document.activeElement);
  const target=list[(current+delta+list.length)%list.length];
  target?.focus();
 }

 function focusEdge(first:boolean){
  const list=enabledItems(node.current);
  const target=first?list[0]:list[list.length-1];
  target?.focus();
 }

 if(!open)return null;
 return <div ref={node} className="menu" role="menu" aria-label={label} aria-orientation="vertical"
  tabIndex={-1}
  style={{left:position?position.left:0,top:position?position.top:0,opacity:position?1:0}}
  onKeyDown={onKeyDown}
  onContextMenu={event=>event.preventDefault()}>
  {items.map(item=><button key={item.id} type="button" role="menuitem"
   className={"menu-item"+(item.danger?" danger":"")}
   disabled={item.disabled}
   aria-disabled={item.disabled?true:undefined}
   tabIndex={-1}
   onClick={()=>onItemSelect(item)}>
   <span className="menu-label">{item.label}</span>
   {item.hint&&<span className="menu-hint">{item.hint}</span>}
  </button>)}
 </div>;
}

function enabledItems(root:HTMLElement|null):HTMLButtonElement[]{
 if(!root)return[];
 return Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).filter(button=>!button.disabled);
}
