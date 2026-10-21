// projectIcons.tsx
// 「项目」模块专用小图标。项目/db vs 一般 nav 图标。

export function ProjectsIcon({dash=false,className=""}:{dash?:boolean;className?:string}){
 return<svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
  <polyline points="14 2 14 8 20 8"/>
  {dash
   ? <path d="M8 13h8M8 17h8"/>
   : <path d="M9 13h6M9 17h6"/>}
 </svg>;
}