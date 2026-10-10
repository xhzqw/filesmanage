import {Children,forwardRef,isValidElement,useEffect,useId,useMemo,useRef,useState,type ChangeEvent,type FocusEvent as ReactFocusEvent,type ReactNode,type SelectHTMLAttributes,type KeyboardEvent as ReactKeyboardEvent} from "react";
import {createPortal} from "react-dom";

type Choice={value:string;label:ReactNode;search:string;disabled:boolean};
type RareSelectProps=SelectHTMLAttributes<HTMLSelectElement>&{searchable?:boolean};

// Owned listbox: styling a native <select> cannot style its OS popup.
// Keep a non-focusable select for forms/ref compatibility; use a portaled
// keyboard-operable listbox so overflow panels do not clip the menu.
export const RareSelect=forwardRef<HTMLSelectElement,RareSelectProps>(function RareSelect(
 {className="",children,value,defaultValue,onChange,disabled,required,id,name,style,onBlur,onFocus,searchable:enableSearch,...rest},ref){
 const uid=useId(),buttonId=id??uid,menuId=uid+"-menu";
 const button=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null);
 const searchRef=useRef<HTMLInputElement>(null);
 const [open,setOpen]=useState(false),[query,setQuery]=useState("");
 const [ownValue,setOwnValue]=useState(String(defaultValue??""));
 const [active,setActive]=useState(0);
 const [position,setPosition]=useState({top:0,left:0,width:200,maxHeight:240});
 const options=useMemo(()=>Children.toArray(children).filter(isValidElement).filter(o=>o.type==="option").map(o=>{
  const props=o.props as {value?:string|number;children?:ReactNode;disabled?:boolean};
  return {value:String(props.value??""),label:props.children,search:String(props.children??""),disabled:!!props.disabled};
 }),[children]);
 const selected=String(value??ownValue);
 const current=options.find(o=>o.value===selected);
 const searchable=enableSearch??options.length>10;
 const visible=options.filter(o=>o.search.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
 function positionMenu(){
  const rect=button.current?.getBoundingClientRect();if(!rect)return;
  const modal=button.current?.closest("dialog[open]");
  const bounds=modal?.getBoundingClientRect();
  const topEdge=bounds?bounds.top+8:8;
  const bottomEdge=bounds?bounds.bottom-8:window.innerHeight-8;
  const leftEdge=bounds?bounds.left+8:8;
  const rightEdge=bounds?bounds.right-8:window.innerWidth-8;
  const below=Math.max(0,bottomEdge-rect.bottom-5);
  const aboveSpace=Math.max(0,rect.top-topEdge-5);
  const above=below<150&&aboveSpace>below;
  const maxHeight=Math.min(240,above?aboveSpace:below);
  const width=Math.min(Math.max(200,rect.width),rightEdge-leftEdge);
  setPosition({top:above?rect.top-maxHeight-5:rect.bottom+5,
   left:Math.max(leftEdge,Math.min(rect.left,rightEdge-width)),width,maxHeight:Math.max(0,maxHeight)});
 }
 function show(){if(disabled)return;setQuery("");setActive(Math.max(0,options.findIndex(o=>o.value===selected)));positionMenu();setOpen(true);}
 function close(focus=false){setOpen(false);setQuery("");if(focus)button.current?.focus();}
 function choose(next:string){
  if(value===undefined)setOwnValue(next);
  if(next!==selected)onChange?.({target:{value:next},currentTarget:{value:next}} as ChangeEvent<HTMLSelectElement>);
  close(true);
 }
 useEffect(()=>{
  if(!open)return;
  const outside=(event:PointerEvent)=>{const t=event.target as Node;if(!menu.current?.contains(t)&&!button.current?.contains(t))close();};
  const esc=(event:KeyboardEvent)=>{if(event.key==="Escape"){event.preventDefault();close(true);}};
  document.addEventListener("pointerdown",outside);document.addEventListener("keydown",esc);
  window.addEventListener("resize",positionMenu);window.addEventListener("scroll",positionMenu,true);
  return()=>{document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",esc);
   window.removeEventListener("resize",positionMenu);window.removeEventListener("scroll",positionMenu,true);};
 },[open]);
 useEffect(()=>{if(open&&searchable)searchRef.current?.focus();},[open,searchable]);
 function onKeyDown(event:ReactKeyboardEvent){
  if(disabled)return;
  if(event.key==="ArrowDown"||event.key==="ArrowUp"){
   event.preventDefault();if(!open){show();return;}
   const step=event.key==="ArrowDown"?1:-1;let index=active;
   for(let i=0;i<visible.length;i++){index=(index+step+visible.length)%visible.length;
    if(!visible[index]?.disabled){setActive(index);break;}}
  }else if(event.key==="Home"&&open){event.preventDefault();setActive(0);}
  else if(event.key==="End"&&open){event.preventDefault();setActive(Math.max(0,visible.length-1));}
  else if(event.key==="Enter"||(event.key===" "&&!searchable)){
   event.preventDefault();if(!open){show();return;}
   const candidate=visible[active];if(candidate&&!candidate.disabled)choose(candidate.value);
  }else if(event.key==="Escape"&&open){event.preventDefault();close(true);}
 }
 return <span className="rare-select-root" style={style}>
  <select {...rest} ref={ref} name={name} value={selected} tabIndex={-1} aria-hidden="true"
   className="rare-select-native" onChange={onChange}>{children}</select>
  <button id={buttonId} ref={button} type="button" disabled={disabled}
   className={"rare-select"+(className?" "+className:"")} data-rare-control="select"
   aria-label={rest["aria-label"]??undefined} aria-haspopup="listbox" aria-expanded={open}
   aria-controls={open?menuId:undefined} aria-required={required||undefined}
   onClick={()=>open?close():show()} onKeyDown={onKeyDown}
   onBlur={e=>onBlur?.(e as unknown as ReactFocusEvent<HTMLSelectElement>)}
   onFocus={e=>onFocus?.(e as unknown as ReactFocusEvent<HTMLSelectElement>)}>
   <span className={"rare-select-label"+(!selected?" placeholder":"")}>{current?.label??"请选择"}</span>
   <svg className="rare-select-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m5 7 5 5 5-5"/></svg>
  </button>
  {open&&createPortal(<div ref={menu} id={menuId} className="rare-select-menu" role="listbox"
   aria-label={rest["aria-label"]??"选项"} onKeyDown={onKeyDown}
   style={{top:position.top,left:position.left,width:position.width,maxHeight:position.maxHeight}}>
   {searchable&&<div className="rare-select-search"><input ref={searchRef} aria-label="搜索选项"
    type="search" value={query} placeholder="搜索选项…" onChange={e=>{setQuery(e.target.value);setActive(0);}}/></div>}
   <div className="rare-select-options">
    {visible.map((item,index)=><button type="button" key={item.value} role="option" disabled={item.disabled}
     aria-selected={selected===item.value} className={"rare-select-option"+(active===index?" highlighted":"")}
     onMouseEnter={()=>setActive(index)} onClick={()=>choose(item.value)}>
     <span>{item.label}</span>{selected===item.value&&<span aria-hidden="true">✓</span>}
    </button>)}
    {!visible.length&&<p className="rare-select-empty">没有匹配项</p>}
   </div>
  </div>,button.current?.closest('dialog[open]')??document.body)}
 </span>;
});
RareSelect.displayName="RareSelect";
