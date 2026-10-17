import {getFileTypeInfo} from "../fileTypes";
import type {FileVisual} from "../fileTypes";

type Props={name?:string;size?:number;className?:string};
const office:Partial<Record<FileVisual,{accent:string;page:string;line:string;letter:string}>>={
 word:{accent:"#185ABD",page:"#DCEAFF",line:"#82A6E4",letter:"W"},
 sheet:{accent:"#107C41",page:"#DDF4E8",line:"#78B79A",letter:"X"},
 slide:{accent:"#C43E1C",page:"#FFE8D9",line:"#E3A084",letter:"P"},
};

// Office-like file silhouettes drawn locally, not copied third-party trademarks.
// Do not use currentColor: the color conveys the identity across every theme.
export function FileTypeIcon({name="",size=18,className=""}:Props){
 const {visual}=getFileTypeInfo(name);
 const o=office[visual];
 return <svg className={"resource-file-icon file-type-icon file-icon-"+visual+(className?" "+className:"")}
  data-file-visual={visual} width={size} height={size} viewBox="0 0 24 24"
  fill="none" aria-hidden="true" focusable="false">
  {o&&<>
   <path d="M6 2.5h9.5L21 8v12.5A1.5 1.5 0 0 1 19.5 22H6a2 2 0 0 1-2-2V4.5a2 2 0 0 1 2-2Z" fill={o.page} stroke={o.accent} strokeOpacity=".3" strokeWidth=".8"/>
   <path d="M15.5 2.5V8H21" fill="#FFF" fillOpacity=".75" stroke={o.accent} strokeOpacity=".3" strokeWidth=".8"/>
   {visual==="sheet"
    ?<g stroke={o.line} strokeWidth="1"><path d="M12 11.5h7M12 14.8h7M12 18.1h7M15.6 10v9.5"/></g>
    :visual==="slide"
     ?<><rect x="11.8" y="11.3" width="7" height="5.8" rx=".6" fill={o.line} fillOpacity=".6"/><path d="M13 18.8h5" stroke={o.line} strokeWidth=".9"/></>
     :<g stroke={o.line} strokeWidth="1.2" strokeLinecap="round"><path d="M12 11.5h7M12 14.8h7M12 18.1h5"/></g>}
   <rect x="1.5" y="7" width="12" height="13" rx="1.6" fill={o.accent}/>
   <path d="M10.5 7H12a1.5 1.5 0 0 1 1.5 1.5v10A1.5 1.5 0 0 1 12 20h-1.5Z" fill="#FFF" fillOpacity=".12"/>
   <text x="7.5" y="16.3" fontFamily="Arial,Helvetica,sans-serif" fontSize="10" fontWeight="800" fill="#FFF" textAnchor="middle">{o.letter}</text>
  </>}
  {visual==="pdf"&&<>
   <path d="M6 2.5h9.5L21 8v12.5a1.5 1.5 0 0 1-1.5 1.5H6a2 2 0 0 1-2-2V4.5a2 2 0 0 1 2-2Z" fill="#FFE9E8" stroke="#C62828" strokeOpacity=".35" strokeWidth=".8"/>
   <path d="M15.5 2.5V8H21" fill="#FFF9F9" stroke="#C62828" strokeOpacity=".38" strokeWidth=".8"/>
   <path d="M9 12h8M9 15h8M9 18h6" stroke="#EAA6A5" strokeWidth="1.2" strokeLinecap="round"/>
   <rect x="1.4" y="8" width="14" height="11.7" rx="1.5" fill="#DC302F"/>
   <text x="8.4" y="15.7" fontFamily="Arial,Helvetica,sans-serif" fontSize="6.2" fontWeight="800" fill="#FFF" textAnchor="middle">PDF</text>
  </>}
  {visual==="drawing"&&<>
   <rect x="3.1" y="2.8" width="17.8" height="18.4" rx="1.5" fill="#E7F3FE" stroke="#338FCB" strokeWidth="1"/>
   <path d="M6.1 6.2h11.8M6.1 17.8h11.8M7.2 5.2v13.6M16.8 5.2v13.6" stroke="#94C9E9" strokeWidth=".65" strokeDasharray="1 1"/>
   <path d="M7.8 14.8 11 8.7l5.2 3.1-3.2 3.8Z" stroke="#0879B9" strokeWidth="1.25" strokeLinejoin="round" fill="#B5DDF6"/>
   <path d="M10.7 9.1 13 15.3M5.7 19.4h12.6" stroke="#0879B9" strokeWidth=".8"/>
  </>}
  {visual==="solid"&&<>
   <path d="m12 2.7 9.1 5.2v9.6L12 22.4l-9.1-4.9V7.9Z" fill="#D5EEFF"/>
   <path d="M12 12.4 2.9 7.9 12 2.7l9.1 5.2Z" fill="#73BFED"/>
   <path d="M12 12.4v10l9.1-4.9V7.9Z" fill="#177BB9"/>
   <path d="M12 12.4v10l-9.1-4.9V7.9Z" fill="#A4D8F5"/>
   <path d="m12 2.7 9.1 5.2v9.6L12 22.4l-9.1-4.9V7.9ZM12 12.4l9.1-4.5M12 12.4 2.9 7.9M12 12.4v10" stroke="#17638F" strokeWidth="1" strokeLinejoin="round"/>
  </>}
  {visual==="mesh"&&<>
   <path d="m12 2.7 8.6 5v9.8l-8.6 5-8.6-5V7.7Z" fill="#E9E3FF" stroke="#6D58BC" strokeWidth="1"/>
   <path d="M12 2.7v19.8M3.4 7.7l17.2 9.8M20.6 7.7 3.4 17.5M3.4 7.7h17.2M3.4 17.5h17.2M12 2.7 3.4 17.5M12 2.7l8.6 14.8" stroke="#8874C7" strokeWidth=".85" strokeLinejoin="round"/>
   <circle cx="12" cy="12.6" r="1.4" fill="#7056BF"/>
  </>}
  {visual==="toolpath"&&<>
   <rect x="3" y="3" width="18" height="18" rx="2.3" fill="#FFF0D7" stroke="#E2A64C" strokeWidth=".9"/>
   <path d="M6 16.3h4.2V8.1h7.6M6 12h5.5m2.5 4.3h4" stroke="#C58119" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
   <circle cx="17.8" cy="8.1" r="1.8" fill="#E59A25"/><path d="m15.2 16.1 2.8 2.7 2.1-2.7" stroke="#9F5E0A" strokeWidth="1.2"/>
  </>}
  {visual==="image"&&<>
   <rect x="2.3" y="3.4" width="19.4" height="17.2" rx="2.7" fill="#DDF7F4" stroke="#2A9F9D" strokeWidth=".9"/>
   <circle cx="8" cy="8.7" r="2.25" fill="#F2BE62"/>
   <path d="m3.6 17.2 5.7-5.4 3.4 3.1 3.4-4.1 4.1 4.9v2.6a1.2 1.2 0 0 1-1.2 1.2H4.7a1.1 1.1 0 0 1-1.1-1.1Z" fill="#4CB5AB"/>
   <path d="m8.2 19.5 7.9-8.7 4.1 4.9v2.6a1.2 1.2 0 0 1-1.2 1.2Z" fill="#248E98" fillOpacity=".83"/>
  </>}
  {visual==="video"&&<>
   <rect x="2.2" y="4.3" width="19.6" height="15.4" rx="2.6" fill="#E9E3FF" stroke="#7155CE" strokeWidth="1"/>
   <path d="M4.6 4.3v15.4M19.4 4.3v15.4" stroke="#AE9BE7" strokeWidth="1.3" strokeDasharray="2.2 2"/>
   <path d="M10 8.6a.8.8 0 0 1 1.2-.7l5.6 3.4a.8.8 0 0 1 0 1.4l-5.6 3.4a.8.8 0 0 1-1.2-.7Z" fill="#7455D0"/>
  </>}
  {visual==="audio"&&<>
   <rect x="3" y="3" width="18" height="18" rx="4.5" fill="#E6E6FF" stroke="#7975D1" strokeWidth="1"/>
   <path d="M6 13v-2m3 5V8m3 11V5m3 11V8m3 5v-2" stroke="#6A64CC" strokeWidth="1.9" strokeLinecap="round"/>
  </>}
  {visual==="mindmap"&&<>
   <rect x="2.5" y="2.5" width="19" height="19" rx="4" fill="#EAF3FF" stroke="#89B6ED" strokeWidth=".9"/>
   <path d="M8 12h4m0 0 4-5m-4 5 4 5" stroke="#2773B8" strokeWidth="1.4" strokeLinecap="round"/>
   <circle cx="7" cy="12" r="2.4" fill="#186CD2"/>
   <rect x="14" y="4.3" width="6" height="5.3" rx="1.6" fill="#70ACE8"/>
   <rect x="14" y="14.4" width="6" height="5.3" rx="1.6" fill="#83C4B6"/>
  </>}
  {visual==="archive"&&<>
   <path d="M4.2 3h15.6v17.1c0 1-.8 1.9-1.8 1.9H6c-1 0-1.8-.9-1.8-1.9Z" fill="#F9DFAC" stroke="#C38C30" strokeWidth=".8"/>
   <path d="M4.2 3h15.6v4.7H4.2Z" fill="#E1A343"/>
   <path d="M10.5 3v11.8h3V3M10.5 5.5h3m-3 3h3m-3 3h3" stroke="#99611B" strokeWidth="1"/>
   <rect x="9.2" y="14.2" width="5.6" height="5.4" rx=".9" fill="#B57925"/><path d="M10.6 16.7h2.8" stroke="#FFF" strokeWidth="1.2"/>
  </>}
  {(["code","text","file","font"] as FileVisual[]).includes(visual)&&<>
   <path d="M5 2.5h10L20 7.6V20.5a1.5 1.5 0 0 1-1.5 1.5H5a2 2 0 0 1-2-2V4.5a2 2 0 0 1 2-2Z" fill={visual==="code"?"#DDF5EF":visual==="font"?"#E9E6FF":"#F0F2F5"} stroke={visual==="code"?"#2BA18B":visual==="font"?"#8772C8":"#A0AAB8"} strokeWidth=".85"/>
   <path d="M15 2.5v5.1h5" fill="#FFF" fillOpacity=".7" stroke={visual==="code"?"#2BA18B":"#A0AAB8"} strokeWidth=".75"/>
   {visual==="code"
    ?<path d="m9 11-3 3 3 3m6-6 3 3-3 3m-1-8-3.4 10" stroke="#1E8D79" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
    :visual==="font"
     ?<text x="11.6" y="17.3" fontFamily="Georgia,serif" fontSize="12" fontWeight="700" textAnchor="middle" fill="#7460AC">A</text>
     :<path d="M7 11h9M7 14.5h9M7 18h6" stroke={visual==="text"?"#778595":"#9AA6B3"} strokeWidth="1.2" strokeLinecap="round"/>}
  </>}
 </svg>;
}
