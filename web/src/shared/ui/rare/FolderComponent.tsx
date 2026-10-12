/* Adapted from Rare UI Folder Component (Swami Malode and contributors).
 * Original https://www.rareui.com/components/foldercomponent
 * Source https://github.com/swamimalode07/rare-ui/blob/main/components/ui/folder-component.tsx
 * License: MIT + Commons Clause; visible attribution is in project README.
 * Retains the tabbed backing, fanning paper cards and tilting front flap.
 * Here the icon never steals the parent folder row's click, drag or keyboard.
 */
import "./folderComponent.css";

type Props={open?:boolean;size?:number;className?:string};
// Original Rare UI outline, retained at its upstream proportions.
const FLAP="M0 25C0 11.1929 11.1929 0 25 0H136.084C143.044 0 149.689 2.90139 154.42 8.00608L178.08 33.5343C182.811 38.639 189.456 41.5404 196.416 41.5404H296C309.807 41.5404 321 52.7333 321 66.5404V216C321 229.807 309.807 241 296 241H25C11.1929 241 0 229.807 0 216V25Z";

export function RareFolderComponent({open=false,size=16,className=""}:Props){
 return <svg data-slot="rare-folder-component" data-folder-open={open?"true":"false"}
  data-folder-scale={size<28?"compact":"large"}
  className={"resource-folder-icon rare-folder-component"+(className?" "+className:"")}
  width={size} height={size} viewBox="0 0 321 290" fill="none"
  aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
  <path className="rare-folder-back" d={FLAP} transform="translate(0 35)"
   fill="var(--folder-fill,#F5BF43)" stroke="var(--folder-stroke,#AD7410)" strokeWidth="5"/>
  <g className="rare-folder-card rare-folder-card-left">
   <rect x="66" y="57" width="164" height="198" rx="18" fill="#FFF7E7" stroke="#CFB578" strokeWidth="3"/>
   <rect x="85" y="82" width="110" height="9" rx="4" fill="#E0C58A"/>
   <rect x="85" y="104" width="88" height="7" rx="3.5" fill="#EBDDAB"/>
   <rect x="85" y="124" width="101" height="7" rx="3.5" fill="#EBDDAB"/>
  </g>
  <g className="rare-folder-card rare-folder-card-middle">
   <rect x="82" y="44" width="164" height="210" rx="18" fill="#F8FAFD" stroke="#BECAD6" strokeWidth="3"/>
   <rect x="101" y="68" width="118" height="10" rx="4" fill="#CDD9E7"/>
   <rect x="101" y="91" width="102" height="7" rx="3.5" fill="#E0E7EF"/>
   <rect x="101" y="112" width="88" height="7" rx="3.5" fill="#E0E7EF"/>
  </g>
  <g className="rare-folder-card rare-folder-card-right">
   <rect x="96" y="52" width="164" height="204" rx="18" fill="#FFFEFB" stroke="#D1D9DF" strokeWidth="3"/>
   <rect x="116" y="78" width="115" height="10" rx="4" fill="#D7DFE4"/>
   <rect x="116" y="100" width="90" height="7" rx="3.5" fill="#E5EAEE"/>
  </g>
  <g className="rare-folder-front">
   <path d={FLAP} transform="translate(0 47)"
    fill="var(--folder-open-fill,#F9D47C)" stroke="var(--folder-stroke,#AD7410)" strokeWidth="4.5"/>
   <path d="M16 253H305" stroke="#FFEABB" strokeWidth="7" strokeLinecap="round" opacity=".72"/>
  </g>
 </svg>;
}
