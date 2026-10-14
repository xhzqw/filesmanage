// Finder view preference and icons shared by document, favorite and share scopes.
export type ExplorerViewMode="icons"|"list"|"columns"|"gallery";
export const EXPLORER_VIEWS:{id:ExplorerViewMode;label:string}[]=[
 {id:"icons",label:"图标视图"}, {id:"list",label:"列表视图"},
 {id:"columns",label:"分栏视图"}, {id:"gallery",label:"画廊视图"}
];
const VIEW_KEY="filesmanage.explorer-view";
export function readExplorerViewMode():ExplorerViewMode{
 try{const value=localStorage.getItem(VIEW_KEY);
  if(EXPLORER_VIEWS.some(mode=>mode.id===value))return value as ExplorerViewMode;
 }catch{}
 return "list";
}
export function saveExplorerViewMode(mode:ExplorerViewMode){
 try{localStorage.setItem(VIEW_KEY,mode);}catch{}
}
export function ExplorerViewGlyph({mode}:{mode:ExplorerViewMode}){
 const common={width:16,height:16,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:1.8,strokeLinecap:"round" as const,strokeLinejoin:"round" as const,"aria-hidden":true as const};
 if(mode==="icons")return <svg {...common}><rect x="3" y="3" width="7" height="7" rx="1.3"/><rect x="14" y="3" width="7" height="7" rx="1.3"/><rect x="3" y="14" width="7" height="7" rx="1.3"/><rect x="14" y="14" width="7" height="7" rx="1.3"/></svg>;
 if(mode==="list")return <svg {...common}><path d="M9 5h12M9 12h12M9 19h12"/><path d="M3 5h2M3 12h2M3 19h2"/></svg>;
 if(mode==="columns")return <svg {...common}><rect x="2.5" y="3.5" width="19" height="17" rx="2"/><path d="M9 3.5v17M15.5 3.5v17"/></svg>;
 return <svg {...common}><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 16.5h18M8 20.5v-4M11 7h6M11 10h5"/></svg>;
}
