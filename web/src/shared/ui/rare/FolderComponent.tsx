/* Direct visual adaptation of Rare UI FolderComponent, blue theme.
 * Source: https://github.com/swamimalode07/rare-ui/blob/main/components/ui/folder-component.tsx
 * Design: https://www.rareui.com/components/foldercomponent
 * Rare UI's MIT + Commons Clause attribution is retained in README.md.
 *
 * The original 321 × 270 stage, paper-card SVG and glass flap are preserved.
 * Only host sizing and passive folder-list behavior are adapted. There is no
 * competing onClick: selection, double-open and dragging belong to the row.
 */
import {useId,useState} from "react";
import {motion,useReducedMotion} from "motion/react";
import "./folderComponent.css";

type Props={open?:boolean;size?:number;className?:string};
const W=321,H=270;
const FLAP="M0 25C0 11.1929 11.1929 0 25 0H136.084C143.044 0 149.689 2.90139 154.42 8.00608L178.08 33.5343C182.811 38.639 189.456 41.5404 196.416 41.5404H296C309.807 41.5404 321 52.7333 321 66.5404V216C321 229.807 309.807 241 296 241H25C11.1929 241 0 229.807 0 216V25Z";
const FLAP_OUTLINE="M25 0.5H136.084C142.905 0.5 149.417 3.3431 154.054 8.3457L177.713 33.874C182.539 39.0808 189.317 42.04 196.416 42.04H296C309.531 42.04 320.5 53.0092 320.5 66.54V216C320.5 229.531 309.531 240.5 296 240.5H25C11.469 240.5 0.5 229.531 0.5 216V25C0.5 11.469 11.469 0.5 25 0.5Z";
const SPRING={type:"spring" as const,stiffness:120,damping:13};

function PaperCard({filterId}:{filterId:string}){
 return <svg data-slot="folder-card" width="164" height="214" viewBox="0 0 164 214" fill="none" aria-hidden="true">
  <g filter={`url(#${filterId})`}><rect width="163.078" height="213.262" rx="20" fill="#F1F1F1"/></g>
  <rect x=".5" y=".5" width="162.078" height="212.262" rx="19.5" stroke="#E0E0E0"/>
  <rect x="14.1193" y="31.2091" width="134.84" height="11.8892" rx="5.94459" fill="#D4D4D4"/>
  <rect x="14.8253" y="60.9939" width="64.5183" height="5.88276" rx="2.94" fill="#D4D4D4"/>
  <rect x="84.4303" y="60.9617" width="64.5183" height="5.88276" rx="2.94" fill="#D4D4D4"/>
  <rect x="14.8253" y="75.1122" width="64.5183" height="5.88276" rx="2.94" fill="#D4D4D4"/>
  <rect x="84.4303" y="75.0801" width="64.5183" height="5.88276" rx="2.94" fill="#D4D4D4"/>
  <rect x="14.8253" y="89.2306" width="64.5183" height="5.88276" rx="2.94" fill="#D4D4D4"/>
  <rect x="84.4303" y="89.199" width="64.5183" height="5.88276" rx="2.94" fill="#D4D4D4"/>
  {Array.from({length:5},(_,line)=><g key={line} transform={`translate(0 ${106+line*14.1})`}>
   <rect x="14.8253" width="64.5183" height="5.88276" rx="2.94" fill="#D4D4D4"/>
   <rect x="84.4303" width="64.5183" height="5.88276" rx="2.94" fill="#D4D4D4"/>
  </g>)}
  <defs><filter id={filterId} x="-7" y="-7" width="177" height="227" filterUnits="userSpaceOnUse">
   <feGaussianBlur in="SourceAlpha" stdDeviation="2"/>
   <feOffset dy="1"/><feComponentTransfer><feFuncA type="linear" slope=".13"/></feComponentTransfer>
   <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter></defs>
 </svg>;
}

export function RareFolderComponent({open=false,size=16,className=""}:Props){
 const [hover,setHover]=useState(false);
 const reducedMotion=useReducedMotion();
 const uid=useId().replace(/:/g,"");
 // Upstream has THREE states, not two. Hover presents the shallow glass flap
 // and subtly fanned cards shown in RareUI's demo; clicked/open is a separate
 // deeper fan-out. Never map hover onto the clicked-open animation.
 const hovered=hover&&size>=32;
 const active=open||hovered;
 const paperStates=[
  {x:open?70:40,y:open?-160:hovered?-30:-10,rotate:open?18:hovered?14:10,delay:open?.1:hovered?.12:0},
  {x:open?0:3,y:open?-180:hovered?-35:-20,rotate:open?-3:hovered?-1:2,delay:open?.05:hovered?.06:0},
  {x:open?-65:-40,y:open?-170:hovered?-44:-22,rotate:open?-14:hovered?-9:-5,delay:0}
 ];
 return <span
  data-slot="rare-folder-component" data-folder-open={active?"true":"false"}
  data-folder-scale={size<32?"compact":"large"}
  className={"resource-folder-icon rare-folder-component"+(className?" "+className:"")}
  style={{width:size,height:size}}
  onMouseEnter={()=>{if(size>=32)setHover(true);}}
  onMouseLeave={()=>setHover(false)} aria-hidden="true">
  <span className="rare-folder-stage" style={{width:W,height:H,transform:`translate(-50%,-50%) scale(${size/W})`}}>
   <span className="rare-folder-back"/>
   <span className="rare-folder-papers">
    {paperStates.map((paper,index)=><motion.span
     key={index} className={"rare-folder-card rare-folder-card-"+(index+1)}
     animate={{x:paper.x,y:paper.y,rotate:paper.rotate}}
     transition={reducedMotion?{duration:0}:{...SPRING,delay:paper.delay}}>
     <PaperCard filterId={uid+"-card-"+index}/>
    </motion.span>)}
   </span>
   <motion.span className="rare-folder-front"
    animate={{rotateX:open?-55:hovered?-45:-15}}
    transition={reducedMotion?{duration:0}:{type:"spring",stiffness:120,damping:14}}>
    <span className="rare-folder-glass" style={{clipPath:`path('${FLAP}')`}}/>
    <svg width="321" height="241" viewBox="0 0 321 241" fill="none" aria-hidden="true">
     <g filter={`url(#${uid}-front)`}>
      <path d={FLAP} fill="#3A9AE8" fillOpacity=".45"/>
      <path d={FLAP_OUTLINE} stroke="#7EC8FF"/>
     </g>
     <defs><filter id={uid+"-front"} x="-25.4" y="-25.4" width="371.8" height="291.8" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
      <feFlood floodOpacity="0" result="BackgroundImageFix"/>
      <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/>
      <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
      <feOffset/><feGaussianBlur stdDeviation="2.65"/>
      <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1"/>
      <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.12 0"/>
      <feBlend in2="shape" result="innerShadow"/>
     </filter></defs>
    </svg>
   </motion.span>
  </span>
 </span>;
}
